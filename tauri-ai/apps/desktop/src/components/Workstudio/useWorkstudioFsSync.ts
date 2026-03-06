import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type * as Monaco from 'monaco-editor';

type OpenFileLike = {
  id: string;
  title: string;
  path: string;
  kind: 'text' | 'image' | 'pdf' | 'binary' | 'markdown';
  mime: string;
  size: number;
  content?: string;
  originalContent?: string;
  dirty?: boolean;
  dataUrl?: string;
  base64?: string;
  externalChanged?: boolean;
  missingOnDisk?: boolean;
  lastKnownDiskMtimeMs?: number | null;
};

type LocalFileBase64 = {
  filename: string;
  mime: string;
  base64: string;
  size: number;
};

type LocalFileSnapshot = {
  path: string;
  exists: boolean;
  isFile: boolean;
  size?: number | null;
  modifiedMs?: number | null;
};

type WorkstudioFileDiskChangedPayload = {
  workstudioId: string;
  path: string;
  kind: 'create' | 'modify' | 'remove' | 'rename';
};

type UseWorkstudioFsSyncArgs = {
  workstudioId: string | null;
  rootFolders: string[];
  openFiles: OpenFileLike[];
  setOpenFiles: Dispatch<SetStateAction<OpenFileLike[]>>;
  monacoRef: MutableRefObject<typeof import('monaco-editor') | null>;
  editorByPaneRef: MutableRefObject<Map<string, Monaco.editor.IStandaloneCodeEditor>>;
  externalApplyPathsRef: MutableRefObject<Set<string>>;
  normalizeFsPath: (input: string) => string;
  toMonacoModelPath: (path: string) => string;
  decodeBase64ToUtf8: (base64: string) => string;
  fileKindFor: (path: string, mime: string) => OpenFileLike['kind'];
  isUntitledPath: (path: string) => boolean;
};

type UseWorkstudioFsSyncResult = {
  reloadOpenFileFromDisk: (path: string) => Promise<void>;
  keepLocalVersion: (fileId: string) => void;
  markPendingLocalWrite: (path: string) => void;
};

const LOCAL_WRITE_ECHO_MS = 1500;
const DISK_EVENT_DEBOUNCE_MS = 250;

const parentDirOf = (path: string): string | null => {
  const normalized = path.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return null;
  return normalized.slice(0, idx);
};

const isWithinRoot = (path: string, root: string): boolean => {
  const normalizedPath = path.toLowerCase();
  const normalizedRoot = root.toLowerCase();
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
};

const isLikelyNotFound = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  return lower.includes('os error 2') || lower.includes('no such file or directory') || lower.includes('not found');
};

export function useWorkstudioFsSync({
  workstudioId,
  rootFolders,
  openFiles,
  setOpenFiles,
  monacoRef,
  editorByPaneRef,
  externalApplyPathsRef,
  normalizeFsPath,
  toMonacoModelPath,
  decodeBase64ToUtf8,
  fileKindFor,
  isUntitledPath,
}: UseWorkstudioFsSyncArgs): UseWorkstudioFsSyncResult {
  const windowLabel = useMemo(() => {
    if (!isTauri()) return 'main';
    try {
      return getCurrentWebviewWindow().label;
    } catch {
      return 'main';
    }
  }, []);

  const pendingLocalWriteRef = useRef<Map<string, number>>(new Map());
  const processingPathsRef = useRef<Set<string>>(new Set());
  const queuedPathsRef = useRef<Set<string>>(new Set());
  const queueTimerRef = useRef<number | null>(null);
  const openFilesRef = useRef<OpenFileLike[]>(openFiles);
  const openPathsRef = useRef<string[]>([]);

  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  const openPaths = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const file of openFiles) {
      const normalized = normalizeFsPath(file.path);
      if (!normalized || isUntitledPath(normalized)) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }, [openFiles, isUntitledPath, normalizeFsPath]);

  const openPathsKey = useMemo(() => openPaths.join('|'), [openPaths]);

  useEffect(() => {
    openPathsRef.current = openPaths;
  }, [openPathsKey, openPaths]);

  const watchRoots = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const root of rootFolders) {
      const normalized = normalizeFsPath(root);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    for (const path of openPaths) {
      if (out.some((root) => isWithinRoot(path, root))) continue;
      const parent = parentDirOf(path);
      if (!parent || seen.has(parent)) continue;
      seen.add(parent);
      out.push(parent);
    }
    return out;
  }, [openPaths, rootFolders, normalizeFsPath]);

  const watchRootsKey = useMemo(() => watchRoots.join('|'), [watchRoots]);

  const prunePendingLocalWrites = useCallback(() => {
    const now = Date.now();
    for (const [path, ts] of pendingLocalWriteRef.current) {
      if (now - ts > LOCAL_WRITE_ECHO_MS) {
        pendingLocalWriteRef.current.delete(path);
      }
    }
  }, []);

  const markPendingLocalWrite = useCallback(
    (path: string) => {
      const normalized = normalizeFsPath(path);
      if (!normalized || isUntitledPath(normalized)) return;
      pendingLocalWriteRef.current.set(normalized, Date.now());
    },
    [isUntitledPath, normalizeFsPath]
  );

  const keepLocalVersion = useCallback((fileId: string) => {
    setOpenFiles((prev) =>
      prev.map((file) =>
        file.id === fileId
          ? {
            ...file,
            externalChanged: false,
          }
          : file
      )
    );
  }, [setOpenFiles]);

  const updateModelFromDisk = useCallback(
    (path: string, content: string) => {
      const monaco = monacoRef.current;
      if (!monaco) return;
      const normalizedPath = normalizeFsPath(path);
      if (!normalizedPath) return;

      let model: Monaco.editor.ITextModel | null = null;
      try {
        const uri = monaco.Uri.parse(toMonacoModelPath(normalizedPath));
        model = monaco.editor.getModel(uri);
      } catch {
        model = null;
      }
      if (!model) return;
      if (model.getValue() === content) return;

      const attachedEditors = Array.from(editorByPaneRef.current.values()).filter((editor) => {
        try {
          return editor.getModel()?.uri?.toString() === model?.uri.toString();
        } catch {
          return false;
        }
      });

      const viewStates = attachedEditors.map((editor) => ({ editor, viewState: editor.saveViewState() }));
      externalApplyPathsRef.current.add(normalizedPath);
      try {
        model.setValue(content);
        for (const { editor, viewState } of viewStates) {
          if (viewState) editor.restoreViewState(viewState);
        }
      } finally {
        window.setTimeout(() => {
          externalApplyPathsRef.current.delete(normalizedPath);
        }, 0);
      }
    },
    [editorByPaneRef, externalApplyPathsRef, monacoRef, normalizeFsPath, toMonacoModelPath]
  );

  const syncSnapshotMetadata = useCallback(
    (path: string, snapshot: LocalFileSnapshot) => {
      setOpenFiles((prev) =>
        prev.map((file) => {
          if (normalizeFsPath(file.path) !== path) return file;
          return {
            ...file,
            lastKnownDiskMtimeMs: snapshot.modifiedMs ?? null,
            missingOnDisk: !snapshot.exists || !snapshot.isFile,
          };
        })
      );
    },
    [normalizeFsPath, setOpenFiles]
  );

  const markExternalConflict = useCallback(
    (path: string, snapshot: LocalFileSnapshot) => {
      setOpenFiles((prev) =>
        prev.map((file) => {
          if (normalizeFsPath(file.path) !== path) return file;
          return {
            ...file,
            externalChanged: true,
            missingOnDisk: !snapshot.exists || !snapshot.isFile,
            lastKnownDiskMtimeMs: snapshot.modifiedMs ?? null,
          };
        })
      );
    },
    [normalizeFsPath, setOpenFiles]
  );

  const markMissingOnDisk = useCallback(
    (path: string, snapshot: LocalFileSnapshot, preserveLocalEdits: boolean) => {
      setOpenFiles((prev) =>
        prev.map((file) => {
          if (normalizeFsPath(file.path) !== path) return file;
          return {
            ...file,
            externalChanged: preserveLocalEdits || file.externalChanged,
            missingOnDisk: true,
            lastKnownDiskMtimeMs: snapshot.modifiedMs ?? null,
          };
        })
      );
    },
    [normalizeFsPath, setOpenFiles]
  );

  const reloadOpenFileFromDisk = useCallback(
    async (path: string, knownSnapshot?: LocalFileSnapshot | null) => {
      const normalizedPath = normalizeFsPath(path);
      if (!normalizedPath || isUntitledPath(normalizedPath)) return;
      if (processingPathsRef.current.has(normalizedPath)) return;

      processingPathsRef.current.add(normalizedPath);
      try {
        const file = await invoke<LocalFileBase64>('read_local_file_base64', { path: normalizedPath });
        let snapshot = knownSnapshot ?? null;
        if (!snapshot) {
          const [freshSnapshot] = await invoke<LocalFileSnapshot[]>('get_local_file_snapshots', {
            paths: [normalizedPath],
          }).catch(() => []);
          snapshot = freshSnapshot ?? null;
        }

        const current = openFilesRef.current.find((item) => normalizeFsPath(item.path) === normalizedPath) ?? null;
        const nextKind = current?.kind === 'markdown' ? 'markdown' : fileKindFor(normalizedPath, file.mime);
        const isTextLike = nextKind === 'text' || nextKind === 'markdown';
        const content = isTextLike ? decodeBase64ToUtf8(file.base64) : undefined;

        setOpenFiles((prev) =>
          prev.map((item) => {
            if (normalizeFsPath(item.path) !== normalizedPath) return item;
            return {
              ...item,
              kind: nextKind,
              mime: file.mime,
              size: file.size,
              content: isTextLike ? content : item.content,
              originalContent: isTextLike ? content : item.originalContent,
              dirty: false,
              dataUrl: nextKind === 'image' ? `data:${file.mime};base64,${file.base64}` : undefined,
              base64: file.base64,
              externalChanged: false,
              missingOnDisk: false,
              lastKnownDiskMtimeMs: snapshot?.modifiedMs ?? item.lastKnownDiskMtimeMs ?? null,
            };
          })
        );

        if (nextKind === 'text' && typeof content === 'string') {
          updateModelFromDisk(normalizedPath, content);
        }
      } catch (error) {
        if (isLikelyNotFound(error)) {
          markMissingOnDisk(
            normalizedPath,
            knownSnapshot ?? { path: normalizedPath, exists: false, isFile: false },
            false
          );
          return;
        }
        throw error;
      } finally {
        processingPathsRef.current.delete(normalizedPath);
      }
    },
    [
      decodeBase64ToUtf8,
      fileKindFor,
      isUntitledPath,
      markMissingOnDisk,
      normalizeFsPath,
      setOpenFiles,
      updateModelFromDisk,
    ]
  );

  const reconcilePathsFromDisk = useCallback(
    async (paths: string[], reason: 'seed' | 'focus' | 'event') => {
      const normalizedPaths = Array.from(
        new Set(paths.map((path) => normalizeFsPath(path)).filter((path) => path && !isUntitledPath(path)))
      );
      if (normalizedPaths.length === 0) return;

      prunePendingLocalWrites();
      const snapshots = await invoke<LocalFileSnapshot[]>('get_local_file_snapshots', {
        paths: normalizedPaths,
      }).catch(() => []);

      const snapshotMap = new Map(snapshots.map((snapshot) => [normalizeFsPath(snapshot.path), snapshot]));

      for (const normalizedPath of normalizedPaths) {
        const current = openFilesRef.current.find((file) => normalizeFsPath(file.path) === normalizedPath) ?? null;
        if (!current) continue;

        const snapshot = snapshotMap.get(normalizedPath) ?? {
          path: normalizedPath,
          exists: false,
          isFile: false,
          size: null,
          modifiedMs: null,
        };

        const localWriteTs = pendingLocalWriteRef.current.get(normalizedPath) ?? null;
        if (localWriteTs && Date.now() - localWriteTs <= LOCAL_WRITE_ECHO_MS) {
          pendingLocalWriteRef.current.delete(normalizedPath);
          syncSnapshotMetadata(normalizedPath, snapshot);
          continue;
        }

        if (!snapshot.exists || !snapshot.isFile) {
          markMissingOnDisk(normalizedPath, snapshot, Boolean(current.dirty));
          continue;
        }

        if (reason === 'seed' && current.lastKnownDiskMtimeMs == null) {
          syncSnapshotMetadata(normalizedPath, snapshot);
          continue;
        }

        const knownMtime = current.lastKnownDiskMtimeMs ?? null;
        const changed =
          reason === 'event' ||
          current.missingOnDisk ||
          knownMtime == null ||
          (snapshot.modifiedMs ?? null) !== knownMtime;

        if (!changed) {
          continue;
        }

        if (current.dirty) {
          markExternalConflict(normalizedPath, snapshot);
          continue;
        }

        await reloadOpenFileFromDisk(normalizedPath, snapshot);
      }
    },
    [
      isUntitledPath,
      markExternalConflict,
      markMissingOnDisk,
      normalizeFsPath,
      prunePendingLocalWrites,
      reloadOpenFileFromDisk,
      syncSnapshotMetadata,
    ]
  );

  const flushQueuedDiskEvents = useCallback(async () => {
    const paths = Array.from(queuedPathsRef.current);
    queuedPathsRef.current.clear();
    if (queueTimerRef.current) {
      window.clearTimeout(queueTimerRef.current);
      queueTimerRef.current = null;
    }
    if (paths.length === 0) return;
    await reconcilePathsFromDisk(paths, 'event');
  }, [reconcilePathsFromDisk]);

  useEffect(() => {
    if (!isTauri()) return;
    if (!workstudioId) return;

    void invoke('workstudio_fs_sync_watch', {
      windowLabel,
      workstudioId,
      roots: watchRoots,
      openPaths,
    }).catch(() => {});
  }, [openPathsKey, watchRootsKey, windowLabel, workstudioId]);

  useEffect(() => {
    if (!isTauri()) return;
    return () => {
      void invoke('workstudio_fs_unwatch', { windowLabel }).catch(() => {});
    };
  }, [windowLabel]);

  useEffect(() => {
    if (!isTauri()) return;
    if (!workstudioId) return;

    let unlisten: null | (() => void) = null;
    void listen<WorkstudioFileDiskChangedPayload>('workstudio:file_disk_changed', (event) => {
      const payload = event.payload;
      if (!payload) return;
      if (payload.workstudioId && payload.workstudioId !== workstudioId) return;
      const normalizedPath = normalizeFsPath(payload.path);
      if (!normalizedPath || isUntitledPath(normalizedPath)) return;
      queuedPathsRef.current.add(normalizedPath);
      if (queueTimerRef.current) {
        window.clearTimeout(queueTimerRef.current);
      }
      queueTimerRef.current = window.setTimeout(() => {
        void flushQueuedDiskEvents();
      }, DISK_EVENT_DEBOUNCE_MS);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      if (queueTimerRef.current) {
        window.clearTimeout(queueTimerRef.current);
        queueTimerRef.current = null;
      }
      unlisten?.();
    };
  }, [flushQueuedDiskEvents, isUntitledPath, normalizeFsPath, workstudioId]);

  useEffect(() => {
    if (!isTauri()) return;
    if (!workstudioId) return;
    if (openPaths.length === 0) return;
    void reconcilePathsFromDisk(openPathsRef.current, 'seed');
  }, [openPathsKey, reconcilePathsFromDisk, workstudioId]);

  useEffect(() => {
    if (!isTauri()) return;
    if (!workstudioId) return;

    const refresh = () => {
      void reconcilePathsFromDisk(openPathsRef.current, 'focus');
    };
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [openPathsKey, reconcilePathsFromDisk, workstudioId]);

  return {
    reloadOpenFileFromDisk: (path: string) => reloadOpenFileFromDisk(path),
    keepLocalVersion,
    markPendingLocalWrite,
  };
}

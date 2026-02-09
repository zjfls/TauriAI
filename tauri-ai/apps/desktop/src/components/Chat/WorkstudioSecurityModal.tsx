import React, { useEffect, useMemo, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Check, Plus, Trash2, X } from 'lucide-react';
import type { TrustedCommandConfig, Workstudio, WorkstudioSecurityConfig } from '../../types';

interface WorkstudioSecurityModalProps {
  isOpen: boolean;
  onClose: () => void;
  workstudio: Workstudio | null;
}

const parseLines = (text: string) =>
  text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);

const uniq = <T,>(items: T[]) => Array.from(new Set(items));

const DEFAULT_CONFIG: WorkstudioSecurityConfig = {
  writableRoots: [],
  trustedCommands: [],
};

export const WorkstudioSecurityModal: React.FC<WorkstudioSecurityModalProps> = ({
  isOpen,
  onClose,
  workstudio,
}) => {
  const workstudioId = workstudio?.id ?? null;
  const mainFolder = workstudio?.mainFolder ?? '';

  const fileHint = useMemo(() => {
    if (!mainFolder) return '';
    return `${mainFolder.replace(/\\/g, '/')}/.tauriai/security.json`;
  }, [mainFolder]);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [config, setConfig] = useState<WorkstudioSecurityConfig>(DEFAULT_CONFIG);
  const [newWritableRootsDraft, setNewWritableRootsDraft] = useState('');
  const [trustToolDraft, setTrustToolDraft] = useState('shell_command');
  const [trustCommandDraft, setTrustCommandDraft] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setSaved(false);
    setError(null);
    setNewWritableRootsDraft('');
    setTrustToolDraft('shell_command');
    setTrustCommandDraft('');
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (!workstudioId) return;
    if (!isTauri()) return;

    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await invoke<WorkstudioSecurityConfig>('get_workstudio_security_config', {
          workstudioId,
        });
        if (!cancelled) {
          setConfig({
            writableRoots: res?.writableRoots ?? [],
            trustedCommands: res?.trustedCommands ?? [],
          });
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setConfig(DEFAULT_CONFIG);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [isOpen, workstudioId]);

  const handleSave = async () => {
    if (!workstudioId) return;
    if (!isTauri()) return;

    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const payload: WorkstudioSecurityConfig = {
        writableRoots: uniq(config.writableRoots.map((r) => r.trim()).filter(Boolean)),
        trustedCommands: config.trustedCommands
          .map((t) => ({ tool: t.tool.trim(), command: t.command.trim() }))
          .filter((t) => t.tool && t.command),
      };
      await invoke('set_workstudio_security_config', { workstudioId, config: payload });
      setConfig(payload);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const addWritableRoots = () => {
    const roots = parseLines(newWritableRootsDraft);
    if (roots.length === 0) return;
    setConfig((prev) => ({
      ...prev,
      writableRoots: uniq([...(prev.writableRoots ?? []), ...roots]),
    }));
    setNewWritableRootsDraft('');
  };

  const removeWritableRoot = (root: string) => {
    setConfig((prev) => ({
      ...prev,
      writableRoots: (prev.writableRoots ?? []).filter((r) => r !== root),
    }));
  };

  const addTrustedCommand = () => {
    const tool = trustToolDraft.trim();
    const command = trustCommandDraft.trim();
    if (!tool || !command) return;

    setConfig((prev) => {
      const existing = prev.trustedCommands ?? [];
      const already = existing.some((t) => t.tool === tool && t.command === command);
      if (already) return prev;
      return { ...prev, trustedCommands: [...existing, { tool, command }] };
    });
    setTrustCommandDraft('');
  };

  const removeTrustedCommand = (index: number) => {
    setConfig((prev) => {
      const existing = prev.trustedCommands ?? [];
      return { ...prev, trustedCommands: existing.filter((_, i) => i !== index) };
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[85vh] overflow-auto rounded-xl bg-white dark:bg-gray-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Workstudio 安全配置</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 truncate" title={fileHint}>
              存储：<span className="font-mono">{fileHint || '(未绑定 workstudio)'}</span>
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              说明：与 Agent 安全策略叠加（OR），只要任一层允许即可。
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800" title="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {!workstudioId ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">未绑定 Workstudio</div>
          ) : loading ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">加载中…</div>
          ) : (
            <>
              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-300">
                  {error}
                </div>
              )}

              <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">额外可写目录</div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Workstudio 主目录与附加目录无需填写，已自动视为可写根目录。
                </p>

                <div className="mt-3 flex gap-2">
                  <input
                    value={newWritableRootsDraft}
                    onChange={(e) => setNewWritableRootsDraft(e.target.value)}
                    placeholder="例如：D:\\work\\extra 或 /opt/data（可多行）"
                    className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  />
                  <button
                    type="button"
                    onClick={addWritableRoots}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    disabled={!newWritableRootsDraft.trim()}
                    title="添加"
                  >
                    <Plus size={16} />
                    添加
                  </button>
                </div>

                <div className="mt-3 space-y-2">
                  {(config.writableRoots ?? []).length === 0 ? (
                    <div className="text-xs text-gray-500 dark:text-gray-400">暂无额外目录</div>
                  ) : (
                    (config.writableRoots ?? []).map((root) => (
                      <div
                        key={root}
                        className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-gray-800"
                      >
                        <span className="font-mono text-xs text-gray-800 dark:text-gray-100 truncate" title={root}>
                          {root}
                        </span>
                        <button
                          type="button"
                          className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                          onClick={() => removeWritableRoot(root)}
                          title="移除"
                        >
                          <Trash2 size={14} className="text-gray-500" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">信任命令（Trust）</div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  用于审批策略为 <span className="font-mono">untrusted</span>（UnlessTrusted）时的免确认白名单。
                </p>

                <div className="mt-3 flex flex-wrap gap-2">
                  <select
                    value={trustToolDraft}
                    onChange={(e) => setTrustToolDraft(e.target.value)}
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  >
                    <option value="shell_command">shell_command</option>
                    <option value="exec_command">exec_command</option>
                    <option value="exec_command_persistent">exec_command_persistent</option>
                  </select>
                  <input
                    value={trustCommandDraft}
                    onChange={(e) => setTrustCommandDraft(e.target.value)}
                    placeholder="完整命令（需与 tool 参数完全一致）"
                    className="flex-1 min-w-[220px] rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  />
                  <button
                    type="button"
                    onClick={addTrustedCommand}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    disabled={!trustToolDraft.trim() || !trustCommandDraft.trim()}
                    title="添加"
                  >
                    <Plus size={16} />
                    添加
                  </button>
                </div>

                <div className="mt-3 space-y-2">
                  {(config.trustedCommands ?? []).length === 0 ? (
                    <div className="text-xs text-gray-500 dark:text-gray-400">暂无信任命令</div>
                  ) : (
                    (config.trustedCommands ?? []).map((t: TrustedCommandConfig, idx: number) => (
                      <div
                        key={`${t.tool}:${t.command}:${idx}`}
                        className="flex items-start justify-between rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800"
                      >
                        <div className="min-w-0">
                          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">{t.tool}</div>
                          <div className="mt-0.5 text-xs text-gray-800 dark:text-gray-100 font-mono break-all">
                            {t.command}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="ml-3 p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                          onClick={() => removeTrustedCommand(idx)}
                          title="移除"
                        >
                          <Trash2 size={14} className="text-gray-500" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}

          <div className="flex items-center justify-end gap-2">
            {saved && (
              <span className="inline-flex items-center gap-1 text-sm text-green-600">
                <Check size={16} />
                已保存
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              关闭
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!workstudioId || loading || saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};


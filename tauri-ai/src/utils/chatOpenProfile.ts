export type ChatOpenProfile = {
  id: string;
  source: string;
  startMs: number;
  startIso: string;
  conversationId?: string;
  sessionId?: string;
  meta?: Record<string, unknown>;
  marks: Array<{
    name: string;
    atMs: number;
    deltaMs: number;
    meta?: Record<string, unknown>;
  }>;
  ended?: {
    name: string;
    atMs: number;
    totalMs: number;
  };
};

const LAST_PROFILE_STORAGE_KEY = 'tauri-ai:debug:last_chat_open_profile';
const ENABLE_STORAGE_KEY = 'tauri-ai:debug:profile_chat_open';

const nowMs = (): number => {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch {
    // ignore
  }
  return Date.now();
};

const isEnabled = (): boolean => {
  try {
    if (import.meta.env.DEV) return true;
  } catch {
    // ignore
  }
  try {
    return localStorage.getItem(ENABLE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

const getGlobalProfile = (): ChatOpenProfile | null => {
  return (globalThis as any).__TAURIAI_CHAT_OPEN_PROFILE__ ?? null;
};

const setGlobalProfile = (profile: ChatOpenProfile | null) => {
  if (profile) {
    (globalThis as any).__TAURIAI_CHAT_OPEN_PROFILE__ = profile;
  } else {
    try {
      delete (globalThis as any).__TAURIAI_CHAT_OPEN_PROFILE__;
    } catch {
      (globalThis as any).__TAURIAI_CHAT_OPEN_PROFILE__ = undefined;
    }
  }
};

const persistProfile = (profile: ChatOpenProfile) => {
  try {
    localStorage.setItem(LAST_PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // ignore
  }
};

const logProfile = (profile: ChatOpenProfile) => {
  const totalMs =
    profile.ended?.totalMs ?? (profile.marks.length ? profile.marks[profile.marks.length - 1].deltaMs : 0);
  const titleParts: string[] = ['[profile] 打开 ChatView'];
  if (profile.source) titleParts.push(`source=${profile.source}`);
  if (profile.conversationId) titleParts.push(`conversationId=${profile.conversationId}`);
  if (profile.sessionId) titleParts.push(`sessionId=${profile.sessionId}`);

  console.groupCollapsed(`${titleParts.join(' ')} ${totalMs.toFixed(1)}ms`);
  console.log('start:', { iso: profile.startIso, ms: profile.startMs });
  if (profile.meta) console.log('meta:', profile.meta);
  console.table(
    profile.marks.map((m) => ({
      mark: m.name,
      ms: Number(m.deltaMs.toFixed(1)),
      at: Number(m.atMs.toFixed(1)),
      meta: m.meta ? JSON.stringify(m.meta) : '',
    }))
  );
  if (profile.ended) {
    console.log('end:', {
      name: profile.ended.name,
      totalMs: Number(profile.ended.totalMs.toFixed(1)),
    });
  }
  console.groupEnd();
};

export const startChatOpenProfile = (params: {
  source: string;
  conversationId?: string;
  sessionId?: string;
  meta?: Record<string, unknown>;
}): string | null => {
  if (!isEnabled()) return null;

  const id = crypto.randomUUID();
  const startMsValue = nowMs();
  const profile: ChatOpenProfile = {
    id,
    source: params.source,
    startMs: startMsValue,
    startIso: new Date().toISOString(),
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    meta: params.meta,
    marks: [],
  };
  setGlobalProfile(profile);
  markChatOpenProfile('click:start', { profileId: id });
  return id;
};

export const getActiveChatOpenProfile = (): ChatOpenProfile | null => {
  const p = getGlobalProfile();
  if (!p || !isEnabled()) return null;
  return p;
};

export const setChatOpenProfileTarget = (target: { conversationId?: string; sessionId?: string }, profileId?: string) => {
  const profile = getGlobalProfile();
  if (!profile || !isEnabled()) return;
  if (profileId && profile.id !== profileId) return;
  setGlobalProfile({
    ...profile,
    conversationId: target.conversationId ?? profile.conversationId,
    sessionId: target.sessionId ?? profile.sessionId,
  });
};

export const markChatOpenProfile = (
  name: string,
  opts?: {
    profileId?: string;
    conversationId?: string;
    sessionId?: string;
    meta?: Record<string, unknown>;
  }
) => {
  const profile = getGlobalProfile();
  if (!profile || !isEnabled()) return;
  if (opts?.profileId && profile.id !== opts.profileId) return;
  if (opts?.conversationId && profile.conversationId && profile.conversationId !== opts.conversationId) return;
  if (opts?.sessionId && profile.sessionId && profile.sessionId !== opts.sessionId) return;
  if (profile.ended) return;

  const atMs = nowMs();
  const next: ChatOpenProfile = {
    ...profile,
    marks: [
      ...profile.marks,
      {
        name,
        atMs,
        deltaMs: atMs - profile.startMs,
        meta: opts?.meta,
      },
    ],
  };
  setGlobalProfile(next);
};

export const endChatOpenProfile = (
  name: string,
  opts?: { profileId?: string; conversationId?: string; sessionId?: string; meta?: Record<string, unknown> }
) => {
  const profile = getGlobalProfile();
  if (!profile || !isEnabled()) return;
  if (opts?.profileId && profile.id !== opts.profileId) return;
  if (opts?.conversationId && profile.conversationId && profile.conversationId !== opts.conversationId) return;
  if (opts?.sessionId && profile.sessionId && profile.sessionId !== opts.sessionId) return;
  if (profile.ended) return;

  if (opts?.meta) {
    markChatOpenProfile(`${name}:meta`, { ...opts, meta: opts.meta });
  }

  const atMs = nowMs();
  const next: ChatOpenProfile = {
    ...getGlobalProfile()!,
    ended: {
      name,
      atMs,
      totalMs: atMs - profile.startMs,
    },
  };
  setGlobalProfile(next);

  logProfile(next);
  persistProfile(next);
};

declare global {
  // eslint-disable-next-line no-var
  var __TAURIAI_CHAT_OPEN_PROFILE__: ChatOpenProfile | undefined;
}

export {};


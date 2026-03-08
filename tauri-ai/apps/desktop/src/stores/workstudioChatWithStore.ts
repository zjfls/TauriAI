import { create } from 'zustand';
import type { WorkstudioChatWithThread } from '../types';
import {
  deleteWorkstudioChatWithThread,
  findWorkstudioChatWithThread,
  getWorkstudioChatWithThreadByConversation,
  listWorkstudioChatWithThreadsForFile,
  saveWorkstudioChatWithThread,
  touchWorkstudioChatWithThreadForConversation,
  type FindWorkstudioChatWithThreadArgs,
  type WorkstudioChatWithFileKey,
} from '../services/codeIntelService';

type WorkstudioChatWithState = {
  threadsById: Record<string, WorkstudioChatWithThread>;
  threadIdByConversationId: Record<string, string>;
  upsertThread: (thread: WorkstudioChatWithThread) => WorkstudioChatWithThread;
  getThreadByConversationId: (conversationId: string | null | undefined) => WorkstudioChatWithThread | null;
  ensureThreadForConversation: (conversationId: string) => Promise<WorkstudioChatWithThread | null>;
  findThread: (args: FindWorkstudioChatWithThreadArgs) => Promise<WorkstudioChatWithThread | null>;
  saveThread: (thread: WorkstudioChatWithThread) => Promise<WorkstudioChatWithThread>;
  listThreadsForFile: (args: WorkstudioChatWithFileKey) => Promise<WorkstudioChatWithThread[]>;
  touchThreadForConversation: (conversationId: string, modelRef?: string) => Promise<WorkstudioChatWithThread | null>;
  removeThread: (threadId: string, workstudioId?: string) => Promise<void>;
};

const cacheThread = (
  state: WorkstudioChatWithState,
  thread: WorkstudioChatWithThread
): Pick<WorkstudioChatWithState, 'threadsById' | 'threadIdByConversationId'> => {
  const nextThreadsById = { ...state.threadsById, [thread.id]: thread };
  const nextThreadIdByConversationId = {
    ...state.threadIdByConversationId,
    [thread.conversationId]: thread.id,
  };
  return {
    threadsById: nextThreadsById,
    threadIdByConversationId: nextThreadIdByConversationId,
  };
};

export const useWorkstudioChatWithStore = create<WorkstudioChatWithState>((set, get) => ({
  threadsById: {},
  threadIdByConversationId: {},

  upsertThread: (thread) => {
    const normalizedConversationId = String(thread.conversationId ?? '').trim();
    if (!normalizedConversationId) return thread;
    set((state) => cacheThread(state, thread));
    return thread;
  },

  getThreadByConversationId: (conversationId) => {
    const normalizedConversationId = String(conversationId ?? '').trim();
    if (!normalizedConversationId) return null;
    const threadId = get().threadIdByConversationId[normalizedConversationId];
    return threadId ? get().threadsById[threadId] ?? null : null;
  },

  ensureThreadForConversation: async (conversationId) => {
    const normalizedConversationId = String(conversationId ?? '').trim();
    if (!normalizedConversationId) return null;
    const cached = get().getThreadByConversationId(normalizedConversationId);
    if (cached) return cached;
    const thread = await getWorkstudioChatWithThreadByConversation(normalizedConversationId);
    if (!thread) return null;
    get().upsertThread(thread);
    return thread;
  },

  findThread: async (args) => {
    const thread = await findWorkstudioChatWithThread(args);
    if (thread) get().upsertThread(thread);
    return thread;
  },

  saveThread: async (thread) => {
    const saved = await saveWorkstudioChatWithThread(thread);
    get().upsertThread(saved);
    return saved;
  },

  listThreadsForFile: async (args) => {
    const threads = await listWorkstudioChatWithThreadsForFile(args);
    if (threads.length > 0) {
      set((state) => {
        let nextState = state;
        for (const thread of threads) {
          nextState = { ...nextState, ...cacheThread(nextState, thread) };
        }
        return nextState;
      });
    }
    return threads;
  },

  touchThreadForConversation: async (conversationId, modelRef) => {
    const thread = await touchWorkstudioChatWithThreadForConversation({ conversationId, modelRef });
    if (thread) get().upsertThread(thread);
    return thread;
  },

  removeThread: async (threadId, workstudioId) => {
    const normalizedThreadId = String(threadId ?? '').trim();
    if (!normalizedThreadId) return;
    await deleteWorkstudioChatWithThread({ threadId: normalizedThreadId, workstudioId });
    set((state) => {
      const nextThreadsById = { ...state.threadsById };
      const removed = nextThreadsById[normalizedThreadId] ?? null;
      delete nextThreadsById[normalizedThreadId];
      const nextThreadIdByConversationId = { ...state.threadIdByConversationId };
      if (removed?.conversationId) {
        delete nextThreadIdByConversationId[removed.conversationId];
      }
      return {
        threadsById: nextThreadsById,
        threadIdByConversationId: nextThreadIdByConversationId,
      };
    });
  },
}));

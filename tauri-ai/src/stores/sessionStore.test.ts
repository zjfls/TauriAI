/**
 * SessionStore Property Tests
 * 
 * Property 1: Session State Isolation
 * Property 3: Session Persistence Round-Trip
 * Property 4: Event Routing Correctness
 * 
 * Validates: Requirements 1.2, 4.1-4.5, 5.1-5.4, 7.2-7.4
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { create } from 'zustand';
import type { AgentSession, Message, DebugInfo, TokenUsage, PersistedSession, PersistedSessionState } from '../types';

/**
 * Create a minimal test version of the SessionStore
 * This avoids the Tauri API dependencies while testing the core logic
 */
// Constants for persistence
const SESSION_STORAGE_KEY = 'tauri-ai:sessions:test';
const PERSISTENCE_VERSION = 1;

// Mock localStorage for testing
const mockStorage = new Map<string, string>();
const mockLocalStorage = {
  getItem: (key: string) => mockStorage.get(key) ?? null,
  setItem: (key: string, value: string) => mockStorage.set(key, value),
  removeItem: (key: string) => mockStorage.delete(key),
  clear: () => mockStorage.clear(),
};

interface TestSessionState {
  sessions: Map<string, AgentSession>;
  activeSessionId: string | null;

  getActiveSession: () => AgentSession | undefined;
  getSession: (sessionId: string) => AgentSession | undefined;
  getSessionByConversationId: (conversationId: string) => AgentSession | undefined;

  appendStreamingToken: (sessionId: string, token: string) => void;
  appendThinkingToken: (sessionId: string, token: string) => void;
  finalizeStreaming: (sessionId: string, fullContent: string, thinking?: string, debugInfo?: DebugInfo, usage?: TokenUsage, model?: string) => void;
  handleError: (sessionId: string, error: string, debugInfo?: DebugInfo) => void;
  setSessionModel: (sessionId: string, modelRef: string) => void;
  closeOtherSessions: (keepSessionId: string) => void;
  closeSessionsToLeft: (sessionId: string) => void;
  closeSessionsToRight: (sessionId: string) => void;

  // Persistence methods
  saveSessionState: () => void;
  restoreSessionState: (availableAgents: string[], defaultAgent: string) => void;
}

function createTestSessionStore() {
  return create<TestSessionState>((set, get) => ({
    sessions: new Map<string, AgentSession>(),
    activeSessionId: null,

    getActiveSession: () => {
      const { sessions, activeSessionId } = get();
      if (!activeSessionId) return undefined;
      return sessions.get(activeSessionId);
    },

    getSession: (sessionId: string) => {
      return get().sessions.get(sessionId);
    },

    getSessionByConversationId: (conversationId: string) => {
      const { sessions } = get();
      for (const session of sessions.values()) {
        if (session.conversationId === conversationId) {
          return session;
        }
      }
      return undefined;
    },


    appendStreamingToken: (sessionId: string, token: string) => {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(sessionId);
        if (session) {
          newSessions.set(sessionId, {
            ...session,
            streamingMessage: (session.streamingMessage || '') + token,
          });
        }
        return { sessions: newSessions };
      });
    },

    appendThinkingToken: (sessionId: string, token: string) => {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(sessionId);
        if (session) {
          newSessions.set(sessionId, {
            ...session,
            streamingThinking: (session.streamingThinking || '') + token,
          });
        }
        return { sessions: newSessions };
      });
    },

    finalizeStreaming: (sessionId: string, fullContent: string, thinking?: string, debugInfo?: DebugInfo, usage?: TokenUsage, model?: string) => {
      const session = get().sessions.get(sessionId);
      if (!session?.conversationId) return;

      const finalThinking = thinking || session.streamingThinking || undefined;

      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        conversationId: session.conversationId,
        role: 'assistant',
        content: fullContent,
        thinking: finalThinking,
        meta: model ? { model } : undefined,
        debugInfo,
        usage,
        createdAt: new Date().toISOString(),
      };

      set((state) => {
        const newSessions = new Map(state.sessions);
        const currentSession = newSessions.get(sessionId);
        if (currentSession) {
          newSessions.set(sessionId, {
            ...currentSession,
            messages: [...currentSession.messages, assistantMessage],
            streamingMessage: null,
            streamingThinking: null,
            isGenerating: false,
            lastActiveAt: new Date().toISOString(),
          });
        }
        return { sessions: newSessions };
      });
    },

    handleError: (sessionId: string, error: string, debugInfo?: DebugInfo) => {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const currentSession = newSessions.get(sessionId);
        if (currentSession) {
          const errorMessage: Message = {
            id: crypto.randomUUID(),
            conversationId: currentSession.conversationId || '',
            role: 'error',
            content: error,
            debugInfo,
            createdAt: new Date().toISOString(),
          };

          newSessions.set(sessionId, {
            ...currentSession,
            messages: [...currentSession.messages, errorMessage],
            error,
            isGenerating: false,
            streamingMessage: null,
            streamingThinking: null,
          });
        }
        return { sessions: newSessions };
      });
    },

    setSessionModel: (sessionId: string, modelRef: string) => {
      set((state) => {
        const newSessions = new Map(state.sessions);
        const session = newSessions.get(sessionId);
        if (session) {
          newSessions.set(sessionId, {
            ...session,
            modelRef,
          });
        }
        return { sessions: newSessions };
      });
    },

    /**
     * Close all sessions except the specified one
     * Requirements: 2.1, 2.2
     */
    closeOtherSessions: (keepSessionId: string) => {
      const { sessions } = get();
      
      // Check if the session to keep exists
      if (!sessions.has(keepSessionId)) return;

      // Create new sessions map with only the session to keep
      const newSessions = new Map<string, AgentSession>();
      const sessionToKeep = sessions.get(keepSessionId);
      if (sessionToKeep) {
        newSessions.set(keepSessionId, sessionToKeep);
      }

      // Update state: keep only the specified session and set it as active
      set({
        sessions: newSessions,
        activeSessionId: keepSessionId,
      });
    },

    /**
     * Close all sessions to the left of the specified session
     * Requirements: 3.1, 3.3
     */
    closeSessionsToLeft: (sessionId: string) => {
      const { sessions, activeSessionId } = get();
      
      // Check if the target session exists
      if (!sessions.has(sessionId)) return;

      // Convert sessions map to array to get indices
      const sessionArray = Array.from(sessions.entries());
      
      // Find the index of the target session
      const targetIndex = sessionArray.findIndex(([id]) => id === sessionId);
      if (targetIndex === -1) return;

      // If target is at index 0, there are no sessions to the left
      if (targetIndex === 0) return;

      // Create new sessions map excluding sessions to the left
      const newSessions = new Map<string, AgentSession>();
      for (let i = targetIndex; i < sessionArray.length; i++) {
        const [id, session] = sessionArray[i];
        newSessions.set(id, session);
      }

      // Determine new active session
      let newActiveId = activeSessionId;
      
      // If the active session was closed (it was to the left), update active session
      if (activeSessionId && !newSessions.has(activeSessionId)) {
        // Set the target session or the first remaining session as active
        newActiveId = sessionId;
      }

      // Update state
      set({
        sessions: newSessions,
        activeSessionId: newActiveId,
      });
    },

    /**
     * Close all sessions to the right of the specified session
     * Requirements: 4.1, 4.3
     */
    closeSessionsToRight: (sessionId: string) => {
      const { sessions, activeSessionId } = get();
      
      // Check if the target session exists
      if (!sessions.has(sessionId)) return;

      // Convert sessions map to array to get indices
      const sessionArray = Array.from(sessions.entries());
      
      // Find the index of the target session
      const targetIndex = sessionArray.findIndex(([id]) => id === sessionId);
      if (targetIndex === -1) return;

      // If target is at the last index, there are no sessions to the right
      if (targetIndex === sessionArray.length - 1) return;

      // Create new sessions map excluding sessions to the right
      const newSessions = new Map<string, AgentSession>();
      for (let i = 0; i <= targetIndex; i++) {
        const [id, session] = sessionArray[i];
        newSessions.set(id, session);
      }

      // Determine new active session
      let newActiveId = activeSessionId;
      
      // If the active session was closed (it was to the right), update active session
      if (activeSessionId && !newSessions.has(activeSessionId)) {
        // Set the target session or the first remaining session as active
        newActiveId = sessionId;
      }

      // Update state
      set({
        sessions: newSessions,
        activeSessionId: newActiveId,
      });
    },

    /**
     * Save session state to mock localStorage
     * Requirements: 5.1
     */
    saveSessionState: () => {
      const { sessions, activeSessionId } = get();

      const persistedSessions: PersistedSession[] = Array.from(sessions.values()).map(session => ({
        id: session.id,
        agentName: session.agentName,
        modelRef: session.modelRef,
        conversationId: session.conversationId,
        apiType: session.apiType,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
      }));

      const state: PersistedSessionState = {
        version: PERSISTENCE_VERSION,
        sessions: persistedSessions,
        activeSessionId,
      };

      mockLocalStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state));
    },

    /**
     * Restore session state from mock localStorage
     * Requirements: 5.2, 5.3, 5.4, 5.5
     */
    restoreSessionState: (availableAgents: string[], defaultAgent: string) => {
      const stored = mockLocalStorage.getItem(SESSION_STORAGE_KEY);
      if (!stored) return;

      const state: PersistedSessionState = JSON.parse(stored);

      // Version check
      if (state.version !== PERSISTENCE_VERSION) {
        return;
      }

      const newSessions = new Map<string, AgentSession>();

      for (const persisted of state.sessions) {
        // Validate agent exists, use default if not
        let agentName = persisted.agentName;
        if (!availableAgents.includes(agentName)) {
          agentName = defaultAgent;
        }

        const session: AgentSession = {
          id: persisted.id,
          agentName,
          title: '新对话',
          modelRef: persisted.modelRef,
          conversationId: persisted.conversationId,
          apiType: persisted.apiType,
          messages: [], // Messages would be loaded from backend in real implementation
          streamingMessage: null,
          streamingThinking: null,
          isGenerating: false,
          error: null,
          createdAt: persisted.createdAt,
          lastActiveAt: persisted.lastActiveAt,
        };

        newSessions.set(session.id, session);
      }

      // Validate active session ID
      let activeSessionId = state.activeSessionId;
      if (activeSessionId && !newSessions.has(activeSessionId)) {
        activeSessionId = newSessions.size > 0 ? Array.from(newSessions.keys())[0] : null;
      }

      set({
        sessions: newSessions,
        activeSessionId,
      });
    },
  }));
}


// Arbitrary generators for property tests
const agentNameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/);
const tokenArb = fc.string({ minLength: 1, maxLength: 50 });

// Create a fresh store for each test
let useTestStore: ReturnType<typeof createTestSessionStore>;

// Helper to reset store state
function resetStore() {
  useTestStore = createTestSessionStore();
  mockLocalStorage.clear();
}

// Helper to create a session directly in the store
function createTestSession(agentName: string, conversationId?: string): AgentSession {
  const now = new Date().toISOString();
  const session: AgentSession = {
    id: crypto.randomUUID(),
    agentName,
    title: '新对话',
    modelRef: 'test/model',
    conversationId: conversationId || `conv-${crypto.randomUUID()}`,
    apiType: null,
    messages: [],
    streamingMessage: null,
    streamingThinking: null,
    isGenerating: false,
    error: null,
    createdAt: now,
    lastActiveAt: now,
  };

  const state = useTestStore.getState();
  const newSessions = new Map(state.sessions);
  newSessions.set(session.id, session);
  useTestStore.setState({
    sessions: newSessions,
    activeSessionId: session.id,
  });

  return session;
}

describe('SessionStore Property Tests', () => {
  beforeEach(() => {
    resetStore();
  });


  /**
   * Feature: multi-agent-workspace, Property 1: Session State Isolation
   * 
   * *For any* two distinct sessions S1 and S2, modifying the state of S1 
   * (messages, streamingMessage, isGenerating, error) SHALL NOT affect the state of S2.
   * 
   * Validates: Requirements 1.2, 4.1, 4.2, 4.3, 4.4, 4.5
   */
  describe('Property 1: Session State Isolation', () => {
    it('modifying one session does not affect another session', () => {
      fc.assert(
        fc.property(
          agentNameArb,
          agentNameArb,
          tokenArb,
          fc.string({ minLength: 1, maxLength: 100 }),
          (agent1, agent2, token, errorMsg) => {
            resetStore();

            // Create two distinct sessions
            const session1 = createTestSession(agent1);
            const session2 = createTestSession(agent2);

            // Capture initial state of session2
            const initialSession2 = { ...useTestStore.getState().sessions.get(session2.id)! };

            // Modify session1: append streaming token
            useTestStore.getState().appendStreamingToken(session1.id, token);

            // Verify session2 is unchanged
            const currentSession2 = useTestStore.getState().sessions.get(session2.id)!;
            expect(currentSession2.streamingMessage).toBe(initialSession2.streamingMessage);
            expect(currentSession2.messages.length).toBe(initialSession2.messages.length);
            expect(currentSession2.isGenerating).toBe(initialSession2.isGenerating);
            expect(currentSession2.error).toBe(initialSession2.error);

            // Modify session1: handle error
            useTestStore.getState().handleError(session1.id, errorMsg);

            // Verify session2 is still unchanged
            const finalSession2 = useTestStore.getState().sessions.get(session2.id)!;
            expect(finalSession2.error).toBe(initialSession2.error);
            expect(finalSession2.messages.length).toBe(initialSession2.messages.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('streaming tokens are isolated between sessions', () => {
      fc.assert(
        fc.property(
          fc.array(tokenArb, { minLength: 1, maxLength: 10 }),
          fc.array(tokenArb, { minLength: 1, maxLength: 10 }),
          (tokens1, tokens2) => {
            resetStore();

            const session1 = createTestSession('agent1');
            const session2 = createTestSession('agent2');

            // Append tokens to session1
            tokens1.forEach(token => {
              useTestStore.getState().appendStreamingToken(session1.id, token);
            });

            // Append tokens to session2
            tokens2.forEach(token => {
              useTestStore.getState().appendStreamingToken(session2.id, token);
            });

            // Verify each session has only its own tokens
            const s1 = useTestStore.getState().sessions.get(session1.id)!;
            const s2 = useTestStore.getState().sessions.get(session2.id)!;

            expect(s1.streamingMessage).toBe(tokens1.join(''));
            expect(s2.streamingMessage).toBe(tokens2.join(''));
          }
        ),
        { numRuns: 100 }
      );
    });

    it('error handling is isolated between sessions', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          (error1, error2) => {
            resetStore();

            const session1 = createTestSession('agent1');
            const session2 = createTestSession('agent2');

            // Handle error in session1
            useTestStore.getState().handleError(session1.id, error1);

            // Verify session2 has no error
            const s2Before = useTestStore.getState().sessions.get(session2.id)!;
            expect(s2Before.error).toBeNull();

            // Handle error in session2
            useTestStore.getState().handleError(session2.id, error2);

            // Verify each session has its own error
            const s1 = useTestStore.getState().sessions.get(session1.id)!;
            const s2 = useTestStore.getState().sessions.get(session2.id)!;

            expect(s1.error).toBe(error1);
            expect(s2.error).toBe(error2);
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: multi-agent-workspace, Property 4: Event Routing Correctness
   * 
   * *For any* stream event with conversationId C, the event SHALL be routed 
   * to the session whose conversationId equals C, and no other session SHALL be affected.
   * 
   * Validates: Requirements 7.2, 7.3, 7.4, 7.5
   */
  describe('Property 4: Event Routing Correctness', () => {
    it('getSessionByConversationId returns correct session', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 2, maxLength: 5 }),
          (agentNames) => {
            resetStore();

            // Create sessions with unique conversation IDs
            const sessions = agentNames.map(name => createTestSession(name));

            // For each session, verify getSessionByConversationId returns it
            sessions.forEach(session => {
              const found = useTestStore.getState().getSessionByConversationId(session.conversationId!);
              expect(found).toBeDefined();
              expect(found!.id).toBe(session.id);
              expect(found!.conversationId).toBe(session.conversationId);
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    it('streaming tokens route to correct session by conversationId', () => {
      fc.assert(
        fc.property(
          tokenArb,
          (token) => {
            resetStore();

            // Create multiple sessions
            const session1 = createTestSession('agent1');
            const session2 = createTestSession('agent2');
            const session3 = createTestSession('agent3');

            // Simulate event routing: find session by conversationId and append token
            const targetSession = useTestStore.getState().getSessionByConversationId(session2.conversationId!);
            expect(targetSession).toBeDefined();

            useTestStore.getState().appendStreamingToken(targetSession!.id, token);

            // Verify only session2 received the token
            const s1 = useTestStore.getState().sessions.get(session1.id)!;
            const s2 = useTestStore.getState().sessions.get(session2.id)!;
            const s3 = useTestStore.getState().sessions.get(session3.id)!;

            expect(s1.streamingMessage).toBeNull();
            expect(s2.streamingMessage).toBe(token);
            expect(s3.streamingMessage).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('errors route to correct session by conversationId', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          (errorMsg) => {
            resetStore();

            // Create multiple sessions
            const session1 = createTestSession('agent1');
            const session2 = createTestSession('agent2');

            // Simulate error event routing
            const targetSession = useTestStore.getState().getSessionByConversationId(session1.conversationId!);
            expect(targetSession).toBeDefined();

            useTestStore.getState().handleError(targetSession!.id, errorMsg);

            // Verify only session1 has the error
            const s1 = useTestStore.getState().sessions.get(session1.id)!;
            const s2 = useTestStore.getState().sessions.get(session2.id)!;

            expect(s1.error).toBe(errorMsg);
            expect(s2.error).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('non-existent conversationId returns undefined', () => {
      fc.assert(
        fc.property(
          fc.uuid(),
          (randomConvId) => {
            resetStore();

            // Create a session with a different conversationId
            createTestSession('agent1');

            // Query with a random conversationId that doesn't exist
            const found = useTestStore.getState().getSessionByConversationId(randomConvId);

            // Should return undefined (unless by extreme coincidence the UUIDs match)
            const existingSession = Array.from(useTestStore.getState().sessions.values())[0];
            if (existingSession.conversationId !== randomConvId) {
              expect(found).toBeUndefined();
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('finalizeStreaming routes to correct session', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.option(fc.string({ minLength: 1, maxLength: 100 })),
          (content, thinking) => {
            resetStore();

            const session1 = createTestSession('agent1');
            const session2 = createTestSession('agent2');

            // Route finalize to session1
            const targetSession = useTestStore.getState().getSessionByConversationId(session1.conversationId!);
            useTestStore.getState().finalizeStreaming(
              targetSession!.id,
              content,
              thinking ?? undefined
            );

            // Verify only session1 has the new message
            const s1 = useTestStore.getState().sessions.get(session1.id)!;
            const s2 = useTestStore.getState().sessions.get(session2.id)!;

            expect(s1.messages.length).toBe(1);
            expect(s1.messages[0].content).toBe(content);
            expect(s1.messages[0].role).toBe('assistant');
            expect(s2.messages.length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: multi-agent-workspace, Property 3: Session Persistence Round-Trip
   * 
   * *For any* set of active sessions, saving then restoring the session state 
   * SHALL produce an equivalent set of sessions with the same agentName, modelRef, 
   * and conversationId.
   * 
   * Validates: Requirements 5.1, 5.2, 5.3, 5.4
   */
  describe('Property 3: Session Persistence Round-Trip', () => {
    it('save then restore preserves session identity', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 1, maxLength: 5 }),
          (agentNames) => {
            resetStore();

            // Create sessions
            const originalSessions = agentNames.map(name => createTestSession(name));
            const originalActiveId = useTestStore.getState().activeSessionId;

            // Capture original state
            const originalState = originalSessions.map(s => ({
              id: s.id,
              agentName: s.agentName,
              modelRef: s.modelRef,
              conversationId: s.conversationId,
              createdAt: s.createdAt,
              lastActiveAt: s.lastActiveAt,
            }));

            // Save state
            useTestStore.getState().saveSessionState();

            // Clear store
            useTestStore.setState({ sessions: new Map(), activeSessionId: null });

            // Restore state (all agents are available)
            const availableAgents = agentNames;
            useTestStore.getState().restoreSessionState(availableAgents, agentNames[0]);

            // Verify restored sessions match original
            const restoredSessions = useTestStore.getState().sessions;
            expect(restoredSessions.size).toBe(originalSessions.length);

            originalState.forEach(original => {
              const restored = restoredSessions.get(original.id);
              expect(restored).toBeDefined();
              expect(restored!.id).toBe(original.id);
              expect(restored!.agentName).toBe(original.agentName);
              expect(restored!.modelRef).toBe(original.modelRef);
              expect(restored!.conversationId).toBe(original.conversationId);
              expect(restored!.createdAt).toBe(original.createdAt);
              expect(restored!.lastActiveAt).toBe(original.lastActiveAt);
            });

            // Verify active session is preserved
            expect(useTestStore.getState().activeSessionId).toBe(originalActiveId);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('restore uses default agent when original agent is unavailable', () => {
      fc.assert(
        fc.property(
          agentNameArb,
          agentNameArb,
          (originalAgent, defaultAgent) => {
            // Skip if agents are the same
            fc.pre(originalAgent !== defaultAgent);

            resetStore();

            // Create session with original agent
            const session = createTestSession(originalAgent);

            // Save state
            useTestStore.getState().saveSessionState();

            // Clear store
            useTestStore.setState({ sessions: new Map(), activeSessionId: null });

            // Restore with original agent NOT available
            const availableAgents = [defaultAgent]; // Only default agent available
            useTestStore.getState().restoreSessionState(availableAgents, defaultAgent);

            // Verify session uses default agent
            const restored = useTestStore.getState().sessions.get(session.id);
            expect(restored).toBeDefined();
            expect(restored!.agentName).toBe(defaultAgent);
            // Other properties should be preserved
            expect(restored!.id).toBe(session.id);
            expect(restored!.modelRef).toBe(session.modelRef);
            expect(restored!.conversationId).toBe(session.conversationId);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('restore handles invalid active session ID', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 2, maxLength: 5 }),
          (agentNames) => {
            resetStore();

            // Create sessions
            agentNames.forEach(name => createTestSession(name));

            // Save state
            useTestStore.getState().saveSessionState();

            // Manually corrupt the stored state with invalid activeSessionId
            const stored = mockLocalStorage.getItem(SESSION_STORAGE_KEY);
            const state = JSON.parse(stored!);
            state.activeSessionId = 'invalid-session-id';
            mockLocalStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state));

            // Clear store
            useTestStore.setState({ sessions: new Map(), activeSessionId: null });

            // Restore state
            useTestStore.getState().restoreSessionState(agentNames, agentNames[0]);

            // Verify active session is set to first available session
            const activeId = useTestStore.getState().activeSessionId;
            expect(activeId).not.toBe('invalid-session-id');
            expect(useTestStore.getState().sessions.has(activeId!)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('restore preserves modelRef independently', () => {
      fc.assert(
        fc.property(
          agentNameArb,
          fc.string({ minLength: 1, maxLength: 30 }),
          fc.string({ minLength: 1, maxLength: 30 }),
          (agentName, model1, model2) => {
            resetStore();

            // Create two sessions with different models
            const session1 = createTestSession(agentName);
            useTestStore.getState().setSessionModel(session1.id, model1);

            const session2 = createTestSession(agentName);
            useTestStore.getState().setSessionModel(session2.id, model2);

            // Save state
            useTestStore.getState().saveSessionState();

            // Clear store
            useTestStore.setState({ sessions: new Map(), activeSessionId: null });

            // Restore state
            useTestStore.getState().restoreSessionState([agentName], agentName);

            // Verify each session has its own model
            const restored1 = useTestStore.getState().sessions.get(session1.id);
            const restored2 = useTestStore.getState().sessions.get(session2.id);

            expect(restored1!.modelRef).toBe(model1);
            expect(restored2!.modelRef).toBe(model2);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('empty storage results in no sessions restored', () => {
      resetStore();

      // Don't save anything, just try to restore
      useTestStore.getState().restoreSessionState(['agent1'], 'agent1');

      // Verify no sessions were created
      expect(useTestStore.getState().sessions.size).toBe(0);
      expect(useTestStore.getState().activeSessionId).toBeNull();
    });
  });


  /**
   * Feature: session-tab-context-menu, Property 4: 关闭其他标签页保留目标
   * 
   * *For any* session list with multiple sessions and any target session,
   * executing "close others" operation SHALL result in only the target session
   * remaining, and the target session SHALL become the active session.
   * 
   * **Validates: Requirements 2.1, 2.2**
   */
  describe('Property 4: Close Other Sessions Preserves Target', () => {
    it('closeOtherSessions keeps only target session and makes it active', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 2, maxLength: 10 }),
          fc.integer({ min: 0, max: 9 }),
          (agentNames, targetIndex) => {
            // Ensure target index is within bounds
            fc.pre(targetIndex < agentNames.length);

            resetStore();

            // Create multiple sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const targetSession = sessions[targetIndex];

            // Record initial state
            const initialSessionCount = useTestStore.getState().sessions.size;
            expect(initialSessionCount).toBe(agentNames.length);

            // Execute closeOtherSessions
            useTestStore.getState().closeOtherSessions(targetSession.id);

            // Verify only target session remains
            const finalSessions = useTestStore.getState().sessions;
            expect(finalSessions.size).toBe(1);
            expect(finalSessions.has(targetSession.id)).toBe(true);

            // Verify target session is active
            const activeSessionId = useTestStore.getState().activeSessionId;
            expect(activeSessionId).toBe(targetSession.id);

            // Verify target session properties are preserved
            const remainingSession = finalSessions.get(targetSession.id)!;
            expect(remainingSession.agentName).toBe(targetSession.agentName);
            expect(remainingSession.conversationId).toBe(targetSession.conversationId);
            expect(remainingSession.modelRef).toBe(targetSession.modelRef);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeOtherSessions with non-existent session does nothing', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 1, maxLength: 5 }),
          fc.uuid(),
          (agentNames, fakeSessionId) => {
            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const initialSessionCount = sessions.length;

            // Ensure fake ID doesn't match any real session
            fc.pre(!sessions.some(s => s.id === fakeSessionId));

            // Try to close others with non-existent session
            useTestStore.getState().closeOtherSessions(fakeSessionId);

            // Verify all sessions remain unchanged
            expect(useTestStore.getState().sessions.size).toBe(initialSessionCount);
            sessions.forEach(session => {
              expect(useTestStore.getState().sessions.has(session.id)).toBe(true);
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeOtherSessions preserves target session state', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 2, maxLength: 5 }),
          fc.integer({ min: 0, max: 4 }),
          fc.array(tokenArb, { minLength: 1, maxLength: 5 }),
          (agentNames, targetIndex, tokens) => {
            fc.pre(targetIndex < agentNames.length);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const targetSession = sessions[targetIndex];

            // Modify target session state with streaming tokens
            tokens.forEach(token => {
              useTestStore.getState().appendStreamingToken(targetSession.id, token);
            });

            const expectedStreamingMessage = tokens.join('');

            // Close other sessions
            useTestStore.getState().closeOtherSessions(targetSession.id);

            // Verify target session state is preserved
            const remainingSession = useTestStore.getState().sessions.get(targetSession.id)!;
            expect(remainingSession.streamingMessage).toBe(expectedStreamingMessage);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeOtherSessions preserves target session error state', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 2, maxLength: 5 }),
          fc.integer({ min: 0, max: 4 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          (agentNames, targetIndex, errorMsg) => {
            fc.pre(targetIndex < agentNames.length);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const targetSession = sessions[targetIndex];

            // Set error state on target session
            useTestStore.getState().handleError(targetSession.id, errorMsg);

            // Close other sessions
            useTestStore.getState().closeOtherSessions(targetSession.id);

            // Verify target session error is preserved
            const remainingSession = useTestStore.getState().sessions.get(targetSession.id)!;
            expect(remainingSession.error).toBe(errorMsg);
            // When error occurs, streamingMessage should be null
            expect(remainingSession.streamingMessage).toBeNull();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeOtherSessions works with exactly 2 sessions', () => {
      fc.assert(
        fc.property(
          agentNameArb,
          agentNameArb,
          fc.boolean(),
          (agent1, agent2, keepFirst) => {
            resetStore();

            // Create exactly 2 sessions
            const session1 = createTestSession(agent1);
            const session2 = createTestSession(agent2);

            const targetSession = keepFirst ? session1 : session2;
            const otherSession = keepFirst ? session2 : session1;

            // Close others
            useTestStore.getState().closeOtherSessions(targetSession.id);

            // Verify only target remains
            expect(useTestStore.getState().sessions.size).toBe(1);
            expect(useTestStore.getState().sessions.has(targetSession.id)).toBe(true);
            expect(useTestStore.getState().sessions.has(otherSession.id)).toBe(false);
            expect(useTestStore.getState().activeSessionId).toBe(targetSession.id);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeOtherSessions with single session keeps it', () => {
      fc.assert(
        fc.property(
          agentNameArb,
          (agentName) => {
            resetStore();

            // Create single session
            const session = createTestSession(agentName);

            // Close others (should do nothing)
            useTestStore.getState().closeOtherSessions(session.id);

            // Verify session remains
            expect(useTestStore.getState().sessions.size).toBe(1);
            expect(useTestStore.getState().sessions.has(session.id)).toBe(true);
            expect(useTestStore.getState().activeSessionId).toBe(session.id);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeOtherSessions removes all other sessions regardless of position', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 0, max: 9 }),
          (agentNames, targetIndex) => {
            fc.pre(targetIndex < agentNames.length);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const targetSession = sessions[targetIndex];

            // Record which sessions should be removed
            const sessionsToRemove = sessions.filter(s => s.id !== targetSession.id);

            // Close others
            useTestStore.getState().closeOtherSessions(targetSession.id);

            // Verify all other sessions are removed
            sessionsToRemove.forEach(session => {
              expect(useTestStore.getState().sessions.has(session.id)).toBe(false);
            });

            // Verify only target remains
            expect(useTestStore.getState().sessions.size).toBe(1);
            expect(useTestStore.getState().sessions.has(targetSession.id)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeOtherSessions updates active session even if target was not active', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 5 }),
          fc.integer({ min: 0, max: 4 }),
          fc.integer({ min: 0, max: 4 }),
          (agentNames, activeIndex, targetIndex) => {
            fc.pre(activeIndex < agentNames.length);
            fc.pre(targetIndex < agentNames.length);
            fc.pre(activeIndex !== targetIndex); // Ensure they're different

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set a different session as active
            useTestStore.setState({ activeSessionId: sessions[activeIndex].id });
            
            const targetSession = sessions[targetIndex];

            // Close others
            useTestStore.getState().closeOtherSessions(targetSession.id);

            // Verify target is now active (even though it wasn't before)
            expect(useTestStore.getState().activeSessionId).toBe(targetSession.id);
            expect(useTestStore.getState().sessions.size).toBe(1);
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: session-tab-context-menu, Property 5: 关闭左侧标签页
   * 
   * *For any* session list and any target session index, executing "close left"
   * operation SHALL remove all sessions with index less than target index,
   * and SHALL preserve the target session and all sessions to its right.
   * 
   * **Validates: Requirements 3.1**
   */
  describe('Property 5: Close Sessions To Left', () => {
    it('closeSessionsToLeft removes left sessions and preserves right sessions', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 2, maxLength: 10 }),
          fc.integer({ min: 0, max: 9 }),
          (agentNames, targetIndex) => {
            // Ensure target index is within bounds
            fc.pre(targetIndex < agentNames.length);

            resetStore();

            // Create multiple sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const targetSession = sessions[targetIndex];

            // Record sessions that should be removed (left side)
            const sessionsToRemove = sessions.slice(0, targetIndex);
            // Record sessions that should remain (target and right side)
            const sessionsToKeep = sessions.slice(targetIndex);

            // Execute closeSessionsToLeft
            useTestStore.getState().closeSessionsToLeft(targetSession.id);

            // Verify left sessions are removed
            sessionsToRemove.forEach(session => {
              expect(useTestStore.getState().sessions.has(session.id)).toBe(false);
            });

            // Verify target and right sessions are preserved
            sessionsToKeep.forEach(session => {
              expect(useTestStore.getState().sessions.has(session.id)).toBe(true);
            });

            // Verify correct number of sessions remain
            expect(useTestStore.getState().sessions.size).toBe(sessionsToKeep.length);

            // Verify target session properties are preserved
            const remainingTargetSession = useTestStore.getState().sessions.get(targetSession.id)!;
            expect(remainingTargetSession.agentName).toBe(targetSession.agentName);
            expect(remainingTargetSession.conversationId).toBe(targetSession.conversationId);
            expect(remainingTargetSession.modelRef).toBe(targetSession.modelRef);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToLeft at index 0 does nothing', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 1, maxLength: 10 }),
          (agentNames) => {
            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const firstSession = sessions[0];
            const initialSessionCount = sessions.length;

            // Try to close left sessions of the first session (should do nothing)
            useTestStore.getState().closeSessionsToLeft(firstSession.id);

            // Verify all sessions remain
            expect(useTestStore.getState().sessions.size).toBe(initialSessionCount);
            sessions.forEach(session => {
              expect(useTestStore.getState().sessions.has(session.id)).toBe(true);
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToLeft with non-existent session does nothing', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 1, maxLength: 5 }),
          fc.uuid(),
          (agentNames, fakeSessionId) => {
            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const initialSessionCount = sessions.length;

            // Ensure fake ID doesn't match any real session
            fc.pre(!sessions.some(s => s.id === fakeSessionId));

            // Try to close left with non-existent session
            useTestStore.getState().closeSessionsToLeft(fakeSessionId);

            // Verify all sessions remain unchanged
            expect(useTestStore.getState().sessions.size).toBe(initialSessionCount);
            sessions.forEach(session => {
              expect(useTestStore.getState().sessions.has(session.id)).toBe(true);
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToLeft preserves active session if not in left range', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 1, max: 9 }),
          fc.integer({ min: 1, max: 9 }),
          (agentNames, activeIndex, targetIndex) => {
            // Ensure indices are within bounds and active is at or right of target
            fc.pre(activeIndex < agentNames.length);
            fc.pre(targetIndex < agentNames.length);
            fc.pre(activeIndex >= targetIndex); // Active is not in left range

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session
            useTestStore.setState({ activeSessionId: sessions[activeIndex].id });
            const initialActiveId = sessions[activeIndex].id;

            // Close left sessions
            useTestStore.getState().closeSessionsToLeft(sessions[targetIndex].id);

            // Verify active session is preserved (since it's not in left range)
            expect(useTestStore.getState().activeSessionId).toBe(initialActiveId);
            expect(useTestStore.getState().sessions.has(initialActiveId)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToLeft updates active session if it was in left range', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 0, max: 8 }),
          fc.integer({ min: 1, max: 9 }),
          (agentNames, activeIndex, targetIndex) => {
            // Ensure indices are within bounds and active is left of target
            fc.pre(activeIndex < agentNames.length);
            fc.pre(targetIndex < agentNames.length);
            fc.pre(activeIndex < targetIndex); // Active is in left range

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session to one that will be closed
            useTestStore.setState({ activeSessionId: sessions[activeIndex].id });

            // Close left sessions
            useTestStore.getState().closeSessionsToLeft(sessions[targetIndex].id);

            // Verify active session was updated to target session
            expect(useTestStore.getState().activeSessionId).toBe(sessions[targetIndex].id);
            expect(useTestStore.getState().sessions.has(sessions[targetIndex].id)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToLeft preserves session state of remaining sessions', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 1, max: 9 }),
          fc.array(tokenArb, { minLength: 1, maxLength: 5 }),
          (agentNames, targetIndex, tokens) => {
            fc.pre(targetIndex < agentNames.length);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const targetSession = sessions[targetIndex];

            // Modify target session state with streaming tokens
            tokens.forEach(token => {
              useTestStore.getState().appendStreamingToken(targetSession.id, token);
            });

            const expectedStreamingMessage = tokens.join('');

            // Close left sessions
            useTestStore.getState().closeSessionsToLeft(targetSession.id);

            // Verify target session state is preserved
            const remainingSession = useTestStore.getState().sessions.get(targetSession.id)!;
            expect(remainingSession.streamingMessage).toBe(expectedStreamingMessage);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToLeft at last index keeps only last session', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 2, maxLength: 10 }),
          (agentNames) => {
            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const lastSession = sessions[sessions.length - 1];

            // Close left sessions of last session
            useTestStore.getState().closeSessionsToLeft(lastSession.id);

            // Verify only last session remains
            expect(useTestStore.getState().sessions.size).toBe(1);
            expect(useTestStore.getState().sessions.has(lastSession.id)).toBe(true);

            // Verify all other sessions are removed
            for (let i = 0; i < sessions.length - 1; i++) {
              expect(useTestStore.getState().sessions.has(sessions[i].id)).toBe(false);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToLeft maintains order of remaining sessions', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 1, max: 9 }),
          (agentNames, targetIndex) => {
            fc.pre(targetIndex < agentNames.length);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const targetSession = sessions[targetIndex];

            // Record expected remaining sessions in order
            const expectedRemaining = sessions.slice(targetIndex);

            // Close left sessions
            useTestStore.getState().closeSessionsToLeft(targetSession.id);

            // Get remaining sessions in order
            const remainingSessions = Array.from(useTestStore.getState().sessions.values());

            // Verify order is maintained
            expect(remainingSessions.length).toBe(expectedRemaining.length);
            expectedRemaining.forEach((expectedSession, index) => {
              const actualSession = remainingSessions.find(s => s.id === expectedSession.id);
              expect(actualSession).toBeDefined();
              expect(actualSession!.agentName).toBe(expectedSession.agentName);
            });
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: multi-agent-workspace, Property 5: Model Independence
   * 
   * *For any* session S with model M, changing the model of another session S' 
   * SHALL NOT change the model of S.
   * 
   * Validates: Requirements 6.1, 6.2
   */
  describe('Property 5: Model Independence', () => {
    it('changing model of one session does not affect other sessions', () => {
      fc.assert(
        fc.property(
          agentNameArb,
          agentNameArb,
          fc.string({ minLength: 1, maxLength: 30 }),
          fc.string({ minLength: 1, maxLength: 30 }),
          fc.string({ minLength: 1, maxLength: 30 }),
          (agent1, agent2, initialModel, newModel1, newModel2) => {
            resetStore();

            // Create two sessions
            const session1 = createTestSession(agent1);
            const session2 = createTestSession(agent2);

            // Set initial models
            useTestStore.getState().setSessionModel(session1.id, initialModel);
            useTestStore.getState().setSessionModel(session2.id, initialModel);

            // Verify both have the initial model
            expect(useTestStore.getState().sessions.get(session1.id)!.modelRef).toBe(initialModel);
            expect(useTestStore.getState().sessions.get(session2.id)!.modelRef).toBe(initialModel);

            // Change model of session1 only
            useTestStore.getState().setSessionModel(session1.id, newModel1);

            // Verify session1 has new model, session2 unchanged
            expect(useTestStore.getState().sessions.get(session1.id)!.modelRef).toBe(newModel1);
            expect(useTestStore.getState().sessions.get(session2.id)!.modelRef).toBe(initialModel);

            // Change model of session2
            useTestStore.getState().setSessionModel(session2.id, newModel2);

            // Verify each session has its own model
            expect(useTestStore.getState().sessions.get(session1.id)!.modelRef).toBe(newModel1);
            expect(useTestStore.getState().sessions.get(session2.id)!.modelRef).toBe(newModel2);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('model changes are isolated across multiple sessions', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 2, maxLength: 5 }),
          fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 2, maxLength: 5 }),
          (agentNames, models) => {
            // Ensure we have enough models for all agents
            fc.pre(models.length >= agentNames.length);

            resetStore();

            // Create sessions for each agent
            const sessions = agentNames.map(name => createTestSession(name));

            // Set unique model for each session
            sessions.forEach((session, index) => {
              useTestStore.getState().setSessionModel(session.id, models[index]);
            });

            // Verify each session has its assigned model
            sessions.forEach((session, index) => {
              const currentSession = useTestStore.getState().sessions.get(session.id)!;
              expect(currentSession.modelRef).toBe(models[index]);
            });

            // Change model of first session
            const newModel = 'completely-new-model';
            useTestStore.getState().setSessionModel(sessions[0].id, newModel);

            // Verify only first session changed, others unchanged
            expect(useTestStore.getState().sessions.get(sessions[0].id)!.modelRef).toBe(newModel);
            for (let i = 1; i < sessions.length; i++) {
              expect(useTestStore.getState().sessions.get(sessions[i].id)!.modelRef).toBe(models[i]);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('setSessionModel on non-existent session does not affect existing sessions', () => {
      fc.assert(
        fc.property(
          agentNameArb,
          fc.string({ minLength: 1, maxLength: 30 }),
          fc.string({ minLength: 1, maxLength: 30 }),
          fc.uuid(),
          (agentName, initialModel, newModel, fakeSessionId) => {
            resetStore();

            // Create a session
            const session = createTestSession(agentName);
            useTestStore.getState().setSessionModel(session.id, initialModel);

            // Try to set model on non-existent session
            useTestStore.getState().setSessionModel(fakeSessionId, newModel);

            // Verify existing session is unchanged
            expect(useTestStore.getState().sessions.get(session.id)!.modelRef).toBe(initialModel);

            // Verify no new session was created
            expect(useTestStore.getState().sessions.size).toBe(1);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('model changes take effect immediately for the session', () => {
      fc.assert(
        fc.property(
          agentNameArb,
          fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 2, maxLength: 10 }),
          (agentName, modelSequence) => {
            resetStore();

            const session = createTestSession(agentName);

            // Apply each model in sequence and verify immediate effect
            modelSequence.forEach(model => {
              useTestStore.getState().setSessionModel(session.id, model);
              expect(useTestStore.getState().sessions.get(session.id)!.modelRef).toBe(model);
            });

            // Final model should be the last one in sequence
            expect(useTestStore.getState().sessions.get(session.id)!.modelRef).toBe(modelSequence[modelSequence.length - 1]);
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: session-tab-context-menu, Property 6: 关闭右侧标签页
   * 
   * *For any* session list and any target session index, executing "close right"
   * operation SHALL remove all sessions with index greater than target index,
   * and SHALL preserve the target session and all sessions to its left.
   * 
   * **Validates: Requirements 4.1**
   */
  describe('Property 6: Close Sessions To Right', () => {
    it('closeSessionsToRight removes right sessions and preserves left sessions', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 2, maxLength: 10 }),
          fc.integer({ min: 0, max: 9 }),
          (agentNames, targetIndex) => {
            // Ensure target index is within bounds
            fc.pre(targetIndex < agentNames.length);

            resetStore();

            // Create multiple sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const targetSession = sessions[targetIndex];

            // Record sessions that should be removed (right side)
            const sessionsToRemove = sessions.slice(targetIndex + 1);
            // Record sessions that should remain (left side and target)
            const sessionsToKeep = sessions.slice(0, targetIndex + 1);

            // Execute closeSessionsToRight
            useTestStore.getState().closeSessionsToRight(targetSession.id);

            // Verify right sessions are removed
            sessionsToRemove.forEach(session => {
              expect(useTestStore.getState().sessions.has(session.id)).toBe(false);
            });

            // Verify target and left sessions are preserved
            sessionsToKeep.forEach(session => {
              expect(useTestStore.getState().sessions.has(session.id)).toBe(true);
            });

            // Verify correct number of sessions remain
            expect(useTestStore.getState().sessions.size).toBe(sessionsToKeep.length);

            // Verify target session properties are preserved
            const remainingTargetSession = useTestStore.getState().sessions.get(targetSession.id)!;
            expect(remainingTargetSession.agentName).toBe(targetSession.agentName);
            expect(remainingTargetSession.conversationId).toBe(targetSession.conversationId);
            expect(remainingTargetSession.modelRef).toBe(targetSession.modelRef);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight at last index does nothing', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 1, maxLength: 10 }),
          (agentNames) => {
            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const lastSession = sessions[sessions.length - 1];
            const initialSessionCount = sessions.length;

            // Try to close right sessions of the last session (should do nothing)
            useTestStore.getState().closeSessionsToRight(lastSession.id);

            // Verify all sessions remain
            expect(useTestStore.getState().sessions.size).toBe(initialSessionCount);
            sessions.forEach(session => {
              expect(useTestStore.getState().sessions.has(session.id)).toBe(true);
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight with non-existent session does nothing', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 1, maxLength: 5 }),
          fc.uuid(),
          (agentNames, fakeSessionId) => {
            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const initialSessionCount = sessions.length;

            // Ensure fake ID doesn't match any real session
            fc.pre(!sessions.some(s => s.id === fakeSessionId));

            // Try to close right with non-existent session
            useTestStore.getState().closeSessionsToRight(fakeSessionId);

            // Verify all sessions remain unchanged
            expect(useTestStore.getState().sessions.size).toBe(initialSessionCount);
            sessions.forEach(session => {
              expect(useTestStore.getState().sessions.has(session.id)).toBe(true);
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight preserves active session if not in right range', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 0, max: 8 }),
          fc.integer({ min: 0, max: 8 }),
          (agentNames, activeIndex, targetIndex) => {
            // Ensure indices are within bounds and active is at or left of target
            fc.pre(activeIndex < agentNames.length);
            fc.pre(targetIndex < agentNames.length);
            fc.pre(activeIndex <= targetIndex); // Active is not in right range

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session
            useTestStore.setState({ activeSessionId: sessions[activeIndex].id });
            const initialActiveId = sessions[activeIndex].id;

            // Close right sessions
            useTestStore.getState().closeSessionsToRight(sessions[targetIndex].id);

            // Verify active session is preserved (since it's not in right range)
            expect(useTestStore.getState().activeSessionId).toBe(initialActiveId);
            expect(useTestStore.getState().sessions.has(initialActiveId)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight updates active session if it was in right range', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 1, max: 9 }),
          fc.integer({ min: 0, max: 8 }),
          (agentNames, activeIndex, targetIndex) => {
            // Ensure indices are within bounds and active is right of target
            fc.pre(activeIndex < agentNames.length);
            fc.pre(targetIndex < agentNames.length);
            fc.pre(activeIndex > targetIndex); // Active is in right range

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session to one that will be closed
            useTestStore.setState({ activeSessionId: sessions[activeIndex].id });

            // Close right sessions
            useTestStore.getState().closeSessionsToRight(sessions[targetIndex].id);

            // Verify active session was updated to target session
            expect(useTestStore.getState().activeSessionId).toBe(sessions[targetIndex].id);
            expect(useTestStore.getState().sessions.has(sessions[targetIndex].id)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight preserves session state of remaining sessions', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 0, max: 8 }),
          fc.array(tokenArb, { minLength: 1, maxLength: 5 }),
          (agentNames, targetIndex) => {
            fc.pre(targetIndex < agentNames.length);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const targetSession = sessions[targetIndex];

            // Modify target session state with streaming tokens
            const tokens = fc.sample(tokenArb, { numRuns: 3 });
            tokens.forEach(token => {
              useTestStore.getState().appendStreamingToken(targetSession.id, token);
            });

            const expectedStreamingMessage = tokens.join('');

            // Close right sessions
            useTestStore.getState().closeSessionsToRight(targetSession.id);

            // Verify target session state is preserved
            const remainingSession = useTestStore.getState().sessions.get(targetSession.id)!;
            expect(remainingSession.streamingMessage).toBe(expectedStreamingMessage);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight at first index keeps only first session', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 2, maxLength: 10 }),
          (agentNames) => {
            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const firstSession = sessions[0];

            // Close right sessions of first session
            useTestStore.getState().closeSessionsToRight(firstSession.id);

            // Verify only first session remains
            expect(useTestStore.getState().sessions.size).toBe(1);
            expect(useTestStore.getState().sessions.has(firstSession.id)).toBe(true);

            // Verify all other sessions are removed
            for (let i = 1; i < sessions.length; i++) {
              expect(useTestStore.getState().sessions.has(sessions[i].id)).toBe(false);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight maintains order of remaining sessions', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 0, max: 8 }),
          (agentNames, targetIndex) => {
            fc.pre(targetIndex < agentNames.length);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            const targetSession = sessions[targetIndex];

            // Record expected remaining sessions in order
            const expectedRemaining = sessions.slice(0, targetIndex + 1);

            // Close right sessions
            useTestStore.getState().closeSessionsToRight(targetSession.id);

            // Get remaining sessions in order
            const remainingSessions = Array.from(useTestStore.getState().sessions.values());

            // Verify order is maintained
            expect(remainingSessions.length).toBe(expectedRemaining.length);
            expectedRemaining.forEach((expectedSession, index) => {
              const actualSession = remainingSessions.find(s => s.id === expectedSession.id);
              expect(actualSession).toBeDefined();
              expect(actualSession!.agentName).toBe(expectedSession.agentName);
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight with single session keeps it', () => {
      fc.assert(
        fc.property(
          agentNameArb,
          (agentName) => {
            resetStore();

            // Create single session
            const session = createTestSession(agentName);

            // Close right sessions (should do nothing)
            useTestStore.getState().closeSessionsToRight(session.id);

            // Verify session remains
            expect(useTestStore.getState().sessions.size).toBe(1);
            expect(useTestStore.getState().sessions.has(session.id)).toBe(true);
            expect(useTestStore.getState().activeSessionId).toBe(session.id);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight works with exactly 2 sessions', () => {
      fc.assert(
        fc.property(
          agentNameArb,
          agentNameArb,
          fc.boolean(),
          (agent1, agent2, keepFirst) => {
            resetStore();

            // Create exactly 2 sessions
            const session1 = createTestSession(agent1);
            const session2 = createTestSession(agent2);

            const targetSession = keepFirst ? session1 : session2;
            const expectedRemaining = keepFirst ? [session1] : [session1, session2];

            // Close right sessions
            useTestStore.getState().closeSessionsToRight(targetSession.id);

            // Verify correct sessions remain
            expect(useTestStore.getState().sessions.size).toBe(expectedRemaining.length);
            expectedRemaining.forEach(session => {
              expect(useTestStore.getState().sessions.has(session.id)).toBe(true);
            });
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: session-tab-context-menu, Property 7: 非活动目标关闭时保持活动 session
   * 
   * *For any* session list, when executing close left or close right operations,
   * if the target session is not the active session, then the active session
   * SHALL remain unchanged (provided the active session is not in the range being closed).
   * 
   * **Validates: Requirements 3.3, 4.3**
   */
  describe('Property 7: Active Session Preserved When Target Is Not Active', () => {
    it('closeSessionsToLeft preserves active session when target is not active and active is in safe range', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 1, max: 9 }),
          fc.integer({ min: 0, max: 8 }),
          (agentNames, targetIndex, activeIndex) => {
            // Ensure indices are within bounds
            fc.pre(targetIndex < agentNames.length);
            fc.pre(activeIndex < agentNames.length);
            // Target is not active
            fc.pre(targetIndex !== activeIndex);
            // Active session is in safe range (at or right of target)
            fc.pre(activeIndex >= targetIndex);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session (not the target)
            const activeSession = sessions[activeIndex];
            useTestStore.setState({ activeSessionId: activeSession.id });
            const initialActiveId = activeSession.id;

            // Close left sessions using target session
            const targetSession = sessions[targetIndex];
            useTestStore.getState().closeSessionsToLeft(targetSession.id);

            // Verify active session is preserved (since it's in safe range)
            expect(useTestStore.getState().activeSessionId).toBe(initialActiveId);
            expect(useTestStore.getState().sessions.has(initialActiveId)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight preserves active session when target is not active and active is in safe range', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 0, max: 8 }),
          fc.integer({ min: 0, max: 9 }),
          (agentNames, targetIndex, activeIndex) => {
            // Ensure indices are within bounds
            fc.pre(targetIndex < agentNames.length);
            fc.pre(activeIndex < agentNames.length);
            // Target is not active
            fc.pre(targetIndex !== activeIndex);
            // Active session is in safe range (at or left of target)
            fc.pre(activeIndex <= targetIndex);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session (not the target)
            const activeSession = sessions[activeIndex];
            useTestStore.setState({ activeSessionId: activeSession.id });
            const initialActiveId = activeSession.id;

            // Close right sessions using target session
            const targetSession = sessions[targetIndex];
            useTestStore.getState().closeSessionsToRight(targetSession.id);

            // Verify active session is preserved (since it's in safe range)
            expect(useTestStore.getState().activeSessionId).toBe(initialActiveId);
            expect(useTestStore.getState().sessions.has(initialActiveId)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToLeft with various configurations preserves active when safe', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 4, maxLength: 10 }),
          fc.integer({ min: 1, max: 9 }),
          (agentNames, targetIndex) => {
            fc.pre(targetIndex < agentNames.length);
            // Ensure there's at least one session to the right of target
            fc.pre(targetIndex < agentNames.length - 1);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session to one that's to the right of target (safe range)
            const activeIndex = targetIndex + 1;
            const activeSession = sessions[activeIndex];
            useTestStore.setState({ activeSessionId: activeSession.id });
            const initialActiveId = activeSession.id;

            // Close left sessions using target session
            const targetSession = sessions[targetIndex];
            useTestStore.getState().closeSessionsToLeft(targetSession.id);

            // Verify active session is preserved
            expect(useTestStore.getState().activeSessionId).toBe(initialActiveId);
            expect(useTestStore.getState().sessions.has(initialActiveId)).toBe(true);

            // Verify target is not active
            expect(targetSession.id).not.toBe(initialActiveId);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight with various configurations preserves active when safe', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 4, maxLength: 10 }),
          fc.integer({ min: 1, max: 9 }),
          (agentNames, targetIndex) => {
            fc.pre(targetIndex < agentNames.length);
            // Ensure there's at least one session to the left of target
            fc.pre(targetIndex > 0);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session to one that's to the left of target (safe range)
            const activeIndex = targetIndex - 1;
            const activeSession = sessions[activeIndex];
            useTestStore.setState({ activeSessionId: activeSession.id });
            const initialActiveId = activeSession.id;

            // Close right sessions using target session
            const targetSession = sessions[targetIndex];
            useTestStore.getState().closeSessionsToRight(targetSession.id);

            // Verify active session is preserved
            expect(useTestStore.getState().activeSessionId).toBe(initialActiveId);
            expect(useTestStore.getState().sessions.has(initialActiveId)).toBe(true);

            // Verify target is not active
            expect(targetSession.id).not.toBe(initialActiveId);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToLeft preserves active session state when target is not active', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 4, maxLength: 10 }),
          fc.integer({ min: 1, max: 8 }),
          fc.array(tokenArb, { minLength: 1, maxLength: 5 }),
          (agentNames, targetIndex, tokens) => {
            fc.pre(targetIndex < agentNames.length - 1);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session to the right of target
            const activeIndex = targetIndex + 1;
            const activeSession = sessions[activeIndex];
            useTestStore.setState({ activeSessionId: activeSession.id });

            // Modify active session state with streaming tokens
            tokens.forEach(token => {
              useTestStore.getState().appendStreamingToken(activeSession.id, token);
            });

            const expectedStreamingMessage = tokens.join('');

            // Close left sessions using target session (not active)
            const targetSession = sessions[targetIndex];
            useTestStore.getState().closeSessionsToLeft(targetSession.id);

            // Verify active session is preserved with its state
            const remainingActiveSession = useTestStore.getState().sessions.get(activeSession.id)!;
            expect(remainingActiveSession).toBeDefined();
            expect(remainingActiveSession.streamingMessage).toBe(expectedStreamingMessage);
            expect(useTestStore.getState().activeSessionId).toBe(activeSession.id);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight preserves active session state when target is not active', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 4, maxLength: 10 }),
          fc.integer({ min: 1, max: 9 }),
          fc.array(tokenArb, { minLength: 1, maxLength: 5 }),
          (agentNames, targetIndex, tokens) => {
            fc.pre(targetIndex < agentNames.length);
            fc.pre(targetIndex > 0);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session to the left of target
            const activeIndex = targetIndex - 1;
            const activeSession = sessions[activeIndex];
            useTestStore.setState({ activeSessionId: activeSession.id });

            // Modify active session state with streaming tokens
            tokens.forEach(token => {
              useTestStore.getState().appendStreamingToken(activeSession.id, token);
            });

            const expectedStreamingMessage = tokens.join('');

            // Close right sessions using target session (not active)
            const targetSession = sessions[targetIndex];
            useTestStore.getState().closeSessionsToRight(targetSession.id);

            // Verify active session is preserved with its state
            const remainingActiveSession = useTestStore.getState().sessions.get(activeSession.id)!;
            expect(remainingActiveSession).toBeDefined();
            expect(remainingActiveSession.streamingMessage).toBe(expectedStreamingMessage);
            expect(useTestStore.getState().activeSessionId).toBe(activeSession.id);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToLeft with active at target position preserves active', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 1, max: 9 }),
          (agentNames, targetIndex) => {
            fc.pre(targetIndex < agentNames.length);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session to be the target itself
            const targetSession = sessions[targetIndex];
            useTestStore.setState({ activeSessionId: targetSession.id });

            // Close left sessions
            useTestStore.getState().closeSessionsToLeft(targetSession.id);

            // Verify target (which is active) is preserved
            expect(useTestStore.getState().activeSessionId).toBe(targetSession.id);
            expect(useTestStore.getState().sessions.has(targetSession.id)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight with active at target position preserves active', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 3, maxLength: 10 }),
          fc.integer({ min: 0, max: 8 }),
          (agentNames, targetIndex) => {
            fc.pre(targetIndex < agentNames.length);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session to be the target itself
            const targetSession = sessions[targetIndex];
            useTestStore.setState({ activeSessionId: targetSession.id });

            // Close right sessions
            useTestStore.getState().closeSessionsToRight(targetSession.id);

            // Verify target (which is active) is preserved
            expect(useTestStore.getState().activeSessionId).toBe(targetSession.id);
            expect(useTestStore.getState().sessions.has(targetSession.id)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToLeft with multiple safe active positions preserves active', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 5, maxLength: 10 }),
          fc.integer({ min: 1, max: 7 }),
          fc.integer({ min: 0, max: 2 }),
          (agentNames, targetIndex, offsetFromTarget) => {
            fc.pre(targetIndex < agentNames.length);
            const activeIndex = targetIndex + offsetFromTarget;
            fc.pre(activeIndex < agentNames.length);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session at various positions to the right of or at target
            const activeSession = sessions[activeIndex];
            useTestStore.setState({ activeSessionId: activeSession.id });
            const initialActiveId = activeSession.id;

            // Close left sessions
            const targetSession = sessions[targetIndex];
            useTestStore.getState().closeSessionsToLeft(targetSession.id);

            // Verify active session is preserved
            expect(useTestStore.getState().activeSessionId).toBe(initialActiveId);
            expect(useTestStore.getState().sessions.has(initialActiveId)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('closeSessionsToRight with multiple safe active positions preserves active', () => {
      fc.assert(
        fc.property(
          fc.array(agentNameArb, { minLength: 5, maxLength: 10 }),
          fc.integer({ min: 2, max: 9 }),
          fc.integer({ min: 0, max: 2 }),
          (agentNames, targetIndex, offsetFromTarget) => {
            fc.pre(targetIndex < agentNames.length);
            const activeIndex = targetIndex - offsetFromTarget;
            fc.pre(activeIndex >= 0);

            resetStore();

            // Create sessions
            const sessions = agentNames.map(name => createTestSession(name));
            
            // Set active session at various positions to the left of or at target
            const activeSession = sessions[activeIndex];
            useTestStore.setState({ activeSessionId: activeSession.id });
            const initialActiveId = activeSession.id;

            // Close right sessions
            const targetSession = sessions[targetIndex];
            useTestStore.getState().closeSessionsToRight(targetSession.id);

            // Verify active session is preserved
            expect(useTestStore.getState().activeSessionId).toBe(initialActiveId);
            expect(useTestStore.getState().sessions.has(initialActiveId)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

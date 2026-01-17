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
});

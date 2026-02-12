import { create } from "zustand";
import { loadJson, saveJson } from "./storage";
import type {
  InkState,
  PracticeAnswer,
  PracticeGrading,
  PracticeQuestion,
  PracticeQuestionId,
  PracticeQuestionProgress,
  PracticeQuestionType,
  PracticeQuiz,
  PracticeQuizId,
} from "./types";

type CreateQuizOptions = {
  title?: string;
};

type State = {
  quizzes: PracticeQuiz[];
  activeQuizId: PracticeQuizId | null;

  importQuiz: (quiz: PracticeQuiz, opts?: { setActive?: boolean }) => void;
  createQuiz: (opts?: CreateQuizOptions) => PracticeQuizId;
  deleteQuiz: (id: PracticeQuizId) => void;
  setActiveQuiz: (id: PracticeQuizId) => void;
  renameQuiz: (id: PracticeQuizId, title: string) => void;

  addQuestion: (quizId: PracticeQuizId, type: PracticeQuestionType) => PracticeQuestionId;
  deleteQuestion: (quizId: PracticeQuizId, questionId: PracticeQuestionId) => void;
  updateQuestion: (
    quizId: PracticeQuizId,
    questionId: PracticeQuestionId,
    patch: Partial<PracticeQuestion>,
  ) => void;

  setAnswer: (
    quizId: PracticeQuizId,
    questionId: PracticeQuestionId,
    answer: PracticeAnswer,
    opts?: { commit?: boolean },
  ) => void;
  setInkDraft: (
    quizId: PracticeQuizId,
    questionId: PracticeQuestionId,
    ink: InkState,
    opts?: { commit?: boolean; summaryText?: string },
  ) => void;
  setGrading: (
    quizId: PracticeQuizId,
    questionId: PracticeQuestionId,
    grading: PracticeGrading,
  ) => void;
  clearQuestionResult: (quizId: PracticeQuizId, questionId: PracticeQuestionId) => void;
  resetQuizProgress: (quizId: PracticeQuizId) => void;
};

const STORAGE_KEY = "tauri-ai.practice.v1";

function now(): number {
  return Date.now();
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function ensureProgress(quiz: PracticeQuiz): PracticeQuiz {
  if (quiz.progress?.byQuestionId) return quiz;
  return { ...quiz, progress: { byQuestionId: {} } };
}

function setQuestionProgress(
  quiz: PracticeQuiz,
  questionId: PracticeQuestionId,
  patch: Partial<PracticeQuestionProgress>,
): PracticeQuiz {
  const q = ensureProgress(quiz);
  const prev = q.progress?.byQuestionId?.[questionId] ?? {};
  const nextBy = { ...(q.progress?.byQuestionId ?? {}), [questionId]: { ...prev, ...patch } };
  return { ...q, progress: { byQuestionId: nextBy } };
}

function createBlankQuestion(type: PracticeQuestionType): PracticeQuestion {
  const id = newId("pq");
  if (type === "multiple_choice") {
    const options = [
      { id: "A", text: "" },
      { id: "B", text: "" },
      { id: "C", text: "" },
      { id: "D", text: "" },
    ];
    return {
      id,
      type,
      prompt: "",
      points: 5,
      options,
      correctOptionId: "A",
      explanation: "",
    };
  }
  return {
    id,
    type,
    prompt: "",
    points: 10,
    referenceAnswer: "",
    explanation: "",
  };
}

function createEmptyQuiz(opts?: CreateQuizOptions): PracticeQuiz {
  const id = newId("quiz");
  return {
    id,
    title: opts?.title?.trim() || "新练习",
    createdAt: now(),
    updatedAt: now(),
    questions: [],
    progress: { byQuestionId: {} },
  };
}

function loadInitial(): Pick<State, "quizzes" | "activeQuizId"> {
  const data = loadJson<{ quizzes: PracticeQuiz[]; activeQuizId: PracticeQuizId | null }>(
    STORAGE_KEY,
    { quizzes: [], activeQuizId: null },
  );
  if (data.quizzes.length === 0) {
    const quiz = createEmptyQuiz();
    return { quizzes: [quiz], activeQuizId: quiz.id };
  }
  const active =
    data.activeQuizId && data.quizzes.some((q) => q.id === data.activeQuizId)
      ? data.activeQuizId
      : data.quizzes[0]?.id ?? null;
  return { quizzes: data.quizzes, activeQuizId: active };
}

export const usePracticeStore = create<State>((set) => {
  const initial = loadInitial();

  const persist = (next: Pick<State, "quizzes" | "activeQuizId">) => {
    saveJson(STORAGE_KEY, next);
  };

  const updateQuizzes = (
    recipe: (prev: Pick<State, "quizzes" | "activeQuizId">) => Pick<State, "quizzes" | "activeQuizId">,
    commit: boolean,
  ) => {
    set((s) => {
      const next = recipe({ quizzes: s.quizzes, activeQuizId: s.activeQuizId });
      if (commit) persist(next);
      return next;
    });
  };

  return {
    quizzes: initial.quizzes,
    activeQuizId: initial.activeQuizId,

    importQuiz: (quiz, opts) => {
      const setActive = opts?.setActive ?? true;
      updateQuizzes(
        (prev) => ({
          quizzes: [ensureProgress({ ...quiz, updatedAt: now() }), ...prev.quizzes],
          activeQuizId: setActive ? quiz.id : prev.activeQuizId,
        }),
        true,
      );
    },

    createQuiz: (opts) => {
      const quiz = createEmptyQuiz(opts);
      updateQuizzes(
        (prev) => ({ quizzes: [quiz, ...prev.quizzes], activeQuizId: quiz.id }),
        true,
      );
      return quiz.id;
    },

    deleteQuiz: (id) => {
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.filter((q) => q.id !== id);
        const activeQuizId =
          prev.activeQuizId === id ? (quizzes[0]?.id ?? null) : prev.activeQuizId;
        return { quizzes, activeQuizId };
      }, true);
    },

    setActiveQuiz: (id) => {
      updateQuizzes((prev) => ({ quizzes: prev.quizzes, activeQuizId: id }), true);
    },

    renameQuiz: (id, title) => {
      const nextTitle = title.trim();
      if (!nextTitle) return;
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.map((q) =>
          q.id === id ? { ...q, title: nextTitle, updatedAt: now() } : q,
        );
        return { quizzes, activeQuizId: prev.activeQuizId };
      }, true);
    },

    addQuestion: (quizId, type) => {
      const question = createBlankQuestion(type);
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.map((q) => {
          if (q.id !== quizId) return q;
          const quiz = ensureProgress(q);
          return { ...quiz, questions: [...quiz.questions, question], updatedAt: now() };
        });
        return { quizzes, activeQuizId: prev.activeQuizId };
      }, true);
      return question.id;
    },

    deleteQuestion: (quizId, questionId) => {
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.map((q) => {
          if (q.id !== quizId) return q;
          const quiz = ensureProgress(q);
          const questions = quiz.questions.filter((qq) => qq.id !== questionId);
          const by = { ...(quiz.progress?.byQuestionId ?? {}) };
          delete by[questionId];
          return { ...quiz, questions, progress: { byQuestionId: by }, updatedAt: now() };
        });
        return { quizzes, activeQuizId: prev.activeQuizId };
      }, true);
    },

    updateQuestion: (quizId, questionId, patch) => {
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.map((q) => {
          if (q.id !== quizId) return q;
          const questions = q.questions.map((qq) => {
            if (qq.id !== questionId) return qq;
            return { ...qq, ...(patch as any) } as PracticeQuestion;
          });
          return { ...q, questions, updatedAt: now() };
        });
        return { quizzes, activeQuizId: prev.activeQuizId };
      }, true);
    },

    setAnswer: (quizId, questionId, answer, opts) => {
      const commit = opts?.commit ?? true;
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.map((q) => {
          if (q.id !== quizId) return q;
          return setQuestionProgress(ensureProgress(q), questionId, { answer });
        });
        return { quizzes, activeQuizId: prev.activeQuizId };
      }, commit);
    },

    setInkDraft: (quizId, questionId, ink, opts) => {
      const commit = opts?.commit ?? true;
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.map((q) => {
          if (q.id !== quizId) return q;
          const answer: PracticeAnswer = { kind: "ink", ink, summaryText: opts?.summaryText };
          return setQuestionProgress(ensureProgress(q), questionId, { answer });
        });
        return { quizzes, activeQuizId: prev.activeQuizId };
      }, commit);
    },

    setGrading: (quizId, questionId, grading) => {
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.map((q) => {
          if (q.id !== quizId) return q;
          return setQuestionProgress(ensureProgress(q), questionId, {
            grading,
            submittedAt: now(),
          });
        });
        return { quizzes, activeQuizId: prev.activeQuizId };
      }, true);
    },

    clearQuestionResult: (quizId, questionId) => {
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.map((q) => {
          if (q.id !== quizId) return q;
          return setQuestionProgress(ensureProgress(q), questionId, {
            grading: undefined,
            submittedAt: undefined,
          });
        });
        return { quizzes, activeQuizId: prev.activeQuizId };
      }, true);
    },

    resetQuizProgress: (quizId) => {
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.map((q) => {
          if (q.id !== quizId) return q;
          return { ...q, progress: { byQuestionId: {} }, updatedAt: now() };
        });
        return { quizzes, activeQuizId: prev.activeQuizId };
      }, true);
    },
  };
});

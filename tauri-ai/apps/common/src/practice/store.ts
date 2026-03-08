import { create } from "zustand";
import { loadJson, saveJson } from "./storage";
import type {
  InkState,
  InkStroke,
  PracticeAnswer,
  PracticeAnswerImage,
  PracticeGrading,
  PracticeQuizGrading,
  PracticeQuestion,
  PracticeQuestionId,
  PracticeQuestionProgress,
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
  replaceGeneratedQuestions: (quizId: PracticeQuizId, questions: PracticeQuestion[]) => void;

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
  setQuizGrading: (quizId: PracticeQuizId, grading: PracticeQuizGrading) => void;
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

const INK_SIZE_MIN = 0.5;
const INK_SIZE_MAX = 64;

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeInkState(raw: unknown): { ink: InkState; changed: boolean } {
  const inkObj = (raw && typeof raw === "object" ? (raw as any) : {}) as any;
  const width = clampNumber(inkObj.width, 0, 100000, 0);
  const height = clampNumber(inkObj.height, 0, 100000, 0);
  const strokesIn: any[] = Array.isArray(inkObj.strokes) ? inkObj.strokes : [];

  let changed = false;
  const strokesOut: InkStroke[] = [];
  for (const s0 of strokesIn) {
    const s = (s0 && typeof s0 === "object" ? s0 : {}) as any;
    const tool =
      s.tool === "pen" || s.tool === "pencil" || s.tool === "eraser" ? (s.tool as any) : "pen";
    const color = typeof s.color === "string" && s.color.trim() ? s.color : "#111827";
    const size = clampNumber(s.size, INK_SIZE_MIN, INK_SIZE_MAX, 3);
    const id = typeof s.id === "string" && s.id.trim() ? s.id : newId("stroke");

    const pointsIn: any[] = Array.isArray(s.points) ? s.points : [];
    const pointsOut: any[] = [];
    for (const p0 of pointsIn) {
      const p = (p0 && typeof p0 === "object" ? p0 : {}) as any;
      const x = typeof p.x === "number" ? p.x : Number(p.x);
      const y = typeof p.y === "number" ? p.y : Number(p.y);
      const t = typeof p.t === "number" ? p.t : Number(p.t);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) {
        changed = true;
        continue;
      }
      const pressure = typeof p.pressure === "number" && Number.isFinite(p.pressure) ? p.pressure : undefined;
      const tiltX = typeof p.tiltX === "number" && Number.isFinite(p.tiltX) ? p.tiltX : undefined;
      const tiltY = typeof p.tiltY === "number" && Number.isFinite(p.tiltY) ? p.tiltY : undefined;
      const twist = typeof p.twist === "number" && Number.isFinite(p.twist) ? p.twist : undefined;
      pointsOut.push({ x, y, t, pressure, tiltX, tiltY, twist });
    }

    if (pointsOut.length === 0) {
      changed = true;
      continue;
    }

    const opacity = typeof s.opacity === "number" ? clampNumber(s.opacity, 0.05, 1, 1) : undefined;
    const pressureSensitivity =
      typeof s.pressureSensitivity === "number"
        ? clampNumber(s.pressureSensitivity, 0, 1, 0)
        : undefined;
    const blendMode = s.blendMode === "multiply" || s.blendMode === "source-over" ? s.blendMode : undefined;
    const lineCap = s.lineCap === "butt" || s.lineCap === "round" || s.lineCap === "square" ? s.lineCap : undefined;
    const lineJoin = s.lineJoin === "bevel" || s.lineJoin === "miter" || s.lineJoin === "round" ? s.lineJoin : undefined;
    const brushId = typeof s.brushId === "string" && s.brushId.trim() ? s.brushId : undefined;

    if (
      tool !== s.tool ||
      color !== s.color ||
      size !== s.size ||
      id !== s.id ||
      (opacity ?? null) !== (typeof s.opacity === "number" ? s.opacity : null) ||
      (pressureSensitivity ?? null) !== (typeof s.pressureSensitivity === "number" ? s.pressureSensitivity : null) ||
      (blendMode ?? null) !== (s.blendMode ?? null) ||
      (lineCap ?? null) !== (s.lineCap ?? null) ||
      (lineJoin ?? null) !== (s.lineJoin ?? null) ||
      (brushId ?? null) !== (s.brushId ?? null) ||
      pointsOut.length !== pointsIn.length
    ) {
      changed = true;
    }

    strokesOut.push({
      id,
      tool,
      color,
      size,
      brushId,
      opacity,
      pressureSensitivity,
      blendMode,
      lineCap,
      lineJoin,
      points: pointsOut,
    } as InkStroke);
  }

  const widthOut = Math.max(0, Math.round(width));
  const heightOut = Math.max(0, Math.round(height));
  if (widthOut !== inkObj.width || heightOut !== inkObj.height || strokesOut.length !== strokesIn.length) {
    changed = true;
  }
  return { ink: { width: widthOut, height: heightOut, strokes: strokesOut }, changed };
}

function normalizePracticeAnswerImages(
  raw: unknown,
): { images: PracticeAnswerImage[] | undefined; changed: boolean } {
  if (raw == null) return { images: undefined, changed: false };
  if (!Array.isArray(raw)) return { images: undefined, changed: true };

  let changed = false;
  const images: PracticeAnswerImage[] = [];
  for (const item of raw) {
    const image = item && typeof item === "object" ? (item as any) : {};
    const url = typeof image.url === "string" ? image.url.trim() : "";
    if (!url) {
      changed = true;
      continue;
    }

    const id = typeof image.id === "string" && image.id.trim() ? image.id.trim() : newId("ans_img");
    const name = typeof image.name === "string" && image.name.trim() ? image.name.trim() : undefined;
    const width =
      typeof image.width === "number" && Number.isFinite(image.width) && image.width > 0
        ? Math.round(image.width)
        : undefined;
    const height =
      typeof image.height === "number" && Number.isFinite(image.height) && image.height > 0
        ? Math.round(image.height)
        : undefined;

    if (id !== image.id || name !== image.name || width !== image.width || height !== image.height) {
      changed = true;
    }

    images.push({ id, url, name, width, height });
  }

  return { images, changed };
}

function normalizeProgressAnswer(answer: PracticeAnswer | undefined): { answer: PracticeAnswer | undefined; changed: boolean } {
  if (!answer) return { answer, changed: false };
  if (answer.kind !== "ink") return { answer, changed: false };
  const normalizedInk = normalizeInkState((answer as any).ink);
  const normalizedImages = normalizePracticeAnswerImages((answer as any).images);
  if (!normalizedInk.changed && !normalizedImages.changed) {
    return { answer, changed: false };
  }
  return {
    answer: {
      ...(answer as any),
      ink: normalizedInk.ink,
      images: normalizedImages.images,
    },
    changed: true,
  };
}

function normalizeQuizzesOnLoad(
  quizzes: PracticeQuiz[],
): { quizzes: PracticeQuiz[]; changed: boolean } {
  let changed = false;
  const next = quizzes.map((q) => {
    const quiz = ensureProgress(q);
    const by = quiz.progress?.byQuestionId ?? {};
    const nextBy: Record<PracticeQuestionId, PracticeQuestionProgress> = { ...by };
    let quizChanged = false;
    for (const [qid, prog] of Object.entries(by)) {
      const normalized = normalizeProgressAnswer(prog?.answer);
      if (normalized.changed) {
        quizChanged = true;
        nextBy[qid] = { ...(prog ?? {}), answer: normalized.answer };
      }
    }
    if (!quizChanged) return quiz;
    changed = true;
    return { ...quiz, progress: { ...(quiz.progress ?? {}), byQuestionId: nextBy } };
  });
  return { quizzes: next, changed };
}

function ensureProgress(quiz: PracticeQuiz): PracticeQuiz {
  if (quiz.progress?.byQuestionId) return quiz;
  return { ...quiz, progress: { ...(quiz.progress ?? {}), byQuestionId: {} } };
}

function setQuestionProgress(
  quiz: PracticeQuiz,
  questionId: PracticeQuestionId,
  patch: Partial<PracticeQuestionProgress>,
): PracticeQuiz {
  const q = ensureProgress(quiz);
  const prev = q.progress?.byQuestionId?.[questionId] ?? {};
  const nextBy = { ...(q.progress?.byQuestionId ?? {}), [questionId]: { ...prev, ...patch } };
  return {
    ...q,
    progress: {
      ...(q.progress ?? {}),
      byQuestionId: nextBy,
      quizGrading: undefined,
    },
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
  const normalized = normalizeQuizzesOnLoad(data.quizzes);
  const active =
    data.activeQuizId && data.quizzes.some((q) => q.id === data.activeQuizId)
      ? data.activeQuizId
      : data.quizzes[0]?.id ?? null;
  const initial = { quizzes: normalized.quizzes, activeQuizId: active };
  if (normalized.changed) {
    saveJson(STORAGE_KEY, initial);
  }
  return initial;
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

    replaceGeneratedQuestions: (quizId, questions) => {
      if (!Array.isArray(questions)) return;
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.map((q) => {
          if (q.id !== quizId) return q;

          const incomingIds = new Set<string>();
          const incoming = questions
            .filter((item) => item && typeof item === "object")
            .map((item) => {
              let id = String(item.id ?? "").trim();
              if (!id || incomingIds.has(id)) {
                do {
                  id = newId("pq");
                } while (incomingIds.has(id));
              }
              incomingIds.add(id);
              return { ...item, id } as PracticeQuestion;
            });

          return {
            ...q,
            questions: incoming,
            progress: { ...(q.progress ?? {}), byQuestionId: {}, quizGrading: undefined },
            updatedAt: now(),
          };
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
      const normalizedInk = normalizeInkState(ink).ink;
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.map((q) => {
          if (q.id !== quizId) return q;
          const previousAnswer = q.progress?.byQuestionId?.[questionId]?.answer;
          const answer: PracticeAnswer = {
            kind: "ink",
            ink: normalizedInk,
            summaryText:
              opts?.summaryText ?? (previousAnswer?.kind === "ink" ? previousAnswer.summaryText : undefined),
            images: previousAnswer?.kind === "ink" ? previousAnswer.images : undefined,
          };
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

    setQuizGrading: (quizId, grading) => {
      updateQuizzes((prev) => {
        const quizzes = prev.quizzes.map((q) => {
          if (q.id !== quizId) return q;
          const quiz = ensureProgress(q);
          return {
            ...quiz,
            progress: {
              ...(quiz.progress ?? {}),
              byQuestionId: quiz.progress?.byQuestionId ?? {},
              quizGrading: grading,
            },
            updatedAt: now(),
          };
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
          return {
            ...q,
            progress: { ...(q.progress ?? {}), byQuestionId: {}, quizGrading: undefined },
            updatedAt: now(),
          };
        });
        return { quizzes, activeQuizId: prev.activeQuizId };
      }, true);
    },
  };
});

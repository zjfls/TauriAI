import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { MessageSquareText, Plus, Trash2, Wand2 } from "lucide-react";
import { useConfigStore } from "../../stores/configStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUIStore } from "../../stores/uiStore";
import {
  filterNonPracticeAgents,
  resolvePracticeAgentPresentation,
  SYSTEM_PRACTICE_AGENT_LABEL,
} from "../../../../common/src/agentUtils";
import { MarkdownRenderer } from "../Chat/MarkdownRenderer";
import { usePracticeStore } from "../../../../common/src/practice/store";
import type {
  PracticeAnswer,
  PracticeQuestion,
  PracticeQuestionProgress,
  PracticeQuestionType,
  PracticeQuiz,
} from "../../../../common/src/practice/types";
import {
  generatePracticeQuiz,
  generatePracticeTitle,
  gradePracticeAnswer,
} from "../../../../common/src/practice/llm";
import {
  DEFAULT_PRACTICE_GENERATION_COUNTS,
  PRACTICE_GENERATION_FIELDS,
  normalizePracticeGenerationCountValue,
  totalPracticeGenerationCounts,
} from "../../../../common/src/practice/generation";
import {
  ScrollableInkPad,
  createEmptyInkState,
} from "../../../../common/src/practice/ink/ScrollableInkPad";
import { InkBrushPreview } from "../../../../common/src/practice/ink/InkBrushPalette";
import { renderInkStateToDataUrl as renderInkToDataUrl } from "../../../../common/src/practice/ink/rendering";
import {
  DEFAULT_INK_BRUSH_ID,
  getInkBrushMenuLabel,
  INK_BRUSH_PRESETS,
} from "../../../../common/src/practice/ink/brushes";
import { buildPracticeQuestionChatPrompt } from "../../../../common/src/practice/chatPrompt";
import {
  buildPracticeChoiceGrading,
  buildPracticeQuizGrading,
  buildPracticeUnansweredGrading,
} from "../../../../common/src/practice/grading";
import { focusMainWindow } from "../../utils/viewWindow";

function questionTypeLabel(t: PracticeQuestionType): string {
  if (t === "multiple_choice") return "选择题";
  if (t === "calculation") return "计算题";
  if (t === "proof") return "证明题";
  return "问答题";
}

const INK_COLORS = [
  "#111827",
  "#1d4ed8",
  "#0f766e",
  "#7c3aed",
  "#b91c1c",
] as const;
const DRAWING_BRUSH_PRESETS = INK_BRUSH_PRESETS.filter(
  (item) => item.tool !== "eraser",
);
const ERASER_BRUSH_PRESET = INK_BRUSH_PRESETS.find(
  (item) => item.tool === "eraser",
);
const INK_SIZE_MIN = 1;
const INK_SIZE_MAX = 24;
const INK_SIZE_STEP = 0.1;
const INK_SIZE_HOLD_DELAY_MS = 260;
const INK_SIZE_HOLD_INTERVAL_MS = 60;

function normalizeInkSize(value: number): number {
  return Math.round(
    Math.min(INK_SIZE_MAX, Math.max(INK_SIZE_MIN, value)) * 10,
  ) / 10;
}

function formatInkSize(value: number): string {
  return value.toFixed(1);
}

export function PracticeView() {
  const quizzes = usePracticeStore((s) => s.quizzes);
  const activeQuizId = usePracticeStore((s) => s.activeQuizId);
  const setActiveQuiz = usePracticeStore((s) => s.setActiveQuiz);
  const createQuiz = usePracticeStore((s) => s.createQuiz);
  const deleteQuiz = usePracticeStore((s) => s.deleteQuiz);
  const renameQuiz = usePracticeStore((s) => s.renameQuiz);

  const replaceGeneratedQuestions = usePracticeStore(
    (s) => s.replaceGeneratedQuestions,
  );
  const setAnswer = usePracticeStore((s) => s.setAnswer);
  const setInkDraft = usePracticeStore((s) => s.setInkDraft);
  const setGrading = usePracticeStore((s) => s.setGrading);
  const setQuizGrading = usePracticeStore((s) => s.setQuizGrading);
  const clearQuestionResult = usePracticeStore((s) => s.clearQuestionResult);

  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const createSession = useSessionStore((s) => s.createSession);
  const switchSession = useSessionStore((s) => s.switchSession);
  const setSessionDraftContent = useSessionStore(
    (s) => s.setSessionDraftContent,
  );
  const setActiveView = useUIStore((s) => s.setActiveView);

  const config = useConfigStore((s) => s.config);
  const practiceAgent = useMemo(
    () => resolvePracticeAgentPresentation(config),
    [config],
  );

  const quiz = useMemo(
    () => quizzes.find((q) => q.id === activeQuizId) ?? quizzes[0],
    [quizzes, activeQuizId],
  );
  const quizGrading = quiz?.progress?.quizGrading;

  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">(
    "medium",
  );
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string>("");
  const [questionCounts, setQuestionCounts] = useState(
    DEFAULT_PRACTICE_GENERATION_COUNTS,
  );
  const [quizTitleDraft, setQuizTitleDraft] = useState(quiz?.title ?? "");
  const [inkDrawBrushId, setInkDrawBrushId] = useState<string>(() => {
    const preferred = DRAWING_BRUSH_PRESETS.find(
      (item) => item.id === DEFAULT_INK_BRUSH_ID,
    );
    return (
      preferred?.id ?? DRAWING_BRUSH_PRESETS[0]?.id ?? DEFAULT_INK_BRUSH_ID
    );
  });
  const [inkUseEraser, setInkUseEraser] = useState(false);
  const [inkPenColor, setInkPenColor] = useState<string>(INK_COLORS[0]);
  const [inkPenSize, setInkPenSize] = useState(5);
  const [inkEraserSize, setInkEraserSize] = useState(16);

  const totalQuestionCount = useMemo(
    () => totalPracticeGenerationCounts(questionCounts),
    [questionCounts],
  );
  const activeInkBrush = useMemo(
    () =>
      (inkUseEraser ? ERASER_BRUSH_PRESET : undefined) ??
      DRAWING_BRUSH_PRESETS.find((item) => item.id === inkDrawBrushId) ??
      DRAWING_BRUSH_PRESETS.find((item) => item.id === DEFAULT_INK_BRUSH_ID) ??
      DRAWING_BRUSH_PRESETS[0] ??
      ERASER_BRUSH_PRESET ??
      INK_BRUSH_PRESETS[0]!,
    [inkDrawBrushId, inkUseEraser],
  );
  const activeInkSize = inkUseEraser ? inkEraserSize : inkPenSize;
  const inkSizeHoldTimeoutRef = useRef<number | null>(null);
  const inkSizeHoldIntervalRef = useRef<number | null>(null);

  const stopInkSizeAdjust = useCallback(() => {
    if (inkSizeHoldTimeoutRef.current !== null) {
      window.clearTimeout(inkSizeHoldTimeoutRef.current);
      inkSizeHoldTimeoutRef.current = null;
    }
    if (inkSizeHoldIntervalRef.current !== null) {
      window.clearInterval(inkSizeHoldIntervalRef.current);
      inkSizeHoldIntervalRef.current = null;
    }
  }, []);

  useEffect(() => () => stopInkSizeAdjust(), [stopInkSizeAdjust]);

  const applyInkSize = useCallback(
    (value: number) => {
      const nextSize = normalizeInkSize(value);
      if (inkUseEraser) {
        setInkEraserSize(nextSize);
        return;
      }
      setInkPenSize(nextSize);
    },
    [inkUseEraser],
  );

  const adjustInkSize = useCallback(
    (delta: number) => {
      if (inkUseEraser) {
        setInkEraserSize((prev) => normalizeInkSize(prev + delta));
        return;
      }
      setInkPenSize((prev) => normalizeInkSize(prev + delta));
    },
    [inkUseEraser],
  );

  const startInkSizeAdjust = useCallback(
    (delta: number) => {
      adjustInkSize(delta);
      stopInkSizeAdjust();
      window.addEventListener("pointerup", stopInkSizeAdjust, { once: true });
      window.addEventListener("pointercancel", stopInkSizeAdjust, { once: true });
      inkSizeHoldTimeoutRef.current = window.setTimeout(() => {
        inkSizeHoldIntervalRef.current = window.setInterval(() => {
          adjustInkSize(delta);
        }, INK_SIZE_HOLD_INTERVAL_MS);
      }, INK_SIZE_HOLD_DELAY_MS);
    },
    [adjustInkSize, stopInkSizeAdjust],
  );

  const [gradeBusy, setGradeBusy] = useState<Record<string, boolean>>({});
  const [gradeError, setGradeError] = useState<Record<string, string>>({});
  const [copyQuestionToChatBusy, setCopyQuestionToChatBusy] = useState<
    Record<string, boolean>
  >({});
  const [quizSubmitBusy, setQuizSubmitBusy] = useState(false);
  const [quizSubmitError, setQuizSubmitError] = useState("");

  useEffect(() => {
    setQuizTitleDraft(quiz?.title ?? "");
  }, [quiz?.id, quiz?.title]);

  useEffect(() => {
    setQuizSubmitBusy(false);
    setQuizSubmitError("");
  }, [quiz?.id]);

  const defaultChatAgentName = useMemo(() => {
    const visibleAgents = filterNonPracticeAgents(config?.agents || []);
    const configuredDefault = String(config?.defaultAgent ?? "").trim();
    if (
      configuredDefault &&
      visibleAgents.some((agent) => agent.name === configuredDefault)
    ) {
      return configuredDefault;
    }
    return visibleAgents[0]?.name ?? "";
  }, [config]);

  const commitQuizTitleDraft = useCallback(() => {
    if (!quiz) return;
    const normalized = quizTitleDraft.trim();
    if (!normalized) {
      setQuizTitleDraft(quiz.title || "");
      return;
    }
    if (normalized !== quiz.title) {
      renameQuiz(quiz.id, normalized);
    }
  }, [quiz, quizTitleDraft, renameQuiz]);

  const confirmDeleteQuiz = useCallback(
    (quizId: string, title?: string) => {
      const label = title?.trim() || "未命名练习";
      if (!window.confirm(`确定删除练习“${label}”吗？`)) return;
      deleteQuiz(quizId);
    },
    [deleteQuiz],
  );

  const copyQuestionToChat = useCallback(
    async (question: PracticeQuestion) => {
      setCopyQuestionToChatBusy((prev) => ({ ...prev, [question.id]: true }));
      const prompt = buildPracticeQuestionChatPrompt(question);
      try {
        await navigator.clipboard.writeText(prompt);
      } catch {
        // ignore clipboard fallback errors
      }

      try {
        if (!isTauri()) {
          let targetSessionId = (activeSessionId ?? "").trim();
          if (!targetSessionId || !sessions.has(targetSessionId)) {
            const firstSessionId = sessions.keys().next().value as
              | string
              | undefined;
            targetSessionId =
              firstSessionId && sessions.has(firstSessionId)
                ? firstSessionId
                : "";
          }
          if (!targetSessionId) {
            if (!defaultChatAgentName) {
              throw new Error("未配置可用于聊天的 Agent");
            }
            targetSessionId = await createSession(defaultChatAgentName);
          }
          setSessionDraftContent(targetSessionId, prompt);
          switchSession(targetSessionId);
          setActiveView("chat");
        } else {
          await focusMainWindow();
          const mainWin = await WebviewWindow.getByLabel("main").catch(
            () => null,
          );
          if (!mainWin) {
            throw new Error("未找到主聊天窗口");
          }
          await mainWin.emit("chat:set_draft_text", { text: prompt });
        }
      } catch (error) {
        console.error("Failed to copy practice question to chat:", error);
      } finally {
        setCopyQuestionToChatBusy((prev) => ({
          ...prev,
          [question.id]: false,
        }));
      }
    },
    [
      activeSessionId,
      createSession,
      defaultChatAgentName,
      sessions,
      setActiveView,
      setSessionDraftContent,
      switchSession,
    ],
  );

  const evaluateQuestion = useCallback(
    async (
      question: PracticeQuestion,
      answer: PracticeAnswer | undefined,
      opts?: { allowBlank?: boolean },
    ) => {
      if (question.type === "multiple_choice") {
        return buildPracticeChoiceGrading(
          question,
          answer?.kind === "choice" ? answer.optionId : "",
        );
      }

      const text =
        answer?.kind === "text"
          ? answer.text
          : answer?.kind === "ink"
            ? answer.summaryText || ""
            : "";
      const renderedInkImage =
        answer?.kind === "ink" ? await renderInkToDataUrl(answer.ink) : null;
      const studentAnswerImages = renderedInkImage
        ? [
            {
              type: "image" as const,
              url: renderedInkImage,
              detail: "high" as const,
            },
          ]
        : [];

      if (!text.trim() && studentAnswerImages.length === 0) {
        if (opts?.allowBlank) {
          return buildPracticeUnansweredGrading(
            question,
            "未作答，当前题记 0 分。",
          );
        }
        throw new Error("请先在手写区作答或填写文字答案后再提交");
      }
      if (!isTauri()) {
        throw new Error(
          "当前在浏览器预览模式，无法调用后端批改。请在 App 内运行。",
        );
      }
      return await gradePracticeAnswer(invoke as any, {
        question,
        studentAnswer: text,
        studentAnswerImages:
          studentAnswerImages.length > 0 ? studentAnswerImages : undefined,
      });
    },
    [],
  );

  const submitQuestion = useCallback(
    async (
      quizId: string,
      question: PracticeQuestion,
      progress: PracticeQuestionProgress | undefined,
      opts?: { allowBlank?: boolean; reuseExisting?: boolean },
    ) => {
      setGradeError((prev) => ({ ...prev, [question.id]: "" }));
      if ((opts?.reuseExisting ?? true) && progress?.grading) {
        return progress.grading;
      }

      const shouldTrackBusy = question.type !== "multiple_choice";
      if (shouldTrackBusy) {
        setGradeBusy((prev) => ({ ...prev, [question.id]: true }));
      }

      try {
        const grading = await evaluateQuestion(question, progress?.answer, {
          allowBlank: opts?.allowBlank,
        });
        setGrading(quizId, question.id, grading);
        return grading;
      } catch (e: any) {
        const message = String(e?.message ?? e ?? "批改失败");
        setGradeError((prev) => ({ ...prev, [question.id]: message }));
        throw e;
      } finally {
        if (shouldTrackBusy) {
          setGradeBusy((prev) => ({ ...prev, [question.id]: false }));
        }
      }
    },
    [evaluateQuestion, setGrading],
  );

  const submitQuiz = useCallback(async () => {
    if (!quiz || quiz.questions.length === 0 || quizSubmitBusy) return;

    setQuizSubmitError("");
    setQuizSubmitBusy(true);
    try {
      const nextByQuestionId: Record<string, PracticeQuestionProgress> = {
        ...(quiz.progress?.byQuestionId ?? {}),
      };
      const failures: string[] = [];

      for (const [index, question] of quiz.questions.entries()) {
        const progress = nextByQuestionId[question.id];
        try {
          const grading = await submitQuestion(quiz.id, question, progress, {
            allowBlank: true,
            reuseExisting: true,
          });
          nextByQuestionId[question.id] = {
            ...(progress ?? {}),
            grading,
            submittedAt: grading.gradedAt,
          };
        } catch (error: any) {
          failures.push(
            `第${index + 1}题：${String(error?.message ?? error ?? "批改失败")}`,
          );
        }
      }

      if (failures.length > 0) {
        setQuizSubmitError(`整体提交未完成：${failures.join("；")}`);
        return;
      }

      setQuizGrading(
        quiz.id,
        buildPracticeQuizGrading(quiz.questions, nextByQuestionId),
      );
    } finally {
      setQuizSubmitBusy(false);
    }
  }, [quiz, quizSubmitBusy, setQuizGrading, submitQuestion]);

  const onGenerate = async () => {
    const t = topic.trim();
    if (!t) {
      setGenError("请输入主题");
      return;
    }
    if (totalQuestionCount <= 0) {
      setGenError("请至少输入 1 道题");
      return;
    }
    setGenError("");
    if (!isTauri()) {
      setGenError(
        "当前在浏览器预览模式，无法调用后端生成题目。请在 App 内运行。",
      );
      return;
    }
    if (genBusy) return;
    setGenBusy(true);
    try {
      const shouldAutoRenameQuiz =
        quiz.questions.length === 0 &&
        (!quiz.title.trim() || quiz.title.trim() === "新练习");
      const generated = await generatePracticeQuiz(invoke as any, {
        options: {
          topic: t,
          difficulty,
          counts: questionCounts,
        },
      });
      replaceGeneratedQuestions(quiz.id, generated.questions);
      if (shouldAutoRenameQuiz) {
        const nextTitle = await generatePracticeTitle(invoke as any, {
          topic: t,
          questions: generated.questions,
          fallbackTitle: generated.title,
        });
        if (nextTitle) renameQuiz(quiz.id, nextTitle);
      }
      setTopic("");
    } catch (e: any) {
      setGenError(String(e?.message ?? e ?? "生成失败"));
    } finally {
      setGenBusy(false);
    }
  };

  const renderQuestion = (
    q: PracticeQuestion,
    index: number,
    quiz2: PracticeQuiz,
  ) => {
    const progress = quiz2.progress?.byQuestionId?.[q.id];
    const grading = progress?.grading;
    const answer = progress?.answer;
    const submitted = Boolean(progress?.submittedAt);

    const busy = Boolean(gradeBusy[q.id]);
    const err = gradeError[q.id] || "";
    const chatCopyBusy = Boolean(copyQuestionToChatBusy[q.id]);

    const gradingExplanation = grading?.explanation?.trim() || "";

    const submit = async () => {
      if (busy || quizSubmitBusy) return;
      try {
        await submitQuestion(quiz2.id, q, progress, {
          allowBlank: false,
          reuseExisting: false,
        });
      } catch {
        // per-question error has already been recorded above
      }
    };

    const setChoice = (id: string) => {
      setAnswer(quiz2.id, q.id, { kind: "choice", optionId: id });
      if (submitted) clearQuestionResult(quiz2.id, q.id);
    };

    return (
      <div
        key={q.id}
        className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {index + 1}. {questionTypeLabel(q.type)}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {q.points} 分
              </div>
              <div className="no-window-drag ml-auto flex items-center gap-2">
                <button
                  type="button"
                  className={[
                    "inline-flex h-8 items-center gap-1 rounded-lg border px-3 text-xs transition-colors",
                    chatCopyBusy
                      ? "border-sky-300/50 bg-sky-500/10 text-sky-700 dark:text-sky-200"
                      : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800",
                  ].join(" ")}
                  onClick={() => void copyQuestionToChat(q)}
                  disabled={chatCopyBusy}
                  title="放入聊天输入框"
                >
                  <MessageSquareText size={14} />
                  {chatCopyBusy ? "处理中…" : "问聊天"}
                </button>
              </div>
            </div>
            <div className="mt-2 prose prose-sm max-w-none dark:prose-invert">
              <MarkdownRenderer content={q.prompt || "（题目为空）"} />
            </div>
          </div>
        </div>

        <div className="mt-3 grid gap-3">
          {q.type === "multiple_choice" ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {q.options.map((opt) => {
                const selected =
                  answer?.kind === "choice" && answer.optionId === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={[
                      "flex items-start gap-3 text-left rounded-lg border px-3 py-3 text-sm transition-colors",
                      selected
                        ? "border-indigo-500 bg-indigo-500/10 text-indigo-700 dark:text-indigo-200"
                        : "border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40 text-gray-800 dark:text-gray-100",
                    ].join(" ")}
                    onClick={() => setChoice(opt.id)}
                  >
                    <div
                      className={[
                        "mt-0.5 inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full border px-2 text-xs font-semibold",
                        selected
                          ? "border-indigo-500/40 bg-indigo-500/15 text-indigo-700 dark:text-indigo-100"
                          : "border-gray-300 bg-gray-100 text-gray-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200",
                      ].join(" ")}
                    >
                      {opt.id}
                    </div>
                    <div className="min-w-0 flex-1 leading-6 text-gray-700 dark:text-gray-200">
                      {opt.text || "（空）"}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : q.type === "qa" ? (
            <textarea
              className="w-full min-h-[120px] rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              value={answer?.kind === "text" ? answer.text : ""}
              onChange={(e) => {
                setAnswer(quiz2.id, q.id, {
                  kind: "text",
                  text: e.target.value,
                });
                if (submitted) clearQuestionResult(quiz2.id, q.id);
              }}
              placeholder="在这里作答…"
            />
          ) : (
            <div className="grid gap-2">
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900/60">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    笔刷
                  </span>
                  <select
                    className="h-8 w-[136px] max-w-full rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-900 outline-none transition-colors focus:border-indigo-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                    value={inkDrawBrushId}
                    onChange={(e) => {
                      setInkDrawBrushId(e.target.value);
                      setInkUseEraser(false);
                    }}
                  >
                    <optgroup label="画笔">
                      {DRAWING_BRUSH_PRESETS.map((brush) => (
                        <option key={brush.id} value={brush.id}>
                          {getInkBrushMenuLabel(brush)}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <InkBrushPreview
                    brush={activeInkBrush}
                    color={inkUseEraser ? "#111827" : inkPenColor}
                    width={56}
                    height={24}
                  />
                  <button
                    type="button"
                    className={[
                      "h-8 rounded-md border px-2 text-xs transition-colors",
                      inkUseEraser
                        ? "border-indigo-400 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-100"
                        : "border-gray-200 bg-white text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800",
                    ].join(" ")}
                    onClick={() => setInkUseEraser((prev) => !prev)}
                    disabled={!ERASER_BRUSH_PRESET}
                  >
                    橡皮
                  </button>
                  <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
                    粗细
                  </span>
                  <button
                    type="button"
                    className="h-8 w-8 rounded-md border border-gray-200 bg-white text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startInkSizeAdjust(-INK_SIZE_STEP);
                    }}
                    onPointerUp={stopInkSizeAdjust}
                    onPointerCancel={stopInkSizeAdjust}
                    onPointerLeave={stopInkSizeAdjust}
                    onContextMenu={(e) => e.preventDefault()}
                    aria-label="减小笔刷粗细"
                  >
                    -
                  </button>
                  <input
                    type="range"
                    min={INK_SIZE_MIN}
                    max={INK_SIZE_MAX}
                    step={INK_SIZE_STEP}
                    value={activeInkSize}
                    onInput={(e) => applyInkSize(e.currentTarget.valueAsNumber)}
                    onChange={(e) => applyInkSize(e.currentTarget.valueAsNumber)}
                    className="h-8 w-28 accent-indigo-500"
                  />
                  <button
                    type="button"
                    className="h-8 w-8 rounded-md border border-gray-200 bg-white text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startInkSizeAdjust(INK_SIZE_STEP);
                    }}
                    onPointerUp={stopInkSizeAdjust}
                    onPointerCancel={stopInkSizeAdjust}
                    onPointerLeave={stopInkSizeAdjust}
                    onContextMenu={(e) => e.preventDefault()}
                    aria-label="增大笔刷粗细"
                  >
                    +
                  </button>
                  <span className="w-10 text-right text-xs text-gray-600 dark:text-gray-300">
                    {formatInkSize(activeInkSize)}
                  </span>
                  <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
                    颜色
                  </span>
                  {INK_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={[
                        "h-7 w-7 rounded-full border transition-colors",
                        inkUseEraser
                          ? "cursor-not-allowed border-gray-200 opacity-40 dark:border-gray-700"
                          : inkPenColor === color
                            ? "border-indigo-500 ring-2 ring-indigo-200 dark:border-white/90 dark:ring-indigo-500/40"
                            : "border-gray-300 dark:border-gray-600",
                      ].join(" ")}
                      style={{ backgroundColor: color }}
                      onClick={() => setInkPenColor(color)}
                      title={`颜色 ${color}`}
                      disabled={inkUseEraser}
                    />
                  ))}
                </div>
              </div>
              <div className="h-64">
                <ScrollableInkPad
                  value={
                    answer?.kind === "ink" ? answer.ink : createEmptyInkState()
                  }
                  onChange={(nextInk) => {
                    setInkDraft(quiz2.id, q.id, nextInk, { commit: true });
                    if (submitted) clearQuestionResult(quiz2.id, q.id);
                  }}
                  template="ruled"
                  viewportClassName="scrollbar-hidden"
                  tool={activeInkBrush.tool}
                  brushId={activeInkBrush.id}
                  penColor={inkPenColor}
                  penSize={activeInkSize}
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="h-9 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm disabled:opacity-50"
              onClick={submit}
              disabled={busy || quizSubmitBusy}
            >
              {busy ? "批改中…" : "查看解答"}
            </button>
            {err ? (
              <div className="text-sm text-red-600 dark:text-red-400">
                {err}
              </div>
            ) : null}
          </div>

          {grading ? (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-500/30 dark:bg-indigo-900/20">
              <div className="text-sm font-semibold text-indigo-800 dark:text-indigo-200">
                得分：{grading.score} / {grading.maxScore}
              </div>
              {gradingExplanation ? (
                <div className="mt-2 prose prose-sm max-w-none dark:prose-invert">
                  <MarkdownRenderer content={gradingExplanation} />
                </div>
              ) : null}
              {q.type !== "multiple_choice" ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-indigo-800 dark:text-indigo-200">
                    查看参考答案
                  </summary>
                  <div className="mt-2 prose prose-sm max-w-none dark:prose-invert">
                    <MarkdownRenderer
                      content={(q as any).referenceAnswer || "（无）"}
                    />
                  </div>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  if (!quiz) {
    return (
      <div className="h-full w-full flex items-center justify-center text-gray-500 dark:text-gray-400">
        暂无练习
      </div>
    );
  }

  return (
    <div className="h-full w-full flex overflow-hidden bg-gray-50 dark:bg-gray-900">
      <aside className="w-80 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-y-auto">
        <div className="p-3 flex items-center gap-2 border-b border-gray-200 dark:border-gray-700">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex-1">
            练习
          </div>
          <button
            type="button"
            className="h-8 w-8 rounded-md bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 flex items-center justify-center"
            onClick={() => createQuiz({ title: "新练习" })}
            title="新建练习"
          >
            <Plus size={16} />
          </button>
        </div>

        <div className="p-2 grid gap-1">
          {quizzes.map((q) => (
            <div
              key={q.id}
              role="button"
              tabIndex={0}
              className={[
                "group flex items-center justify-between gap-2 rounded-lg px-3 py-2 transition-colors",
                q.id === quiz.id
                  ? "bg-indigo-500/10 text-indigo-700 dark:text-indigo-200"
                  : "text-gray-800 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-700",
              ].join(" ")}
              onClick={() => setActiveQuiz(q.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActiveQuiz(q.id);
                }
              }}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">
                  {q.title || "未命名"}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {q.questions.length} 题
                </div>
              </div>
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-md bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200 hover:text-red-600 dark:bg-gray-700/80 dark:text-gray-300 dark:hover:bg-gray-600 dark:hover:text-red-300"
                onClick={(event) => {
                  event.stopPropagation();
                  confirmDeleteQuiz(q.id, q.title);
                }}
                title="删除"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-5 grid gap-5">
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                  练习名称
                </div>
                <input
                  className="w-full min-w-0 h-10 px-3 rounded-lg border border-gray-200 bg-white text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  value={quizTitleDraft}
                  onChange={(e) => setQuizTitleDraft(e.target.value)}
                  onBlur={commitQuizTitleDraft}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitQuizTitleDraft();
                    }
                  }}
                  placeholder="输入练习名称"
                />
              </div>
              <button
                type="button"
                className="h-10 px-3 rounded-lg bg-red-500/15 text-sm text-red-600 transition-colors hover:bg-red-500/25 dark:text-red-200"
                onClick={() => confirmDeleteQuiz(quiz.id, quiz.title)}
                title="删除该练习"
              >
                删除
              </button>
            </div>

            <div className="mt-3 grid gap-3">
              <div>
                <div className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                  练习专用 Agent
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/70">
                  <div className="text-sm text-gray-900 dark:text-gray-100">
                    {practiceAgent.label || SYSTEM_PRACTICE_AGENT_LABEL}
                    <span className="ml-2 text-[11px] text-indigo-600 dark:text-indigo-300">
                      系统内置
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {practiceAgent.modelLabel
                      ? `模型：${practiceAgent.modelLabel}`
                      : "模型：未配置"}
                  </div>
                </div>
              </div>

              <div className="grid gap-2">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  AI 出题主题
                </div>
                <input
                  className="w-full h-10 px-3 rounded-lg border border-gray-200 bg-white text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="例如：线性代数 特征值与特征向量"
                />

                <div className="grid grid-cols-2 gap-2">
                  {PRACTICE_GENERATION_FIELDS.map((field) => (
                    <label
                      key={field.type}
                      className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-gray-900 dark:border-gray-700 dark:bg-gray-900/70 dark:text-gray-100"
                    >
                      <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                        {field.label}
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={20}
                        step={INK_SIZE_STEP}
                        inputMode="numeric"
                        className="w-full h-10 px-3 rounded-lg border border-gray-200 bg-white text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                        value={questionCounts[field.type]}
                        onChange={(e) =>
                          setQuestionCounts((prev) => ({
                            ...prev,
                            [field.type]: normalizePracticeGenerationCountValue(
                              e.target.value,
                              prev[field.type],
                            ),
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>

                <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                  <span>共 {totalQuestionCount} 题</span>
                  <span>每种题型可填 0-20</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <select
                    className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                    value={difficulty}
                    onChange={(e) => setDifficulty(e.target.value as any)}
                  >
                    <option value="easy">简单</option>
                    <option value="medium">中等</option>
                    <option value="hard">困难</option>
                  </select>
                  <button
                    type="button"
                    className="h-10 rounded-lg bg-indigo-600 text-sm text-white transition-colors hover:bg-indigo-500 disabled:opacity-50 flex items-center justify-center gap-2"
                    onClick={onGenerate}
                    disabled={genBusy}
                  >
                    <Wand2 size={16} />
                    {genBusy ? "生成中…" : `生成 ${totalQuestionCount} 题`}
                  </button>
                </div>

                {genError ? (
                  <div className="text-sm text-red-600 dark:text-red-400">
                    {genError}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {quiz.questions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-gray-500 dark:border-gray-700 dark:text-gray-400">
              还没有题目。请使用 AI 出题。
            </div>
          ) : (
            <div className="grid gap-4">
              {quiz.questions.map((q, i) => renderQuestion(q, i, quiz))}

              <div className="rounded-xl border border-indigo-200 bg-white p-4 shadow-sm dark:border-indigo-500/20 dark:bg-gray-800">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="text-base font-semibold text-gray-900 dark:text-gray-100">
                      整体提交练习
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      按当前整套题目汇总总分与整体批阅。
                    </div>
                  </div>
                  <button
                    type="button"
                    className="h-10 rounded-lg bg-indigo-600 px-4 text-sm text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
                    onClick={() => void submitQuiz()}
                    disabled={quizSubmitBusy}
                  >
                    {quizSubmitBusy ? "整体提交中…" : "整体提交并汇总得分"}
                  </button>
                </div>

                {quizSubmitError ? (
                  <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                    {quizSubmitError}
                  </div>
                ) : null}

                {quizGrading ? (
                  <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-500/30 dark:bg-indigo-900/20">
                    <div className="text-lg font-semibold text-indigo-800 dark:text-indigo-100">
                      总分：{quizGrading.score} / {quizGrading.maxScore}
                    </div>
                    <div className="mt-1 text-sm text-indigo-700 dark:text-indigo-200">
                      已批改 {quizGrading.gradedQuestions} /{" "}
                      {quizGrading.totalQuestions} 题
                    </div>
                    <div className="mt-3 prose prose-sm max-w-none dark:prose-invert">
                      <MarkdownRenderer content={quizGrading.explanation} />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

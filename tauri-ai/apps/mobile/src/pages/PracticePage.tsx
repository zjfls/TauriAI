import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { useLayoutSize } from "../lib/breakpoints";
import { isTauriRuntime, tauriInvoke } from "../lib/tauri";
import { clsx } from "../lib/clsx";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { RichText } from "../ui/RichText";
import { usePracticeStore } from "../../../common/src/practice/store";
import type {
  InkPoint,
  InkState,
  InkStroke,
  PracticeQuestion,
  PracticeQuestionType,
  PracticeQuiz,
} from "../../../common/src/practice/types";
import { generatePracticeQuiz, gradePracticeAnswer } from "../../../common/src/practice/llm";
import { ScrollableInkPad, createEmptyInkState } from "../../../common/src/practice/ink/ScrollableInkPad";
import { DEFAULT_INK_BRUSH_ID, INK_BRUSH_PRESETS } from "../../../common/src/practice/ink/brushes";

type InkTemplate = "blank" | "ruled" | "grid";
type PracticeAgentOption = {
  name: string;
  displayName: string;
  modelRef: string;
  modelLabel: string;
  enabled: boolean;
};

const INK_COLORS = ["#111827", "#1d4ed8", "#0f766e", "#7c3aed", "#b91c1c"] as const;
const INK_TEMPLATES: Array<{ value: InkTemplate; label: string }> = [
  { value: "ruled", label: "横线" },
  { value: "grid", label: "网格" },
  { value: "blank", label: "空白" },
];
const INK_SIZE_MIN = 1;
const INK_SIZE_MAX = 24;
const DRAWING_BRUSH_PRESETS = INK_BRUSH_PRESETS.filter((item) => item.tool !== "eraser");
const ERASER_BRUSH_PRESET = INK_BRUSH_PRESETS.find((item) => item.tool === "eraser");

function formatModelLabel(
  modelRef: string,
  providerDisplayNameById: Map<string, string>,
): string {
  const ref = String(modelRef || "").trim();
  if (!ref) return "";
  const idx = ref.indexOf("/");
  if (idx <= 0) return ref;
  const providerId = ref.slice(0, idx).trim();
  const modelName = ref.slice(idx + 1).trim();
  if (!providerId || !modelName) return ref;
  const providerLabel = providerDisplayNameById.get(providerId) || providerId;
  return `${providerLabel}/${modelName}`;
}

function drawInkSegment(ctx: CanvasRenderingContext2D, stroke: InkStroke, a: InkPoint, b: InkPoint) {
  const rawSize = typeof stroke.size === "number" && Number.isFinite(stroke.size) ? stroke.size : 1;
  const baseSize = Math.max(0.5, Math.min(64, rawSize));
  const opacity =
    typeof stroke.opacity === "number"
      ? Math.max(0.05, Math.min(1, stroke.opacity))
      : stroke.tool === "pencil"
        ? 0.65
        : 1;
  const pressureSensitivity =
    typeof stroke.pressureSensitivity === "number"
      ? Math.max(0, Math.min(1, stroke.pressureSensitivity))
      : 0;
  const pressure = Math.max(
    0.1,
    Math.min(
      1,
      (typeof b.pressure === "number" && b.pressure > 0 ? b.pressure : undefined) ??
        (typeof a.pressure === "number" && a.pressure > 0 ? a.pressure : undefined) ??
        0.5,
    ),
  );
  const lineWidth =
    stroke.tool === "eraser"
      ? Math.max(1, baseSize)
      : Math.max(
          1,
          baseSize * (1 - pressureSensitivity + pressureSensitivity * pressure),
        );

  ctx.save();
  if (stroke.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.globalAlpha = 1;
  } else {
    ctx.globalCompositeOperation = stroke.blendMode ?? "source-over";
    ctx.strokeStyle = stroke.color || "#111827";
    ctx.globalAlpha = opacity;
  }
  ctx.lineWidth = lineWidth;
  ctx.lineCap = stroke.lineCap ?? "round";
  ctx.lineJoin = stroke.lineJoin ?? "round";
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

function computeInkBounds(strokes: InkStroke[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

async function renderInkToDataUrl(ink: InkState): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const strokes = Array.isArray(ink?.strokes) ? ink.strokes : [];
  if (strokes.length === 0) return null;
  const bounds = computeInkBounds(strokes);
  if (!bounds) return null;

  const margin = 24;
  const width = Math.max(1, Math.ceil(bounds.maxX - bounds.minX + margin * 2));
  const height = Math.max(1, Math.ceil(bounds.maxY - bounds.minY + margin * 2));
  const maxEdge = Math.max(width, height);
  const scale = maxEdge > 1536 ? 1536 / maxEdge : 1;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outW / scale, outH / scale);
  ctx.translate(margin - bounds.minX, margin - bounds.minY);

  for (const stroke of strokes) {
    const points = stroke.points || [];
    if (points.length < 2) continue;
    for (let index = 1; index < points.length; index += 1) {
      drawInkSegment(ctx, stroke, points[index - 1]!, points[index]!);
    }
  }
  return canvas.toDataURL("image/png");
}

function questionTypeLabel(t: PracticeQuestionType): string {
  if (t === "multiple_choice") return "选择题";
  if (t === "calculation") return "计算题";
  if (t === "proof") return "证明题";
  return "问答题";
}

export function PracticePage() {
  const layout = useLayoutSize();

  const quizzes = usePracticeStore((s) => s.quizzes);
  const activeQuizId = usePracticeStore((s) => s.activeQuizId);
  const setActiveQuiz = usePracticeStore((s) => s.setActiveQuiz);
  const createQuiz = usePracticeStore((s) => s.createQuiz);
  const importQuiz = usePracticeStore((s) => s.importQuiz);
  const deleteQuiz = usePracticeStore((s) => s.deleteQuiz);
  const renameQuiz = usePracticeStore((s) => s.renameQuiz);
  const appendGeneratedQuestions = usePracticeStore((s) => s.appendGeneratedQuestions);
  const addQuestion = usePracticeStore((s) => s.addQuestion);
  const deleteQuestion = usePracticeStore((s) => s.deleteQuestion);
  const updateQuestion = usePracticeStore((s) => s.updateQuestion);
  const setAnswer = usePracticeStore((s) => s.setAnswer);
  const setInkDraft = usePracticeStore((s) => s.setInkDraft);
  const setGrading = usePracticeStore((s) => s.setGrading);
  const clearQuestionResult = usePracticeStore((s) => s.clearQuestionResult);

  const quiz = useMemo(
    () => quizzes.find((q) => q.id === activeQuizId) ?? quizzes[0],
    [quizzes, activeQuizId],
  );

  const [fallbackAgentName, setFallbackAgentName] = useState<string>("");
  const [agentOptions, setAgentOptions] = useState<PracticeAgentOption[]>([]);
  const [practiceAgentName, setPracticeAgentName] = useState<string>("");

  const loadConfig = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const cfg = await tauriInvoke<any>("get_app_config");
      const defaultAgent = String(cfg?.defaultAgent ?? cfg?.default_agent ?? "").trim();
      const currentAgent = String(cfg?.currentAgent ?? cfg?.current_agent ?? "").trim();
      const providerDisplayNameById = new Map<string, string>();
      const providerList: any[] = Array.isArray(cfg?.providers) ? cfg.providers : [];
      for (const p of providerList) {
        if (!p || typeof p !== "object") continue;
        const id = String((p as any).name ?? "").trim();
        if (!id) continue;
        const displayName = String((p as any).displayName ?? (p as any).display_name ?? id).trim();
        providerDisplayNameById.set(id, displayName || id);
      }
      const next: PracticeAgentOption[] = [];
      const list: any[] = Array.isArray(cfg?.agents) ? cfg.agents : [];
      for (const a of list) {
        if (!a || typeof a !== "object") continue;
        const name = String((a as any).name ?? "").trim();
        if (!name) continue;
        const displayName = String((a as any).displayName ?? (a as any).display_name ?? name).trim();
        const modelRef = String((a as any).modelRef ?? (a as any).model_ref ?? "").trim();
        const modelLabel = formatModelLabel(modelRef, providerDisplayNameById);
        const enabled = typeof (a as any).enabled === "boolean" ? Boolean((a as any).enabled) : true;
        next.push({
          name,
          displayName: displayName || name,
          modelRef,
          modelLabel,
          enabled,
        });
      }
      setAgentOptions(next);

      const enabledList = next.filter((item) => item.enabled);
      const preferred =
        (defaultAgent && next.some((item) => item.name === defaultAgent) ? defaultAgent : "") ||
        (currentAgent && next.some((item) => item.name === currentAgent) ? currentAgent : "") ||
        enabledList[0]?.name ||
        next[0]?.name ||
        "";
      if (preferred) setFallbackAgentName(preferred);
      setPracticeAgentName((prev) => {
        if (prev && next.some((item) => item.name === prev)) return prev;
        return preferred || prev;
      });
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const enabledAgentOptions = useMemo(
    () => agentOptions.filter((item) => item.enabled),
    [agentOptions],
  );
  const agentName = (practiceAgentName || fallbackAgentName || "").trim() || undefined;
  const selectedAgent = useMemo(
    () => agentOptions.find((item) => item.name === agentName),
    [agentName, agentOptions],
  );
  const agentLabel = selectedAgent?.displayName || agentName || "";

  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState("");

  const [gradeBusy, setGradeBusy] = useState<Record<string, boolean>>({});
  const [gradeError, setGradeError] = useState<Record<string, string>>({});
  const [inkDrawBrushId, setInkDrawBrushId] = useState<string>(() => {
    const preferred = DRAWING_BRUSH_PRESETS.find((item) => item.id === DEFAULT_INK_BRUSH_ID);
    return preferred?.id ?? DRAWING_BRUSH_PRESETS[0]?.id ?? DEFAULT_INK_BRUSH_ID;
  });
  const [inkUseEraser, setInkUseEraser] = useState<boolean>(false);
  const [inkPenColor, setInkPenColor] = useState<string>(INK_COLORS[0]);
  const [inkPenSize, setInkPenSize] = useState<number>(5);
  const [inkTemplate, setInkTemplate] = useState<InkTemplate>("ruled");
  const [fullscreenInkTarget, setFullscreenInkTarget] = useState<{ quizId: string; questionId: string } | null>(null);
  const activeInkBrush = useMemo(
    () =>
      (inkUseEraser ? ERASER_BRUSH_PRESET : undefined) ??
      DRAWING_BRUSH_PRESETS.find((item) => item.id === inkDrawBrushId) ??
      DRAWING_BRUSH_PRESETS[0] ??
      ERASER_BRUSH_PRESET ??
      INK_BRUSH_PRESETS[0],
    [inkUseEraser, inkDrawBrushId],
  );

  const fullscreenInkQuestion = useMemo(() => {
    if (!quiz || !fullscreenInkTarget) return null;
    if (quiz.id !== fullscreenInkTarget.quizId) return null;
    const idx = quiz.questions.findIndex((item) => item.id === fullscreenInkTarget.questionId);
    if (idx < 0) return null;
    const question = quiz.questions[idx]!;
    if (question.type !== "calculation" && question.type !== "proof") return null;
    const progress = quiz.progress?.byQuestionId?.[question.id];
    return {
      index: idx,
      question,
      answer: progress?.answer,
      submitted: Boolean(progress?.submittedAt),
    };
  }, [fullscreenInkTarget, quiz]);

  useEffect(() => {
    if (fullscreenInkTarget && !fullscreenInkQuestion) {
      setFullscreenInkTarget(null);
    }
  }, [fullscreenInkQuestion, fullscreenInkTarget]);

  const onGenerate = async () => {
    const t = topic.trim();
    if (!t) {
      setGenError("请输入主题");
      return;
    }
    setGenError("");
    if (!isTauriRuntime()) {
      setGenError("当前在浏览器预览模式，无法调用后端生成题目。请在 App 内运行。");
      return;
    }
    if (genBusy) return;
    setGenBusy(true);
    try {
      const hasExistingQuestions = quiz.questions.length > 0;
      const counts = (() => {
        if (!hasExistingQuestions) {
          return { multiple_choice: 2, calculation: 2, proof: 1, qa: 1 };
        }
        const r = Math.floor(Math.random() * 4);
        if (r === 0) return { multiple_choice: 1, calculation: 0, proof: 0, qa: 0 };
        if (r === 1) return { multiple_choice: 0, calculation: 1, proof: 0, qa: 0 };
        if (r === 2) return { multiple_choice: 0, calculation: 0, proof: 1, qa: 0 };
        return { multiple_choice: 0, calculation: 0, proof: 0, qa: 1 };
      })();

      const generated = await generatePracticeQuiz(tauriInvoke as any, {
        agentName,
        options: {
          topic: t,
          difficulty,
          counts,
        },
      });

      if (!hasExistingQuestions) {
        importQuiz(generated, { setActive: true });
        setTopic("");
      } else {
        const next = generated.questions?.[0];
        if (!next) {
          setGenError("未生成到可用题目，请重试");
          return;
        }
        appendGeneratedQuestions(quiz.id, [next]);
      }
    } catch (e: any) {
      setGenError(String(e?.message ?? e ?? "生成失败"));
    } finally {
      setGenBusy(false);
    }
  };

  const renderQuestion = (q: PracticeQuestion, index: number, quiz2: PracticeQuiz) => {
    const progress = quiz2.progress?.byQuestionId?.[q.id];
    const grading = progress?.grading;
    const answer = progress?.answer;
    const submitted = Boolean(progress?.submittedAt);

    const busy = Boolean(gradeBusy[q.id]);
    const err = gradeError[q.id] || "";

    const submit = async () => {
      setGradeError((prev) => ({ ...prev, [q.id]: "" }));

      if (q.type === "multiple_choice") {
        const optionId = answer?.kind === "choice" ? answer.optionId : "";
        const maxScore = q.points;
        const score = optionId && optionId === q.correctOptionId ? maxScore : 0;
        setGrading(quiz2.id, q.id, {
          score,
          maxScore,
          explanation: q.explanation || `正确答案：${q.correctOptionId}`,
          gradedAt: Date.now(),
        });
        return;
      }

      const text =
        answer?.kind === "text"
          ? answer.text
          : answer?.kind === "ink"
            ? answer.summaryText || ""
            : "";

      if (!isTauriRuntime()) {
        setGradeError((prev) => ({
          ...prev,
          [q.id]: "当前在浏览器预览模式，无法调用后端批改。请在 App 内运行。",
        }));
        return;
      }
      if (busy) return;

      const answerImage =
        answer?.kind === "ink"
          ? await renderInkToDataUrl(answer.ink)
          : null;

      if (!text.trim() && !answerImage) {
        setGradeError((prev) => ({
          ...prev,
          [q.id]: "请先填写总结，或在手写区作答后再提交",
        }));
        return;
      }

      setGradeBusy((prev) => ({ ...prev, [q.id]: true }));
      try {
        const res = await gradePracticeAnswer(tauriInvoke as any, {
          agentName,
          question: q,
          studentAnswer: text,
          studentAnswerImages: answerImage
            ? [{ type: "image", url: answerImage, detail: "high" }]
            : undefined,
        });
        setGrading(quiz2.id, q.id, res);
      } catch (e: any) {
        setGradeError((prev) => ({ ...prev, [q.id]: String(e?.message ?? e ?? "批改失败") }));
      } finally {
        setGradeBusy((prev) => ({ ...prev, [q.id]: false }));
      }
    };

    const setChoice = (id: string) => {
      setAnswer(quiz2.id, q.id, { kind: "choice", optionId: id });
      if (submitted) clearQuestionResult(quiz2.id, q.id);
    };

    return (
      <div key={q.id} className="rounded-2xl border border-white/10 bg-white/5 p-4 overflow-x-hidden">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-white">
                {index + 1}. {questionTypeLabel(q.type)}
              </div>
              <div className="text-xs text-white/50">{q.points} 分</div>
            </div>
            <div className="mt-2 text-sm text-white/90 max-w-full overflow-x-hidden">
              <RichText content={q.prompt || "（题目为空）"} />
            </div>

            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-white/80">编辑题目</summary>
              <div className="mt-3 grid gap-3">
                <div>
                  <div className="text-xs text-white/50 mb-1">题干（Markdown）</div>
                  <textarea
                    className="w-full min-h-[120px] rounded-xl bg-black/20 border border-white/10 px-3 py-2 text-[16px] leading-5 outline-none focus:border-indigo-400"
                    value={q.prompt}
                    onChange={(e) => updateQuestion(quiz2.id, q.id, { prompt: e.target.value } as any)}
                    placeholder="输入题干…"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-white/50 mb-1">分值</div>
                    <Input
                      type="number"
                      value={String(q.points)}
                      onChange={(e) =>
                        updateQuestion(quiz2.id, q.id, { points: Math.max(1, Number(e.target.value) || 1) } as any)
                      }
                    />
                  </div>
                  <div />
                </div>

                {q.type === "multiple_choice" ? (
                  <div className="grid gap-2">
                    <div className="text-xs text-white/50">选项</div>
                    <div className="grid gap-2">
                      {q.options.map((opt, oi) => (
                        <div key={opt.id} className="flex items-center gap-2">
                          <div className="w-6 text-sm font-semibold text-white/70">{opt.id}</div>
                          <Input
                            value={opt.text}
                            onChange={(e) => {
                              const next = q.options.map((o, idx) => (idx === oi ? { ...o, text: e.target.value } : o));
                              updateQuestion(quiz2.id, q.id, { options: next } as any);
                            }}
                            placeholder="选项内容…"
                          />
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="text-xs text-white/50 mb-1">正确选项</div>
                        <select
                          className="h-10 w-full rounded-md bg-white/5 border border-white/10 px-3 text-[16px] outline-none focus:border-indigo-400"
                          value={q.correctOptionId}
                          onChange={(e) => updateQuestion(quiz2.id, q.id, { correctOptionId: e.target.value } as any)}
                        >
                          {q.options.map((opt) => (
                            <option key={opt.id} value={opt.id}>
                              {opt.id}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div />
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="text-xs text-white/50 mb-1">参考答案（Markdown）</div>
                    <textarea
                      className="w-full min-h-[120px] rounded-xl bg-black/20 border border-white/10 px-3 py-2 text-[16px] leading-5 outline-none focus:border-indigo-400"
                      value={(q as any).referenceAnswer || ""}
                      onChange={(e) => updateQuestion(quiz2.id, q.id, { referenceAnswer: e.target.value } as any)}
                      placeholder="输入参考答案…"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </div>
                )}

                <div>
                  <div className="text-xs text-white/50 mb-1">讲解（Markdown，可选）</div>
                  <textarea
                    className="w-full min-h-[120px] rounded-xl bg-black/20 border border-white/10 px-3 py-2 text-[16px] leading-5 outline-none focus:border-indigo-400"
                    value={q.explanation || ""}
                    onChange={(e) => updateQuestion(quiz2.id, q.id, { explanation: e.target.value } as any)}
                    placeholder="输入讲解…"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
              </div>
            </details>
          </div>

          <button
            type="button"
            className="h-8 w-8 rounded-md bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/70 hover:text-white"
            onClick={() => deleteQuestion(quiz2.id, q.id)}
            title="删除题目"
          >
            <Trash2 size={16} />
          </button>
        </div>

        <div className="mt-3 grid gap-3">
          {q.type === "multiple_choice" ? (
            <div className="grid gap-2">
              {q.options.map((opt) => {
                const selected = answer?.kind === "choice" && answer.optionId === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={clsx(
                      "text-left rounded-xl border px-3 py-2 text-sm transition-colors overflow-x-hidden",
                      selected
                        ? "border-indigo-400 bg-indigo-400/10 text-white"
                        : "border-white/10 bg-black/20 hover:bg-white/5 text-white/90",
                    )}
                    onClick={() => setChoice(opt.id)}
                  >
                    <div className="font-semibold">{opt.id}</div>
                    <RichText content={opt.text || "（空）"} className="text-white/80" />
                  </button>
                );
              })}
            </div>
          ) : q.type === "qa" ? (
            <textarea
              className="w-full min-h-[120px] rounded-xl bg-black/20 border border-white/10 px-3 py-2 text-[16px] leading-5 outline-none focus:border-indigo-400"
              value={answer?.kind === "text" ? answer.text : ""}
              onChange={(e) => {
                setAnswer(quiz2.id, q.id, { kind: "text", text: e.target.value });
                if (submitted) clearQuestionResult(quiz2.id, q.id);
              }}
              placeholder="在这里作答…"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="text-xs text-white/50">手写作答</div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="h-8 px-3 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-white/80"
                    onClick={() => setFullscreenInkTarget({ quizId: quiz2.id, questionId: q.id })}
                  >
                    全屏作答
                  </button>
                </div>
              </div>
              <div className="h-56">
                <ScrollableInkPad
                  value={answer?.kind === "ink" ? answer.ink : createEmptyInkState()}
                  onChange={(nextInk) => {
                    setInkDraft(quiz2.id, q.id, nextInk, {
                      summaryText: answer?.kind === "ink" ? answer.summaryText : "",
                      commit: true,
                    });
                    if (submitted) clearQuestionResult(quiz2.id, q.id);
                  }}
                  viewportClassName="border-white/15"
                  template={inkTemplate}
                  tool={activeInkBrush.tool}
                  brushId={activeInkBrush.id}
                  penColor={inkPenColor}
                  penSize={inkPenSize}
                />
              </div>
              <textarea
                className="w-full min-h-[96px] rounded-xl bg-black/20 border border-white/10 px-3 py-2 text-[16px] leading-5 outline-none focus:border-indigo-400"
                value={answer?.kind === "ink" ? answer.summaryText || "" : ""}
                onChange={(e) => {
                  const ink = answer?.kind === "ink" ? answer.ink : createEmptyInkState();
                  setInkDraft(quiz2.id, q.id, ink, { summaryText: e.target.value, commit: true });
                  if (submitted) clearQuestionResult(quiz2.id, q.id);
                }}
                placeholder="答案总结（用于批改，可写关键步骤/结论）…"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className="h-9 px-3 rounded-xl bg-indigo-500 hover:bg-indigo-400 text-white text-sm disabled:opacity-50"
              onClick={submit}
              disabled={busy}
            >
              {busy ? "批改中…" : "提交并查看讲解/得分"}
            </button>
            {grading ? (
              <button
                type="button"
                className="h-9 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 text-sm"
                onClick={() => clearQuestionResult(quiz2.id, q.id)}
              >
                重新作答
              </button>
            ) : null}
            {err ? <div className="text-sm text-red-300">{err}</div> : null}
          </div>

          {grading ? (
            <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/10 p-3 overflow-x-hidden">
              <div className="text-sm font-semibold text-indigo-100">
                得分：{grading.score} / {grading.maxScore}
              </div>
              <div className="mt-2 text-sm text-white/90 max-w-full overflow-x-hidden">
                <RichText content={grading.explanation || "（无讲解）"} />
              </div>
              {q.type !== "multiple_choice" ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-indigo-100">查看参考答案</summary>
                  <div className="mt-2 text-sm text-white/90 max-w-full overflow-x-hidden">
                    <RichText content={(q as any).referenceAnswer || "（无）"} />
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
      <div className="h-full w-full flex items-center justify-center text-white/50">暂无练习</div>
    );
  }

  return (
    <>
      <div className="h-full w-full flex flex-col overflow-x-hidden overflow-y-hidden">
        {layout === "compact" ? (
          <div className="safe-top border-b border-white/10 bg-white/5">
            <div className="h-12 flex items-center gap-2 px-3">
              <select
                className="h-9 flex-1 min-w-0 rounded-md bg-white/5 border border-white/10 px-3 text-[16px] outline-none focus:border-indigo-400"
                value={quiz.id}
                onChange={(e) => setActiveQuiz(e.target.value)}
              >
                {quizzes.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.title || "未命名"}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => createQuiz({ title: "新练习" })}
                title="新建练习"
              >
                <Plus size={16} />
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-none overflow-x-hidden">
          <div className="px-3 py-4 grid gap-4 max-w-full">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 overflow-x-hidden">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <Input value={quiz.title} onChange={(e) => renameQuiz(quiz.id, e.target.value)} />
                  <div className="mt-2 grid gap-2">
                    <div className="text-xs text-white/50">练习 Agent / 模型</div>
                    {enabledAgentOptions.length > 0 ? (
                      <select
                        className="h-10 rounded-md bg-white/5 border border-white/10 px-3 text-[16px] outline-none focus:border-indigo-400"
                        value={agentName || ""}
                        onChange={(e) => setPracticeAgentName(e.target.value)}
                      >
                        {enabledAgentOptions.map((item) => (
                          <option key={item.name} value={item.name}>
                            {item.displayName || item.name}
                            {item.modelLabel ? ` (${item.modelLabel})` : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="text-xs text-red-300">未找到可用 Agent，请先在设置中配置模型</div>
                    )}
                    <div className="text-xs text-white/50">
                      当前：{agentLabel || "（未配置）"}
                      {selectedAgent?.modelLabel ? ` · ${selectedAgent.modelLabel}` : ""}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="h-10 px-3 rounded-xl bg-red-500/20 hover:bg-red-500/30 text-red-200 text-sm"
                  onClick={() => deleteQuiz(quiz.id)}
                >
                  删除
                </button>
              </div>

              <div className="mt-3 grid gap-2">
                <div className="text-xs text-white/50">AI 出题主题</div>
                <Input
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="例如：线性代数 特征值与特征向量"
                />
                <div className="grid grid-cols-2 gap-2">
                  <select
                    className="h-10 rounded-md bg-white/5 border border-white/10 px-3 text-[16px] outline-none focus:border-indigo-400"
                    value={difficulty}
                    onChange={(e) => setDifficulty(e.target.value as any)}
                  >
                    <option value="easy">简单</option>
                    <option value="medium">中等</option>
                    <option value="hard">困难</option>
                  </select>
                  <button
                    type="button"
                    className="h-10 rounded-md bg-indigo-500 hover:bg-indigo-400 text-white text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                    onClick={onGenerate}
                    disabled={genBusy}
                  >
                    <Wand2 size={16} />
                    {genBusy ? "生成中…" : quiz.questions.length === 0 ? "生成 6 题" : "生成题目"}
                  </button>
                </div>
                {genError ? <div className="text-sm text-red-300">{genError}</div> : null}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                className="h-9 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 text-sm"
                onClick={() => addQuestion(quiz.id, "multiple_choice")}
              >
                + 选择题
              </button>
              <button
                type="button"
                className="h-9 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 text-sm"
                onClick={() => addQuestion(quiz.id, "calculation")}
              >
                + 计算题
              </button>
              <button
                type="button"
                className="h-9 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 text-sm"
                onClick={() => addQuestion(quiz.id, "proof")}
              >
                + 证明题
              </button>
              <button
                type="button"
                className="h-9 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/80 text-sm"
                onClick={() => addQuestion(quiz.id, "qa")}
              >
                + 问答题
              </button>
            </div>

            {quiz.questions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/15 p-8 text-center text-white/50">
                还没有题目。你可以使用 AI 出题，或手动添加题目。
              </div>
            ) : (
              <div className="grid gap-3">
                {quiz.questions.map((q, i) => renderQuestion(q, i, quiz))}
              </div>
            )}
          </div>
        </div>
      </div>

      {fullscreenInkQuestion ? (
        <div className="fixed inset-0 z-[90] bg-[#0b1220] text-white flex flex-col overflow-hidden">
          <div className="safe-top border-b border-white/10 bg-white/5">
            <div className="h-12 px-3 flex items-center justify-between gap-3">
              <div className="min-w-0 text-sm font-semibold truncate">
                {fullscreenInkQuestion.index + 1}. {questionTypeLabel(fullscreenInkQuestion.question.type)} · 全屏作答
              </div>
              <button
                type="button"
                className="h-8 px-3 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-sm"
                onClick={() => setFullscreenInkTarget(null)}
              >
                完成
              </button>
            </div>
          </div>

          <div className="px-3 py-2 border-b border-white/10 bg-black/20">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-white/60">笔刷</span>
              <select
                className="h-8 rounded-md bg-white/5 border border-white/10 px-2 text-[12px] outline-none focus:border-indigo-400"
                value={inkDrawBrushId}
                onChange={(e) => {
                  setInkDrawBrushId(e.target.value);
                  setInkUseEraser(false);
                }}
              >
                {DRAWING_BRUSH_PRESETS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={clsx(
                  "h-8 px-2 rounded-md text-xs border",
                  inkUseEraser
                    ? "border-indigo-300 bg-indigo-500/20 text-indigo-100"
                    : "border-white/15 bg-white/5 text-white/80",
                )}
                onClick={() => setInkUseEraser((prev) => !prev)}
                disabled={!ERASER_BRUSH_PRESET}
                title="橡皮"
              >
                橡皮
              </button>

              <span className="ml-1 text-xs text-white/60">粗细</span>
              <input
                type="range"
                min={INK_SIZE_MIN}
                max={INK_SIZE_MAX}
                step={1}
                value={inkPenSize}
                onChange={(e) => setInkPenSize(Number(e.target.value))}
                className="h-8 w-28 accent-indigo-400"
              />
              <span className="text-xs text-white/70 w-6 text-right">{inkPenSize}</span>

              <span className="ml-1 text-xs text-white/60">颜色</span>
              {INK_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={clsx(
                    "h-7 w-7 rounded-full border transition-colors",
                    inkPenColor === color ? "border-white/90" : "border-white/25",
                  )}
                  style={{ backgroundColor: color }}
                  onClick={() => setInkPenColor(color)}
                  title={`颜色 ${color}`}
                />
              ))}

              <span className="ml-1 text-xs text-white/60">纸张</span>
              {INK_TEMPLATES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={clsx(
                    "h-7 px-2 rounded-md text-xs border",
                    inkTemplate === item.value
                      ? "border-indigo-300 bg-indigo-500/20 text-indigo-100"
                      : "border-white/15 bg-white/5 text-white/80",
                  )}
                  onClick={() => setInkTemplate(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="px-3 py-2 border-b border-white/10 bg-black/15">
            <div className="text-xs text-white/60">题目</div>
            <div className="mt-1 max-h-[26vh] overflow-y-auto text-sm text-white/90 max-w-full overflow-x-hidden">
              <RichText content={fullscreenInkQuestion.question.prompt || "（题目为空）"} />
            </div>
          </div>

          <div className="flex-1 min-h-0 px-3 py-3 overflow-hidden">
            <ScrollableInkPad
              className="h-full"
              value={fullscreenInkQuestion.answer?.kind === "ink" ? fullscreenInkQuestion.answer.ink : createEmptyInkState()}
              onChange={(nextInk) => {
                setInkDraft(quiz.id, fullscreenInkQuestion.question.id, nextInk, {
                  summaryText: fullscreenInkQuestion.answer?.kind === "ink" ? fullscreenInkQuestion.answer.summaryText : "",
                  commit: true,
                });
                if (fullscreenInkQuestion.submitted) clearQuestionResult(quiz.id, fullscreenInkQuestion.question.id);
              }}
              viewportClassName="border-white/15"
              template={inkTemplate}
              tool={activeInkBrush.tool}
              brushId={activeInkBrush.id}
              penColor={inkPenColor}
              penSize={inkPenSize}
            />
          </div>

          <div
            className="border-t border-white/10 bg-black/20 px-3 pt-2"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
          >
            <div className="text-xs text-white/60 mb-1">答案总结（用于批改）</div>
            <textarea
              className="w-full min-h-[92px] rounded-xl bg-black/20 border border-white/10 px-3 py-2 text-[16px] leading-5 outline-none focus:border-indigo-400"
              value={fullscreenInkQuestion.answer?.kind === "ink" ? fullscreenInkQuestion.answer.summaryText || "" : ""}
              onChange={(e) => {
                const ink =
                  fullscreenInkQuestion.answer?.kind === "ink"
                    ? fullscreenInkQuestion.answer.ink
                    : createEmptyInkState();
                setInkDraft(quiz.id, fullscreenInkQuestion.question.id, ink, {
                  summaryText: e.target.value,
                  commit: true,
                });
                if (fullscreenInkQuestion.submitted) clearQuestionResult(quiz.id, fullscreenInkQuestion.question.id);
              }}
              placeholder="可写关键步骤/结论，方便自动批改…"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

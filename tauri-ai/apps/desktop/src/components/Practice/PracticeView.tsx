import { useMemo, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { Plus, Wand2 } from "lucide-react";
import { useConfigStore } from "../../stores/configStore";
import { resolvePracticeAgentPresentation, SYSTEM_PRACTICE_AGENT_LABEL } from "../../../../common/src/agentUtils";
import { MarkdownRenderer } from "../Chat/MarkdownRenderer";
import { usePracticeStore } from "../../../../common/src/practice/store";
import type { PracticeQuestion, PracticeQuestionType, PracticeQuiz } from "../../../../common/src/practice/types";
import { generatePracticeQuiz, generatePracticeTitle, gradePracticeAnswer } from "../../../../common/src/practice/llm";
import {
  DEFAULT_PRACTICE_GENERATION_COUNTS,
  PRACTICE_GENERATION_FIELDS,
  normalizePracticeGenerationCountValue,
  totalPracticeGenerationCounts,
} from "../../../../common/src/practice/generation";
import { ScrollableInkPad, createEmptyInkState } from "../../../../common/src/practice/ink/ScrollableInkPad";

function questionTypeLabel(t: PracticeQuestionType): string {
  if (t === "multiple_choice") return "选择题";
  if (t === "calculation") return "计算题";
  if (t === "proof") return "证明题";
  return "问答题";
}

export function PracticeView() {
  const quizzes = usePracticeStore((s) => s.quizzes);
  const activeQuizId = usePracticeStore((s) => s.activeQuizId);
  const setActiveQuiz = usePracticeStore((s) => s.setActiveQuiz);
  const createQuiz = usePracticeStore((s) => s.createQuiz);
  const deleteQuiz = usePracticeStore((s) => s.deleteQuiz);
  const renameQuiz = usePracticeStore((s) => s.renameQuiz);

  const appendGeneratedQuestions = usePracticeStore((s) => s.appendGeneratedQuestions);
  const setAnswer = usePracticeStore((s) => s.setAnswer);
  const setInkDraft = usePracticeStore((s) => s.setInkDraft);
  const setGrading = usePracticeStore((s) => s.setGrading);
  const clearQuestionResult = usePracticeStore((s) => s.clearQuestionResult);

  const config = useConfigStore((s) => s.config);
  const practiceAgent = useMemo(() => resolvePracticeAgentPresentation(config), [config]);

  const quiz = useMemo(
    () => quizzes.find((q) => q.id === activeQuizId) ?? quizzes[0],
    [quizzes, activeQuizId],
  );

  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string>("");
  const [questionCounts, setQuestionCounts] = useState(DEFAULT_PRACTICE_GENERATION_COUNTS);

  const totalQuestionCount = useMemo(() => totalPracticeGenerationCounts(questionCounts), [questionCounts]);

  const [gradeBusy, setGradeBusy] = useState<Record<string, boolean>>({});
  const [gradeError, setGradeError] = useState<Record<string, string>>({});

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
      setGenError("当前在浏览器预览模式，无法调用后端生成题目。请在 App 内运行。");
      return;
    }
    if (genBusy) return;
    setGenBusy(true);
    try {
      const shouldAutoRenameQuiz =
        quiz.questions.length === 0 && (!quiz.title.trim() || quiz.title.trim() === "新练习");
      const generated = await generatePracticeQuiz(invoke as any, {
        options: {
          topic: t,
          difficulty,
          counts: questionCounts,
        },
      });
      appendGeneratedQuestions(quiz.id, generated.questions);
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

      if (!text.trim()) {
        setGradeError((prev) => ({ ...prev, [q.id]: "请先写一句总结/关键步骤（用于批改）" }));
        return;
      }
      if (!isTauri()) {
        setGradeError((prev) => ({
          ...prev,
          [q.id]: "当前在浏览器预览模式，无法调用后端批改。请在 App 内运行。",
        }));
        return;
      }
      if (busy) return;

      setGradeBusy((prev) => ({ ...prev, [q.id]: true }));
      try {
        const res = await gradePracticeAnswer(invoke as any, {
          question: q,
          studentAnswer: text,
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
      <div
        key={q.id}
        className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {index + 1}. {questionTypeLabel(q.type)}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{q.points} 分</div>
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
                const selected = answer?.kind === "choice" && answer.optionId === opt.id;
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
                setAnswer(quiz2.id, q.id, { kind: "text", text: e.target.value });
                if (submitted) clearQuestionResult(quiz2.id, q.id);
              }}
              placeholder="在这里作答…"
            />
          ) : (
            <>
              <div className="h-64">
                <ScrollableInkPad
                  value={
                    answer?.kind === "ink"
                      ? answer.ink
                      : createEmptyInkState()
                  }
                  onChange={(nextInk) => {
                    setInkDraft(quiz2.id, q.id, nextInk, {
                      summaryText: answer?.kind === "ink" ? answer.summaryText : "",
                      commit: true,
                    });
                    if (submitted) clearQuestionResult(quiz2.id, q.id);
                  }}
                  template="ruled"
                />
              </div>
              <textarea
                className="w-full min-h-[100px] rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                value={answer?.kind === "ink" ? answer.summaryText || "" : ""}
                onChange={(e) => {
                  const ink =
                    answer?.kind === "ink"
                      ? answer.ink
                      : createEmptyInkState();
                  setInkDraft(quiz2.id, q.id, ink, { summaryText: e.target.value, commit: true });
                  if (submitted) clearQuestionResult(quiz2.id, q.id);
                }}
                placeholder="答案总结（用于批改，可写关键步骤/结论）…"
              />
            </>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="h-9 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm disabled:opacity-50"
              onClick={submit}
              disabled={busy}
            >
              {busy ? "批改中…" : "提交并查看讲解/得分"}
            </button>
            {grading ? (
              <button
                type="button"
                className="h-9 px-3 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-800 text-sm dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-100"
                onClick={() => clearQuestionResult(quiz2.id, q.id)}
              >
                重新作答
              </button>
            ) : null}
            {err ? <div className="text-sm text-red-600 dark:text-red-400">{err}</div> : null}
          </div>

          {grading ? (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 dark:border-indigo-500/30 dark:bg-indigo-900/20">
              <div className="text-sm font-semibold text-indigo-800 dark:text-indigo-200">
                得分：{grading.score} / {grading.maxScore}
              </div>
              <div className="mt-2 prose prose-sm max-w-none dark:prose-invert">
                <MarkdownRenderer content={grading.explanation || "（无讲解）"} />
              </div>
              {q.type !== "multiple_choice" ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-indigo-800 dark:text-indigo-200">
                    查看参考答案
                  </summary>
                  <div className="mt-2 prose prose-sm max-w-none dark:prose-invert">
                    <MarkdownRenderer content={(q as any).referenceAnswer || "（无）"} />
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
            <button
              key={q.id}
              type="button"
              className={[
                "w-full text-left px-3 py-2 rounded-lg transition-colors",
                (q.id === quiz.id)
                  ? "bg-indigo-500/10 text-indigo-700 dark:text-indigo-200"
                  : "hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-100",
              ].join(" ")}
              onClick={() => setActiveQuiz(q.id)}
            >
              <div className="text-sm font-medium truncate">{q.title || "未命名"}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {q.questions.length} 题
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-5 grid gap-5">
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center gap-3">
              <input
                className="flex-1 min-w-0 h-10 px-3 rounded-lg border border-gray-200 bg-white text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                value={quiz.title}
                onChange={(e) => renameQuiz(quiz.id, e.target.value)}
              />
              <button
                type="button"
                className="h-10 px-3 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm"
                onClick={() => deleteQuiz(quiz.id)}
                title="删除该练习"
              >
                删除
              </button>
            </div>

            <div className="mt-3 text-sm text-gray-600 dark:text-gray-300">
              批改/出题使用 Agent：{practiceAgent.label || SYSTEM_PRACTICE_AGENT_LABEL}
              {practiceAgent.modelLabel ? ` · ${practiceAgent.modelLabel}` : ""}
            </div>

            <div className="mt-4 grid grid-cols-12 gap-2 items-end">
              <div className="col-span-12">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">AI 出题主题</label>
                <input
                  className="w-full h-10 px-3 rounded-lg border border-gray-200 bg-white text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="例如：线性代数 特征值与特征向量"
                />
              </div>
              {PRACTICE_GENERATION_FIELDS.map((field) => (
                <div key={field.type} className="col-span-3">
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{field.label}</label>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    step={1}
                    inputMode="numeric"
                    className="w-full h-10 px-3 rounded-lg border border-gray-200 bg-white text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                    value={questionCounts[field.type]}
                    onChange={(e) =>
                      setQuestionCounts((prev) => ({
                        ...prev,
                        [field.type]: normalizePracticeGenerationCountValue(e.target.value, prev[field.type]),
                      }))
                    }
                  />
                </div>
              ))}
              <div className="col-span-8">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">难度</label>
                <select
                  className="w-full h-10 px-3 rounded-lg border border-gray-200 bg-white text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value as any)}
                >
                  <option value="easy">简单</option>
                  <option value="medium">中等</option>
                  <option value="hard">困难</option>
                </select>
              </div>
              <div className="col-span-4 flex justify-end">
                <button
                  type="button"
                  className="h-10 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm flex items-center gap-2 disabled:opacity-50"
                  onClick={onGenerate}
                  disabled={genBusy}
                >
                  <Wand2 size={16} />
                  {genBusy ? "生成中…" : `生成 ${totalQuestionCount} 题`}
                </button>
              </div>
              <div className="col-span-12 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>共 {totalQuestionCount} 题</span>
                <span>每种题型可填 0-20</span>
              </div>
              {genError ? (
                <div className="col-span-12 text-sm text-red-600 dark:text-red-400">{genError}</div>
              ) : null}
            </div>
          </div>


          {quiz.questions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-gray-500 dark:border-gray-700 dark:text-gray-400">
              还没有题目。请使用 AI 出题。
            </div>
          ) : (
            <div className="grid gap-4">
              {quiz.questions.map((q, i) => renderQuestion(q, i, quiz))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

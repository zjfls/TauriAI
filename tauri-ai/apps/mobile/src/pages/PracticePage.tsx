import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { useLayoutSize } from "../lib/breakpoints";
import { isTauriRuntime, tauriInvoke } from "../lib/tauri";
import { clsx } from "../lib/clsx";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { RichText } from "../ui/RichText";
import { usePracticeStore } from "../../../common/src/practice/store";
import type { PracticeQuestion, PracticeQuestionType, PracticeQuiz } from "../../../common/src/practice/types";
import { generatePracticeQuiz, gradePracticeAnswer } from "../../../common/src/practice/llm";
import { ScrollableInkPad, createEmptyInkState } from "../../../common/src/practice/ink/ScrollableInkPad";

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
  const [agentLabels, setAgentLabels] = useState<Record<string, string>>({});

  const loadConfig = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const cfg = await tauriInvoke<any>("get_app_config");
      const def = String(cfg?.defaultAgent ?? cfg?.default_agent ?? "").trim();
      if (def) setFallbackAgentName(def);

      const next: Record<string, string> = {};
      const list: any[] = Array.isArray(cfg?.agents) ? cfg.agents : [];
      for (const a of list) {
        if (!a || typeof a !== "object") continue;
        const name = String((a as any).name ?? "").trim();
        if (!name) continue;
        const displayName = String((a as any).displayName ?? (a as any).display_name ?? name).trim();
        next[name] = displayName || name;
      }
      setAgentLabels(next);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const agentName = fallbackAgentName || undefined;
  const agentLabel = agentName ? agentLabels[agentName] || agentName : "";

  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState("");

  const [gradeBusy, setGradeBusy] = useState<Record<string, boolean>>({});
  const [gradeError, setGradeError] = useState<Record<string, string>>({});

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
      const generated = await generatePracticeQuiz(tauriInvoke as any, {
        agentName,
        options: {
          topic: t,
          difficulty,
          counts: { multiple_choice: 2, calculation: 2, proof: 1, qa: 1 },
        },
      });
      importQuiz(generated, { setActive: true });
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
      if (!isTauriRuntime()) {
        setGradeError((prev) => ({
          ...prev,
          [q.id]: "当前在浏览器预览模式，无法调用后端批改。请在 App 内运行。",
        }));
        return;
      }
      if (busy) return;

      setGradeBusy((prev) => ({ ...prev, [q.id]: true }));
      try {
        const res = await gradePracticeAnswer(tauriInvoke as any, {
          agentName,
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
                    <div className="text-white/80 break-words">{opt.text || "（空）"}</div>
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
                  template="ruled"
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
                <div className="mt-1 text-xs text-white/50">
                  批改/出题使用 Agent：{agentLabel || "（未配置）"}
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
                  {genBusy ? "生成中…" : "生成 6 题"}
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
  );
}


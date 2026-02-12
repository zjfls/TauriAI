import { extractJsonCandidates, safeJsonParse } from "./json";
import type {
  PracticeGrading,
  PracticeQuestion,
  PracticeQuestionType,
  PracticeQuiz,
} from "./types";

export type LlmInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

type MobileChatMessage = { role: string; content: string };

function now(): number {
  return Date.now();
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function stripForLog(text: string): string {
  const s = String(text ?? "");
  const max = 2400;
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(truncated)`;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isQuestionType(v: unknown): v is PracticeQuestionType {
  return v === "multiple_choice" || v === "calculation" || v === "proof" || v === "qa";
}

function normalizeQuestionType(v: unknown): PracticeQuestionType | null {
  if (isQuestionType(v)) return v;
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!s) return null;

  if (s === "multiple choice" || s === "multiple-choice" || s === "mcq" || s === "choice") {
    return "multiple_choice";
  }
  if (s === "calc" || s === "cal" || s === "calculate" || s === "computation" || s === "compute") {
    return "calculation";
  }
  if (s === "prove") return "proof";

  if (s === "选择题") return "multiple_choice";
  if (s === "计算题") return "calculation";
  if (s === "证明题") return "proof";
  if (s === "问答题" || s === "简答题") return "qa";

  return null;
}

function normalizeQuestion(raw: any, index: number): PracticeQuestion | null {
  const type =
    normalizeQuestionType(raw?.type) ??
    normalizeQuestionType(raw?.questionType) ??
    normalizeQuestionType(raw?.question_type);
  if (!type) return null;
  const id = asString(raw?.id).trim() || newId(`q${index + 1}`);
  const prompt =
    asString(raw?.prompt) ||
    asString(raw?.question) ||
    asString(raw?.stem) ||
    asString(raw?.content);
  const points = Math.max(
    1,
    Math.round(asNumber(raw?.points ?? raw?.score ?? raw?.maxScore, type === "multiple_choice" ? 5 : 10)),
  );
  const explanation = asString(raw?.explanation);

  if (type === "multiple_choice") {
    const optionsRaw = raw?.options;
    let options: { id: string; text: string }[] = [];
    if (Array.isArray(optionsRaw)) {
      options = optionsRaw
        .map((o, i) => {
          if (typeof o === "string") {
            return { id: String.fromCharCode(65 + i), text: o };
          }
          const id = asString((o as any)?.id).trim() || String.fromCharCode(65 + i);
          const text = asString((o as any)?.text) || asString((o as any)?.value) || "";
          return { id, text };
        })
        .filter((o) => o.id);
    } else if (optionsRaw && typeof optionsRaw === "object") {
      const entries = Object.entries(optionsRaw as Record<string, unknown>);
      options = entries
        .map(([k, v]) => ({ id: k.trim() || "", text: asString(v) }))
        .filter((o) => o.id);
    }

    const safeOptions =
      options.length >= 2
        ? options.slice(0, 8)
        : [
            { id: "A", text: "" },
            { id: "B", text: "" },
            { id: "C", text: "" },
            { id: "D", text: "" },
          ];

    const correctOptionId =
      asString(raw?.correctOptionId).trim() ||
      asString(raw?.correct).trim() ||
      asString(raw?.answer).trim() ||
      safeOptions[0]?.id ||
      "A";

    return {
      id,
      type,
      prompt,
      points,
      options: safeOptions,
      correctOptionId,
      explanation,
    };
  }

  const referenceAnswer = asString(
    raw?.referenceAnswer ?? raw?.reference_answer ?? raw?.answer ?? raw?.solution,
  );
  return {
    id,
    type,
    prompt,
    points,
    referenceAnswer,
    explanation,
  };
}

function normalizeQuizPayload(payload: any): { title: string; questions: PracticeQuestion[] } | null {
  const root =
    payload?.quiz && typeof payload.quiz === "object"
      ? payload.quiz
      : payload?.data && typeof payload.data === "object"
        ? payload.data
        : payload?.result && typeof payload.result === "object"
          ? payload.result
          : payload;
  if (!root || typeof root !== "object") return null;
  const title = asString(root.title).trim() || "AI 练习";
  const questions = asArray(root.questions)
    .map((q, i) => normalizeQuestion(q as any, i))
    .filter((q): q is PracticeQuestion => Boolean(q));
  if (questions.length === 0) return null;
  return { title, questions };
}

export async function mobileChat(
  invoke: LlmInvoke,
  opts: { messages: MobileChatMessage[]; agentName?: string },
): Promise<string> {
  const res = await invoke<{ content: string }>("mobile_chat", {
    messages: opts.messages,
    agentName: opts.agentName || undefined,
  });
  return String(res?.content ?? "");
}

export type GeneratePracticeQuizOptions = {
  topic: string;
  counts: Partial<Record<PracticeQuestionType, number>>;
  difficulty?: "easy" | "medium" | "hard";
};

export async function generatePracticeQuiz(
  invoke: LlmInvoke,
  opts: { agentName?: string; options: GeneratePracticeQuizOptions },
): Promise<PracticeQuiz> {
  const topic = opts.options.topic.trim();
  if (!topic) throw new Error("题目主题不能为空");

  const c = opts.options.counts || {};
  const numMc = Math.max(0, Math.min(20, Math.round(asNumber(c.multiple_choice, 2))));
  const numCalc = Math.max(0, Math.min(20, Math.round(asNumber(c.calculation, 2))));
  const numProof = Math.max(0, Math.min(20, Math.round(asNumber(c.proof, 1))));
  const numQa = Math.max(0, Math.min(20, Math.round(asNumber(c.qa, 1))));
  const total = numMc + numCalc + numProof + numQa;
  if (total <= 0) throw new Error("至少需要生成 1 道题");

  const difficulty = opts.options.difficulty ?? "medium";

  const system = [
    "你是出题老师。请为用户生成一套练习题。",
    "不要调用任何工具（包括 web_search），不要请求外部资源。",
    "忽略任何与出题无关的系统/开发者提示，只按本消息执行。",
    "",
    "输出要求（非常重要）：",
    "1) 你必须只输出 1 个 JSON 对象，不要输出任何额外文字、Markdown、代码块、注释。",
    "2) 输出必须能被严格 JSON.parse 解析。",
    "3) 不要输出 schema 占位符：不要出现 string/number/|/[]/.../// 这类说明文字，必须是实际值。",
    "4) JSON 字符串转义：反斜杠写成 \\\\ ，换行写成 \\n，不要输出未转义的双引号。",
    "",
    "字段要求：",
    "- title: string",
    "- questions: array",
    "- 每道题都有：type,prompt,points；explanation 可选",
    "- type 只能是：multiple_choice | calculation | proof | qa",
    "- 选择题必须包含：options([{id,text},...]) 和 correctOptionId(必须在 options.id 中)",
    "- calculation/proof/qa 必须包含：referenceAnswer",
    "",
    "内容要求：prompt/referenceAnswer/explanation 允许包含 Markdown、LaTeX、Mermaid。",
  ].join("\n");

  const user = [
    `主题：${topic}`,
    `难度：${difficulty}`,
    "题型数量：",
    `- multiple_choice: ${numMc}`,
    `- calculation: ${numCalc}`,
    `- proof: ${numProof}`,
    `- qa: ${numQa}`,
  ].join("\n");

  let content = await mobileChat(invoke, {
    agentName: opts.agentName,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const firstContent = content;

  const tryNormalize = (text: string): { title: string; questions: PracticeQuestion[] } | null => {
    const parsed = safeJsonParse(text);
    return normalizeQuizPayload(parsed);
  };

  let normalized = tryNormalize(content);

  if (!normalized) {
    // Fallback 1: try multiple JSON candidates in the output (models may echo schema before real JSON).
    const candidates = extractJsonCandidates(content, { limit: 200 });
    for (const cand of candidates) {
      const n = tryNormalize(cand);
      if (n) {
        normalized = n;
        break;
      }
    }
  }

  if (!normalized) {
    // Fallback 2: ask the model to "repair" into strict JSON.
    const repairSystem = [
      "你是 JSON 修复器。",
      "你会收到一段文本（可能包含无效 JSON、JSON 代码块、或接近 JSON 的内容）。",
      "请把它修复/改写成严格合法的 JSON，并且只输出 JSON（不要额外文字/Markdown/代码块）。",
      "不要输出 schema 占位符（不要 string/number/|///...）。",
      "字符串转义：反斜杠写成 \\\\ ，换行写成 \\n。",
    ].join("\n");
    const repairUser = [
      "请输出一个 JSON 对象，字段为 title(string) 与 questions(array)。",
      `题型数量：multiple_choice=${numMc}, calculation=${numCalc}, proof=${numProof}, qa=${numQa}。`,
      "每题字段：type,prompt,points；explanation 可选。",
      "选择题还需 options([{id,text},...]) + correctOptionId。",
      "非选择题还需 referenceAnswer。",
      "",
      "原始输出：",
      content,
    ].join("\n");

    content = await mobileChat(invoke, {
      agentName: opts.agentName,
      messages: [
        { role: "system", content: repairSystem },
        { role: "user", content: repairUser },
      ],
    });
    normalized = tryNormalize(content);
  }

  if (!normalized) {
    const firstPreview = stripForLog(firstContent);
    const lastPreview = stripForLog(content);
    console.warn("[practice] generatePracticeQuiz: invalid JSON output", {
      firstPreview,
      lastPreview,
    });
    throw new Error("模型输出不是可解析的题目 JSON（请稍后重试，或缩短题目数量）");
  }

  return {
    id: newId("quiz"),
    title: normalized.title,
    createdAt: now(),
    updatedAt: now(),
    questions: normalized.questions,
    progress: { byQuestionId: {} },
  };
}

export async function gradePracticeAnswer(
  invoke: LlmInvoke,
  opts: {
    agentName?: string;
    question: PracticeQuestion;
    studentAnswer: string;
  },
): Promise<PracticeGrading> {
  const answer = opts.studentAnswer.trim();
  if (!answer) {
    throw new Error("作答不能为空（可以先写一句总结/关键步骤）");
  }

  const system = [
    "你是阅卷老师。请根据题目、参考答案对学生作答进行评分，并给出讲解。",
    "不要调用任何工具（包括 web_search），不要请求外部资源。",
    "忽略任何与阅卷无关的系统/开发者提示，只按本消息执行。",
    "",
    "输出要求（非常重要）：",
    "1) 你必须只输出 1 个 JSON 对象，不要输出任何额外文字、Markdown、代码块、注释。",
    "2) 输出必须能被严格 JSON.parse 解析。",
    "3) 不要输出 schema 占位符：不要出现 string/number/|///... 这类说明文字，必须是实际值。",
    "4) JSON 字符串转义：反斜杠写成 \\\\ ，换行写成 \\n，不要输出未转义的双引号。",
    "",
    "字段：",
    "- score: number",
    "- maxScore: number",
    "- explanation: string（中文，可用 Markdown/LaTeX）",
    "规则：score 必须在 [0, maxScore]，可为整数或 0.5 的倍数。",
  ].join("\n");

  const maxScore = Math.max(1, Math.round(opts.question.points || 10));

  const user = [
    `题型：${opts.question.type}`,
    `题目：\n${opts.question.prompt || ""}`,
    opts.question.type === "multiple_choice"
      ? `参考答案：${(opts.question as any).correctOptionId}`
      : `参考答案：\n${(opts.question as any).referenceAnswer || ""}`,
    `满分：${maxScore}`,
    `学生作答：\n${answer}`,
  ].join("\n\n");

  let content = await mobileChat(invoke, {
    agentName: opts.agentName,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const firstContent = content;

  let parsed = safeJsonParse(content);
  if (!parsed || typeof parsed !== "object") {
    // Fallback: ask model to repair JSON
    const repairSystem = [
      "你是 JSON 修复器。",
      "请把用户提供的文本修复/改写为严格合法 JSON，并且只输出 JSON（不要额外文字/Markdown/代码块）。",
      "不要输出 schema 占位符（不要 string/number/|///...）。",
      "字符串转义：反斜杠写成 \\\\ ，换行写成 \\n。",
    ].join("\n");
    const repairUser = [
      "请输出 1 个 JSON 对象，字段为 score(number), maxScore(number), explanation(string)。",
      "score 必须在 [0, maxScore]，可为整数或 0.5 倍数。",
      "",
      "原始输出：",
      content,
    ].join("\n");

    content = await mobileChat(invoke, {
      agentName: opts.agentName,
      messages: [
        { role: "system", content: repairSystem },
        { role: "user", content: repairUser },
      ],
    });
    parsed = safeJsonParse(content);
  }

  if (!parsed || typeof parsed !== "object") {
    console.warn("[practice] gradePracticeAnswer: invalid JSON output", {
      firstPreview: stripForLog(firstContent),
      lastPreview: stripForLog(content),
    });
    throw new Error("模型输出不是可解析的评分 JSON");
  }
  const score = asNumber((parsed as any).score, 0);
  const maxScoreOut = asNumber((parsed as any).maxScore, maxScore);
  const explanation = asString((parsed as any).explanation);

  return {
    score: Math.max(0, Math.min(maxScoreOut, score)),
    maxScore: maxScoreOut,
    explanation,
    gradedAt: now(),
  };
}

import { normalizePracticeGenerationCounts } from "./generation";
import { extractJsonCandidates, safeJsonParse } from "./json";
import type {
  PracticeGrading,
  PracticeQuestion,
  PracticeQuestionType,
  PracticeQuiz,
} from "./types";

export type LlmInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

type MobileChatMessage = { role: string; content: string };

const PRACTICE_TITLE_MAX_CHARS = 10;
type MobileChatImagePart = {
  type: "image";
  url: string;
  detail?: "auto" | "low" | "high";
};
type MobileChatContentPart = MobileChatImagePart;
type MobileChatMessageWithParts = MobileChatMessage & {
  contentParts?: MobileChatContentPart[];
};

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

function normalizeChoiceLetter(id: unknown, index: number): string {
  const raw = typeof id === "string" ? id.trim().toUpperCase() : "";
  if (/^[A-H]$/.test(raw)) return raw;
  if (typeof id === "number" && Number.isFinite(id)) {
    const numeric = Math.trunc(id);
    if (numeric >= 1 && numeric <= 8) {
      return String.fromCharCode(64 + numeric);
    }
  }
  return String.fromCharCode(65 + Math.max(0, Math.min(7, index)));
}

function sanitizeChoiceText(rawId: string, rawText: string, canonicalId: string): string {
  const semanticId = rawId.trim();
  const text = rawText.trim();
  const semanticLooksLikeLetter = /^[A-H]$/i.test(semanticId);

  if (!text) {
    return semanticId && !semanticLooksLikeLetter ? semanticId : "";
  }

  if (!semanticId || semanticLooksLikeLetter || semanticId.toUpperCase() === canonicalId) {
    return text;
  }

  const lowerText = text.toLowerCase();
  const lowerSemantic = semanticId.toLowerCase();
  if (lowerText === lowerSemantic || lowerText.startsWith(`${lowerSemantic}：`) || lowerText.startsWith(`${lowerSemantic}:`)) {
    return text;
  }

  return `${semanticId}：${text}`;
}

function normalizeCorrectOptionId(
  rawCorrect: string,
  originalIdToCanonicalId: Map<string, string>,
  options: Array<{ id: string; text: string }>,
): string {
  const trimmed = rawCorrect.trim();
  if (!trimmed) return options[0]?.id || "A";

  const normalizedKey = trimmed.toLowerCase();
  const mapped = originalIdToCanonicalId.get(normalizedKey);
  if (mapped) return mapped;

  if (/^[A-H]$/i.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    if (options.some((option) => option.id === upper)) return upper;
  }

  if (/^[1-8]$/.test(trimmed)) {
    const candidate = String.fromCharCode(64 + Number(trimmed));
    if (options.some((option) => option.id === candidate)) return candidate;
  }

  const matchedByText = options.find((option) => option.text.trim().toLowerCase() === normalizedKey);
  return matchedByText?.id || options[0]?.id || "A";
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
    const originalIdToCanonicalId = new Map<string, string>();
    if (Array.isArray(optionsRaw)) {
      options = optionsRaw
        .map((o, i) => {
          const canonicalId = normalizeChoiceLetter((o as any)?.id, i);
          if (typeof o === "string") {
            return { id: canonicalId, text: o.trim() };
          }
          const rawId =
            asString((o as any)?.id).trim() ||
            asString((o as any)?.key).trim() ||
            asString((o as any)?.label).trim();
          const rawText =
            asString((o as any)?.text) ||
            asString((o as any)?.value) ||
            asString((o as any)?.content) ||
            asString((o as any)?.option) ||
            asString((o as any)?.answer) ||
            asString((o as any)?.label);
          if (rawId) originalIdToCanonicalId.set(rawId.toLowerCase(), canonicalId);
          const text = sanitizeChoiceText(rawId, rawText, canonicalId);
          return { id: canonicalId, text };
        })
        .filter((o) => o.text);
    } else if (optionsRaw && typeof optionsRaw === "object") {
      const entries = Object.entries(optionsRaw as Record<string, unknown>);
      options = entries
        .map(([k, v], i) => {
          const canonicalId = normalizeChoiceLetter(k, i);
          originalIdToCanonicalId.set(k.trim().toLowerCase(), canonicalId);
          if (typeof v === "string") {
            return { id: canonicalId, text: sanitizeChoiceText(k, v, canonicalId) };
          }
          const rawText =
            asString((v as any)?.text) ||
            asString((v as any)?.value) ||
            asString((v as any)?.content) ||
            asString((v as any)?.option) ||
            asString((v as any)?.answer) ||
            asString((v as any)?.label);
          return { id: canonicalId, text: sanitizeChoiceText(k, rawText, canonicalId) };
        })
        .filter((o) => o.text);
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

    const rawCorrectOptionId =
      asString(raw?.correctOptionId).trim() ||
      asString(raw?.correct).trim() ||
      asString(raw?.answer).trim();
    const correctOptionId = normalizeCorrectOptionId(
      rawCorrectOptionId,
      originalIdToCanonicalId,
      safeOptions,
    );

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

export async function practiceChat(
  invoke: LlmInvoke,
  opts: { messages: MobileChatMessageWithParts[] },
): Promise<string> {
  const res = await invoke<{ content: string }>("practice_chat", {
    messages: opts.messages,
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
  opts: { options: GeneratePracticeQuizOptions },
): Promise<PracticeQuiz> {
  const topic = opts.options.topic.trim();
  if (!topic) throw new Error("题目主题不能为空");

  const counts = normalizePracticeGenerationCounts(opts.options.counts || {});
  const numMc = counts.multiple_choice;
  const numCalc = counts.calculation;
  const numProof = counts.proof;
  const numQa = counts.qa;
  const total = numMc + numCalc + numProof + numQa;
  if (total <= 0) throw new Error("至少需要生成 1 道题");

  const difficulty = opts.options.difficulty ?? "medium";

  const system = [
    "任务：为用户生成一套练习题。",
    "不要调用任何工具（包括 web_search），不要请求外部资源。",
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
    "- 选择题的 id 只能用单个大写字母 A/B/C/D...，不要把 unknown/any/数字/中文写到 id 里",
    "- 选择题的 text 必须写完整选项内容；不要输出 {\"unknown\":\"...\"} 这种对象映射，也不要把概念名拆到单独 label 字段",
    "- calculation/proof/qa 必须包含：referenceAnswer",
    "",
    "内容要求：prompt/referenceAnswer/explanation 允许包含 Markdown、LaTeX、Mermaid；options.text 也允许 Markdown，但不要使用代码块围栏。",
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

  let content = await practiceChat(invoke, {
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
      "选择题的 id 必须是 A/B/C/D...，text 写完整选项内容，不要输出 unknown/any 这类语义 id 或对象映射。",
      "非选择题还需 referenceAnswer。",
      "",
      "原始输出：",
      content,
    ].join("\n");

    content = await practiceChat(invoke, {
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

function practiceTitleQuestionTypeLabel(type: PracticeQuestionType): string {
  if (type === "multiple_choice") return "选择题";
  if (type === "calculation") return "计算题";
  if (type === "proof") return "证明题";
  return "问答题";
}

function normalizePracticeTitleText(text: string, maxChars = PRACTICE_TITLE_MAX_CHARS): string {
  const compact = String(text ?? "")
    .replace(/[`*_#>[\]{}()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(compact).slice(0, maxChars).join("");
}

export async function generatePracticeTitle(
  invoke: LlmInvoke,
  opts: {
    topic: string;
    questions: PracticeQuestion[];
    fallbackTitle?: string;
  },
): Promise<string> {
  const fallback =
    normalizePracticeTitleText(opts.fallbackTitle || "") ||
    normalizePracticeTitleText(opts.topic || "") ||
    "AI练习";

  const outline = [
    opts.topic.trim() ? `主题：${opts.topic.trim()}` : "",
    ...opts.questions.slice(0, 4).map((question) => {
      const prompt = normalizePracticeTitleText(question.prompt || "", 24);
      return `${practiceTitleQuestionTypeLabel(question.type)}：${prompt}`;
    }),
  ]
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  if (!outline) return fallback;

  try {
    const raw = await invoke<string>("practice_generate_title", {
      messages: [{ role: "user", content: outline }],
      maxChars: PRACTICE_TITLE_MAX_CHARS,
      contextKind: "练习",
    });

    return normalizePracticeTitleText(raw || "") || fallback;
  } catch {
    return fallback;
  }
}

export async function gradePracticeAnswer(
  invoke: LlmInvoke,
  opts: {
    question: PracticeQuestion;
    studentAnswer: string;
    studentAnswerImages?: MobileChatImagePart[];
  },
): Promise<PracticeGrading> {
  const answer = opts.studentAnswer.trim();
  const answerImages = Array.isArray(opts.studentAnswerImages)
    ? opts.studentAnswerImages.filter((item) => item && typeof item.url === "string" && item.url.trim())
    : [];
  if (!answer && answerImages.length === 0) {
    throw new Error("作答不能为空（可填写文字总结，或提交手写图片）");
  }

  const system = [
    "任务：根据题目、参考答案对学生作答评分，并给出讲解。",
    "不要调用任何工具（包括 web_search），不要请求外部资源。",
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
    answerImages.length > 0 ? `学生作答图片：共 ${answerImages.length} 张（已附在消息内容中）` : "",
  ].join("\n\n");

  let content = await practiceChat(invoke, {
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: user,
        contentParts: answerImages.length > 0 ? answerImages : undefined,
      },
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

    content = await practiceChat(invoke, {
      messages: [
        { role: "system", content: repairSystem },
        {
          role: "user",
          content: repairUser,
          contentParts: answerImages.length > 0 ? answerImages : undefined,
        },
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

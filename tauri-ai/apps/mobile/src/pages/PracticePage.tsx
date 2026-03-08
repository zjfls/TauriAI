import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Plus, Wand2 } from "lucide-react";
import { useLayoutSize } from "../lib/breakpoints";
import { isTauriRuntime, tauriInvoke } from "../lib/tauri";
import { clsx } from "../lib/clsx";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { RichText } from "../ui/RichText";
import { usePracticeStore } from "../../../common/src/practice/store";
import type {
  PracticeAnswer,
  PracticeAnswerImage,
  PracticeQuestion,
  PracticeQuestionProgress,
  PracticeQuestionType,
  PracticeQuiz,
} from "../../../common/src/practice/types";
import {
  resolvePracticeAgentPresentation,
  SYSTEM_PRACTICE_AGENT_LABEL,
  type PracticeAgentPresentation,
} from "../../../common/src/agentUtils";
import {
  generatePracticeQuiz,
  generatePracticeTitle,
  gradePracticeAnswer,
} from "../../../common/src/practice/llm";
import {
  DEFAULT_PRACTICE_GENERATION_COUNTS,
  PRACTICE_GENERATION_FIELDS,
  normalizePracticeGenerationCountValue,
  totalPracticeGenerationCounts,
} from "../../../common/src/practice/generation";
import {
  InkPreview,
  ScrollableInkPad,
  createEmptyInkState,
} from "../../../common/src/practice/ink/ScrollableInkPad";
import { InkBrushPreview } from "../../../common/src/practice/ink/InkBrushPalette";
import { renderInkStateToDataUrl as renderInkToDataUrl } from "../../../common/src/practice/ink/rendering";
import {
  DEFAULT_INK_BRUSH_ID,
  getInkBrushMenuLabel,
  INK_BRUSH_PRESETS,
} from "../../../common/src/practice/ink/brushes";
import { buildPracticeQuestionChatPrompt } from "../../../common/src/practice/chatPrompt";
import {
  buildPracticeChoiceGrading,
  buildPracticeQuizGrading,
  buildPracticeUnansweredGrading,
} from "../../../common/src/practice/grading";

type InkTemplate = "blank" | "ruled" | "grid";

const INK_COLORS = [
  "#111827",
  "#1d4ed8",
  "#0f766e",
  "#7c3aed",
  "#b91c1c",
] as const;
const INK_TEMPLATES: Array<{ value: InkTemplate; label: string }> = [
  { value: "ruled", label: "横线" },
  { value: "grid", label: "网格" },
  { value: "blank", label: "空白" },
];
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
const MAX_PASTED_ANSWER_IMAGE_COUNT = 4;
const MAX_PASTED_ANSWER_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PASTED_ANSWER_IMAGE_EDGE = 1600;
const DRAWING_BRUSH_PRESETS = INK_BRUSH_PRESETS.filter(
  (item) => item.tool !== "eraser",
);
const ERASER_BRUSH_PRESET = INK_BRUSH_PRESETS.find(
  (item) => item.tool === "eraser",
);

type QuestionImageFeedback = {
  kind: "success" | "error";
  message: string;
};

function pathRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
  ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
  ctx.arcTo(x, y + height, x, y, safeRadius);
  ctx.arcTo(x, y, x + width, y, safeRadius);
  ctx.closePath();
}

function normalizeQuestionPromptForImage(markdown: string): string {
  return String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/```(?:[^\n`]*)\n?/g, "")
    .replace(/```/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const paragraphs = text.split("\n");
  const lines: string[] = [];

  for (const rawParagraph of paragraphs) {
    const paragraph = rawParagraph.replace(/\t/g, "  ").trimEnd();
    if (!paragraph.trim()) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      continue;
    }

    let current = "";
    for (const char of Array.from(paragraph)) {
      const next = `${current}${char}`;
      if (current && ctx.measureText(next).width > maxWidth) {
        lines.push(current.trimEnd());
        current = char === " " ? "" : char;
      } else {
        current = next;
      }
    }
    if (current) {
      lines.push(current.trimEnd());
    }
  }

  return lines.length > 0 ? lines : ["（题目为空）"];
}

function drawQuestionImageTag(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  backgroundColor: string,
  textColor: string,
): number {
  ctx.save();
  ctx.font =
    '600 28px system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  ctx.textBaseline = "middle";
  const paddingX = 18;
  const width = Math.ceil(ctx.measureText(text).width + paddingX * 2);
  pathRoundedRect(ctx, x, y, width, 42, 21);
  ctx.fillStyle = backgroundColor;
  ctx.fill();
  ctx.fillStyle = textColor;
  ctx.fillText(text, x + paddingX, y + 21);
  ctx.restore();
  return width;
}

async function renderQuestionToDataUrl(
  question: PracticeQuestion,
  index: number,
): Promise<string | null> {
  if (typeof document === "undefined") return null;
  try {
    await document.fonts?.ready;
  } catch {
    // ignore
  }

  const logicalWidth = 1080;
  const outerPadding = 32;
  const cardPaddingX = 56;
  const cardPaddingY = 52;
  const metaHeight = 42;
  const promptGap = 30;
  const promptLineHeight = 58;
  const promptText = normalizeQuestionPromptForImage(
    question.prompt || "（题目为空）",
  );

  const probeCanvas = document.createElement("canvas");
  const probeCtx = probeCanvas.getContext("2d");
  if (!probeCtx) return null;
  probeCtx.font =
    '500 38px system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  const contentWidth = logicalWidth - outerPadding * 2 - cardPaddingX * 2;
  const promptLines = wrapCanvasText(probeCtx, promptText, contentWidth);

  const cardHeight = Math.max(
    320,
    cardPaddingY * 2 +
      metaHeight +
      promptGap +
      promptLines.length * promptLineHeight,
  );
  const logicalHeight = outerPadding * 2 + cardHeight;
  const pixelRatio =
    typeof window !== "undefined"
      ? Math.max(1, Math.min(2, window.devicePixelRatio || 1))
      : 1;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(logicalWidth * pixelRatio);
  canvas.height = Math.round(logicalHeight * pixelRatio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.scale(pixelRatio, pixelRatio);
  ctx.fillStyle = "#eef2ff";
  ctx.fillRect(0, 0, logicalWidth, logicalHeight);

  const cardX = outerPadding;
  const cardY = outerPadding;
  const cardWidth = logicalWidth - outerPadding * 2;

  ctx.save();
  ctx.shadowColor = "rgba(15, 23, 42, 0.08)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  pathRoundedRect(ctx, cardX, cardY, cardWidth, cardHeight, 30);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();

  pathRoundedRect(ctx, cardX, cardY, cardWidth, cardHeight, 30);
  ctx.strokeStyle = "#dbe4ff";
  ctx.lineWidth = 2;
  ctx.stroke();

  let chipX = cardX + cardPaddingX;
  const chipY = cardY + cardPaddingY;
  chipX +=
    drawQuestionImageTag(
      ctx,
      chipX,
      chipY,
      `第 ${index + 1} 题`,
      "#111827",
      "#ffffff",
    ) + 14;
  chipX +=
    drawQuestionImageTag(
      ctx,
      chipX,
      chipY,
      questionTypeLabel(question.type),
      "#ede9fe",
      "#6d28d9",
    ) + 14;
  drawQuestionImageTag(
    ctx,
    chipX,
    chipY,
    `${question.points} 分`,
    "#e0f2fe",
    "#0f766e",
  );

  ctx.save();
  ctx.font =
    '500 38px system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = "#0f172a";
  ctx.textBaseline = "top";
  let textY = chipY + metaHeight + promptGap;
  for (const line of promptLines) {
    if (!line) {
      textY += Math.round(promptLineHeight * 0.45);
      continue;
    }
    ctx.fillText(line, cardX + cardPaddingX, textY);
    textY += promptLineHeight;
  }
  ctx.restore();

  return canvas.toDataURL("image/png");
}

function formatPracticeError(error: unknown, fallback = "未知错误"): string {
  return String(error instanceof Error ? error.message : (error ?? fallback));
}

function buildQuestionImageFilename(question: PracticeQuestion, index: number): string {
  const typeSlug =
    question.type === "multiple_choice"
      ? "choice"
      : question.type === "calculation"
        ? "calculation"
        : question.type === "proof"
          ? "proof"
          : "qa";
  return `practice-question-${index + 1}-${typeSlug}.png`;
}

function basenameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

function isUnsupportedMobileClipboardImageCopy(message: string): boolean {
  return /当前移动端暂不支持复制 PNG 到系统剪贴板/.test(message);
}

async function savePngDataUrlToLocal(
  dataUrl: string,
  suggestedName: string,
): Promise<string | null> {
  if (isTauriRuntime()) {
    try {
      return await tauriInvoke<string>("save_png_base64_to_local", {
        pngBase64: dataUrl,
        suggestedName,
      });
    } catch (error) {
      return tauriInvoke<string>("save_png_base64_to_local", {
        png_base64: dataUrl,
        suggested_name: suggestedName,
      } as any).catch((fallbackError) => {
        throw fallbackError ?? error;
      });
    }
  }

  if (typeof document === "undefined") {
    return null;
  }

  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = suggestedName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  return suggestedName;
}

function formatClipboardReadError(error: unknown): string {
  const message = formatPracticeError(error, "读取剪贴板失败");
  if (/read permission denied/i.test(message) || /notallowed/i.test(message)) {
    return "系统不允许应用直接读取剪贴板图片，请点击下方区域后使用系统粘贴，或改用“选择图片”。";
  }
  if (/当前系统不支持直接读取剪贴板图片/.test(message)) {
    return "当前环境不支持直接读取剪贴板图片，请点击下方区域后使用系统粘贴，或改用“选择图片”。";
  }
  return message;
}

async function copyPngDataUrlToClipboard(dataUrl: string): Promise<void> {
  let tauriClipboardError: unknown = null;
  if (isTauriRuntime()) {
    try {
      await tauriInvoke("clipboard_write_png_base64", { pngBase64: dataUrl });
      return;
    } catch (error) {
      tauriClipboardError = error;
      try {
        await tauriInvoke("clipboard_write_png_base64", {
          png_base64: dataUrl,
        } as any);
        return;
      } catch (fallbackError) {
        tauriClipboardError = fallbackError;
        console.warn(
          "[Practice] Tauri clipboard image copy failed, fallback to Web API:",
          fallbackError,
        );
      }
    }
  }

  const clipboard = (navigator as any)?.clipboard;
  const clipboardWrite =
    typeof clipboard?.write === "function"
      ? clipboard.write.bind(clipboard)
      : undefined;
  const ClipboardItemCtor = (window as any).ClipboardItem as any;
  if (!clipboardWrite || !ClipboardItemCtor) {
    if (tauriClipboardError) {
      throw tauriClipboardError instanceof Error
        ? tauriClipboardError
        : new Error(String(tauriClipboardError));
    }
    throw new Error("当前环境不支持图片复制");
  }

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  await clipboardWrite([new ClipboardItemCtor({ "image/png": blob })]);
}

type PracticeInkAnswer = Extract<PracticeAnswer, { kind: "ink" }>;

function newPracticeAnswerImageId(): string {
  return `ans_img_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function getInkAnswer(answer?: PracticeAnswer): PracticeInkAnswer | null {
  return answer?.kind === "ink" ? answer : null;
}

function getInkAnswerImages(answer?: PracticeAnswer): PracticeAnswerImage[] {
  return getInkAnswer(answer)?.images ?? [];
}

function buildInkAnswer(
  answer: PracticeAnswer | undefined,
  patch: Partial<Pick<PracticeInkAnswer, "ink" | "images" | "summaryText">>,
): PracticeInkAnswer {
  const existingInkAnswer = getInkAnswer(answer);
  return {
    kind: "ink",
    ink: patch.ink ?? existingInkAnswer?.ink ?? createEmptyInkState(),
    summaryText: patch.summaryText ?? existingInkAnswer?.summaryText,
    images: patch.images ?? existingInkAnswer?.images,
  };
}

function mergePracticeAnswerImages(
  existing: PracticeAnswerImage[],
  incoming: PracticeAnswerImage[],
): PracticeAnswerImage[] {
  const seen = new Set(existing.map((image) => image.url));
  const merged = [...existing];
  for (const image of incoming) {
    if (!image.url || seen.has(image.url)) continue;
    seen.add(image.url);
    merged.push(image);
  }
  return merged;
}

function clipboardDataHasImage(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  const items = Array.from(dataTransfer.items ?? []);
  if (
    items.some((item) => item.kind === "file" && item.type.startsWith("image/"))
  ) {
    return true;
  }
  return Array.from(dataTransfer.files ?? []).some((file) =>
    file.type.startsWith("image/"),
  );
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("加载图片失败"));
    image.src = src;
  });
}

async function createPracticeAnswerImageFromBlob(
  blob: Blob,
  fallbackName: string,
): Promise<PracticeAnswerImage> {
  if (blob.size > MAX_PASTED_ANSWER_IMAGE_BYTES) {
    throw new Error(
      `图片过大，请选择小于 ${MAX_PASTED_ANSWER_IMAGE_BYTES / 1024 / 1024}MB 的图片`,
    );
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImageElement(objectUrl);
    const scale =
      Math.max(image.naturalWidth, image.naturalHeight) >
      MAX_PASTED_ANSWER_IMAGE_EDGE
        ? MAX_PASTED_ANSWER_IMAGE_EDGE /
          Math.max(image.naturalWidth, image.naturalHeight)
        : 1;
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("初始化图片画布失败");
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    let url = canvas.toDataURL("image/jpeg", 0.9);
    if (url.length > 2_400_000) {
      url = canvas.toDataURL("image/jpeg", 0.82);
    }

    return {
      id: newPracticeAnswerImageId(),
      url,
      name: fallbackName,
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function extractPracticeAnswerImagesFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<PracticeAnswerImage[]> {
  const collected: Array<{ blob: Blob; name: string }> = [];

  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file) continue;
    collected.push({
      blob: file,
      name: file.name || `粘贴图片 ${collected.length + 1}`,
    });
    if (collected.length >= MAX_PASTED_ANSWER_IMAGE_COUNT) break;
  }

  if (collected.length === 0) {
    for (const file of Array.from(dataTransfer.files ?? [])) {
      if (!file.type.startsWith("image/")) continue;
      collected.push({
        blob: file,
        name: file.name || `粘贴图片 ${collected.length + 1}`,
      });
      if (collected.length >= MAX_PASTED_ANSWER_IMAGE_COUNT) break;
    }
  }

  const images: PracticeAnswerImage[] = [];
  for (const item of collected) {
    images.push(await createPracticeAnswerImageFromBlob(item.blob, item.name));
  }
  return images;
}

async function createPracticeAnswerImagesFromFiles(
  files: Iterable<File>,
): Promise<PracticeAnswerImage[]> {
  const images: PracticeAnswerImage[] = [];
  for (const file of Array.from(files)) {
    if (!file.type.startsWith("image/")) continue;
    images.push(
      await createPracticeAnswerImageFromBlob(
        file,
        file.name || `本地图片 ${images.length + 1}`,
      ),
    );
    if (images.length >= MAX_PASTED_ANSWER_IMAGE_COUNT) break;
  }
  return images;
}

async function readPracticeAnswerImagesFromClipboard(): Promise<
  PracticeAnswerImage[]
> {
  const clipboard = (navigator as any)?.clipboard;
  const read =
    typeof clipboard?.read === "function"
      ? clipboard.read.bind(clipboard)
      : undefined;
  if (!read) {
    throw new Error(
      "当前系统不支持直接读取剪贴板图片，请点击下方粘贴区后使用系统粘贴。",
    );
  }

  const clipboardItems = await read();
  const images: PracticeAnswerImage[] = [];
  for (const item of clipboardItems) {
    const types = Array.isArray(item?.types) ? item.types : [];
    const imageType = types.find(
      (type: unknown) => typeof type === "string" && type.startsWith("image/"),
    );
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    images.push(
      await createPracticeAnswerImageFromBlob(
        blob,
        `剪贴板图片 ${images.length + 1}`,
      ),
    );
    if (images.length >= MAX_PASTED_ANSWER_IMAGE_COUNT) break;
  }
  return images;
}

function questionTypeLabel(t: PracticeQuestionType): string {
  if (t === "multiple_choice") return "选择题";
  if (t === "calculation") return "计算题";
  if (t === "proof") return "证明题";
  return "问答题";
}

export function PracticePage({
  onCopyQuestionToChat,
  pendingReturnTarget,
  onPendingReturnConsumed,
}: {
  onCopyQuestionToChat?: (request: {
    content: string;
    returnTarget: {
      quizId: string;
      questionId: string;
      questionNumber: number;
      scrollTop: number;
    };
  }) => void | Promise<void>;
  pendingReturnTarget?: {
    quizId: string;
    questionId: string;
    questionNumber: number;
    scrollTop: number;
  } | null;
  onPendingReturnConsumed?: () => void;
}) {
  const layout = useLayoutSize();

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

  const quiz = useMemo(
    () => quizzes.find((q) => q.id === activeQuizId) ?? quizzes[0],
    [quizzes, activeQuizId],
  );
  const quizGrading = quiz?.progress?.quizGrading;
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const questionNodeByIdRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const restoreHighlightTimerRef = useRef<number | null>(null);
  const [restoredQuestionId, setRestoredQuestionId] = useState<string | null>(null);

  const [practiceAgentInfo, setPracticeAgentInfo] =
    useState<PracticeAgentPresentation>(() =>
      resolvePracticeAgentPresentation(null),
    );

  const loadConfig = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const cfg = await tauriInvoke<any>("get_app_config");
      setPracticeAgentInfo(resolvePracticeAgentPresentation(cfg));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">(
    "medium",
  );
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState("");
  const [questionCounts, setQuestionCounts] = useState(
    DEFAULT_PRACTICE_GENERATION_COUNTS,
  );

  const totalQuestionCount = useMemo(
    () => totalPracticeGenerationCounts(questionCounts),
    [questionCounts],
  );

  const [gradeBusy, setGradeBusy] = useState<Record<string, boolean>>({});
  const [gradeError, setGradeError] = useState<Record<string, string>>({});
  const [copyQuestionImageBusy, setCopyQuestionImageBusy] = useState<
    Record<string, boolean>
  >({});
  const [fullscreenPasteBusy, setFullscreenPasteBusy] = useState(false);
  const [fullscreenPasteStatus, setFullscreenPasteStatus] = useState("");
  const fullscreenPasteTargetRef = useRef<HTMLDivElement | null>(null);
  const fullscreenImagePickerInputRef = useRef<HTMLInputElement | null>(null);
  const [copyQuestionImageFeedback, setCopyQuestionImageFeedback] = useState<
    Record<string, QuestionImageFeedback>
  >({});
  const [copyQuestionToChatBusy, setCopyQuestionToChatBusy] = useState<
    Record<string, boolean>
  >({});
  const [quizSubmitBusy, setQuizSubmitBusy] = useState(false);
  const [quizSubmitError, setQuizSubmitError] = useState("");
  const preferLocalImagePicker = isTauriRuntime();

  useEffect(() => {
    setQuizSubmitBusy(false);
    setQuizSubmitError("");
  }, [quiz?.id]);

  const bindQuestionNode = useCallback((questionId: string, node: HTMLDivElement | null) => {
    if (!node) {
      questionNodeByIdRef.current.delete(questionId);
      return;
    }
    questionNodeByIdRef.current.set(questionId, node);
  }, []);

  const flashRestoredQuestion = useCallback((questionId: string) => {
    if (restoreHighlightTimerRef.current !== null) {
      window.clearTimeout(restoreHighlightTimerRef.current);
    }
    setRestoredQuestionId(questionId);
    restoreHighlightTimerRef.current = window.setTimeout(() => {
      setRestoredQuestionId((current) =>
        current === questionId ? null : current,
      );
      restoreHighlightTimerRef.current = null;
    }, 1800);
  }, []);

  useEffect(() => () => {
    if (restoreHighlightTimerRef.current !== null) {
      window.clearTimeout(restoreHighlightTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!pendingReturnTarget) return;
    const targetQuiz = quizzes.find((item) => item.id === pendingReturnTarget.quizId);
    if (!targetQuiz) {
      onPendingReturnConsumed?.();
      return;
    }
    if (quiz?.id !== pendingReturnTarget.quizId) {
      setActiveQuiz(pendingReturnTarget.quizId);
      return;
    }

    let frame1 = 0;
    let frame2 = 0;
    frame1 = window.requestAnimationFrame(() => {
      frame2 = window.requestAnimationFrame(() => {
        const questionNode = questionNodeByIdRef.current.get(pendingReturnTarget.questionId);
        if (questionNode) {
          questionNode.scrollIntoView({ block: "center", behavior: "auto" });
          flashRestoredQuestion(pendingReturnTarget.questionId);
          onPendingReturnConsumed?.();
          return;
        }

        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTo({
            top: pendingReturnTarget.scrollTop,
            behavior: "auto",
          });
        }
        onPendingReturnConsumed?.();
      });
    });

    return () => {
      window.cancelAnimationFrame(frame1);
      window.cancelAnimationFrame(frame2);
    };
  }, [
    flashRestoredQuestion,
    onPendingReturnConsumed,
    pendingReturnTarget,
    quiz?.id,
    quiz?.questions.length,
    quizzes,
    setActiveQuiz,
  ]);
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
  const [inkPenSize, setInkPenSize] = useState<number>(5);
  const [inkEraserSize, setInkEraserSize] = useState<number>(16);
  const [inkTemplate, setInkTemplate] = useState<InkTemplate>("ruled");
  const [fullscreenInkTarget, setFullscreenInkTarget] = useState<{
    quizId: string;
    questionId: string;
  } | null>(null);
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

  const fullscreenInkQuestion = useMemo(() => {
    if (!quiz || !fullscreenInkTarget) return null;
    if (quiz.id !== fullscreenInkTarget.quizId) return null;
    const idx = quiz.questions.findIndex(
      (item) => item.id === fullscreenInkTarget.questionId,
    );
    if (idx < 0) return null;
    const question = quiz.questions[idx]!;
    if (question.type !== "calculation" && question.type !== "proof")
      return null;
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

  useEffect(() => {
    setFullscreenPasteBusy(false);
    setFullscreenPasteStatus("");
  }, [fullscreenInkQuestion?.question.id]);

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
      const studentAnswerImages = [
        ...getInkAnswerImages(answer).map((image) => ({
          type: "image" as const,
          url: image.url,
          detail: "high" as const,
        })),
        ...(renderedInkImage
          ? [
              {
                type: "image" as const,
                url: renderedInkImage,
                detail: "high" as const,
              },
            ]
          : []),
      ];

      if (!text.trim() && studentAnswerImages.length === 0) {
        if (opts?.allowBlank) {
          return buildPracticeUnansweredGrading(
            question,
            "未作答，当前题记 0 分。",
          );
        }
        throw new Error("请先在手写区作答、填写文字答案，或粘贴图片后再提交");
      }

      if (!isTauriRuntime()) {
        throw new Error(
          "当前在浏览器预览模式，无法调用后端批改。请在 App 内运行。",
        );
      }

      return await gradePracticeAnswer(tauriInvoke as any, {
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

  const confirmDeleteQuiz = useCallback(
    (quizId: string, title?: string) => {
      const label = title?.trim() || "未命名练习";
      if (!window.confirm(`确定删除练习“${label}”吗？`)) return;
      deleteQuiz(quizId);
    },
    [deleteQuiz],
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
    if (!isTauriRuntime()) {
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
      const generated = await generatePracticeQuiz(tauriInvoke as any, {
        options: {
          topic: t,
          difficulty,
          counts: questionCounts,
        },
      });

      replaceGeneratedQuestions(quiz.id, generated.questions);
      if (shouldAutoRenameQuiz) {
        const nextTitle = await generatePracticeTitle(tauriInvoke as any, {
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

  const copyQuestionToChat = useCallback(
    async (question: PracticeQuestion, index: number, quizId: string) => {
      if (!onCopyQuestionToChat) return;
      setCopyQuestionToChatBusy((prev) => ({ ...prev, [question.id]: true }));
      try {
        await Promise.resolve(
          onCopyQuestionToChat({
            content: buildPracticeQuestionChatPrompt(question),
            returnTarget: {
              quizId,
              questionId: question.id,
              questionNumber: index + 1,
              scrollTop: scrollContainerRef.current?.scrollTop ?? 0,
            },
          }),
        );
      } finally {
        setCopyQuestionToChatBusy((prev) => ({
          ...prev,
          [question.id]: false,
        }));
      }
    },
    [onCopyQuestionToChat],
  );

  const copyQuestionAsImage = useCallback(
    async (question: PracticeQuestion, index: number) => {
      setCopyQuestionImageBusy((prev) => ({ ...prev, [question.id]: true }));
      setCopyQuestionImageFeedback((prev) => {
        if (!(question.id in prev)) return prev;
        const next = { ...prev };
        delete next[question.id];
        return next;
      });

      try {
        const dataUrl = await renderQuestionToDataUrl(question, index);
        if (!dataUrl) {
          throw new Error("题图生成失败");
        }
        const suggestedName = buildQuestionImageFilename(question, index);
        const [saveResult, copyResult] = await Promise.allSettled([
          savePngDataUrlToLocal(dataUrl, suggestedName),
          copyPngDataUrlToClipboard(dataUrl),
        ]);
        const saveError =
          saveResult.status === "rejected"
            ? formatPracticeError(saveResult.reason, "保存失败")
            : "";
        const copyError =
          copyResult.status === "rejected"
            ? formatPracticeError(copyResult.reason, "复制失败")
            : "";
        const copyUnsupportedOnMobile = isUnsupportedMobileClipboardImageCopy(
          copyError,
        );

        if (copyResult.status === "fulfilled" && saveResult.status === "fulfilled") {
          const savedLabel = saveResult.value
            ? basenameFromPath(saveResult.value)
            : suggestedName;
          setCopyQuestionImageFeedback((prev) => ({
            ...prev,
            [question.id]: {
              kind: "success",
              message: `题图已复制，并保存到相册：${savedLabel}`,
            },
          }));
        } else if (copyResult.status === "fulfilled") {
          setCopyQuestionImageFeedback((prev) => ({
            ...prev,
            [question.id]: {
              kind: "success",
              message: `题图已复制，但保存到相册失败：${saveError}`,
            },
          }));
        } else if (saveResult.status === "fulfilled") {
          const savedLabel = saveResult.value
            ? basenameFromPath(saveResult.value)
            : suggestedName;
          setCopyQuestionImageFeedback((prev) => ({
            ...prev,
            [question.id]: copyUnsupportedOnMobile
              ? {
                  kind: "success",
                  message: `题图已保存到相册：${savedLabel}（当前移动端不支持直接复制图片到系统剪贴板）`,
                }
              : {
                  kind: "error",
                  message: `题图已保存到相册（${savedLabel}），但复制失败：${copyError}`,
                },
          }));
        } else {
          setCopyQuestionImageFeedback((prev) => ({
            ...prev,
            [question.id]: {
              kind: "error",
              message: `复制题图失败：${copyError}；本地保存也失败：${saveError}`,
            },
          }));
        }
      } catch (error) {
        setCopyQuestionImageFeedback((prev) => ({
          ...prev,
          [question.id]: {
            kind: "error",
            message: `复制题图失败：${formatPracticeError(error, "复制失败")}`,
          },
        }));
      } finally {
        setCopyQuestionImageBusy((prev) => ({ ...prev, [question.id]: false }));
      }
    },
    [],
  );

  const appendFullscreenAnswerImages = useCallback(
    (incomingImages: PracticeAnswerImage[]) => {
      if (!quiz || !fullscreenInkQuestion || incomingImages.length === 0)
        return;

      const currentImages = getInkAnswerImages(fullscreenInkQuestion.answer);
      const merged = mergePracticeAnswerImages(currentImages, incomingImages);
      const limited = merged.slice(0, MAX_PASTED_ANSWER_IMAGE_COUNT);
      const addedCount = Math.max(0, limited.length - currentImages.length);

      if (addedCount === 0) {
        setFullscreenPasteStatus("剪贴板中的图片已存在，无需重复添加。");
        return;
      }

      setAnswer(
        quiz.id,
        fullscreenInkQuestion.question.id,
        buildInkAnswer(fullscreenInkQuestion.answer, { images: limited }),
        { commit: true },
      );
      if (fullscreenInkQuestion.submitted) {
        clearQuestionResult(quiz.id, fullscreenInkQuestion.question.id);
      }
      if (merged.length > MAX_PASTED_ANSWER_IMAGE_COUNT) {
        setFullscreenPasteStatus(
          `最多保留 ${MAX_PASTED_ANSWER_IMAGE_COUNT} 张图片，已添加前 ${addedCount} 张。`,
        );
        return;
      }
      setFullscreenPasteStatus(`已添加 ${addedCount} 张图片答案。`);
    },
    [clearQuestionResult, fullscreenInkQuestion, quiz, setAnswer],
  );

  const importFullscreenPastedImages = useCallback(
    async (dataTransfer: DataTransfer | null) => {
      if (!dataTransfer) {
        setFullscreenPasteStatus("未读取到剪贴板数据。");
        return;
      }
      setFullscreenPasteBusy(true);
      setFullscreenPasteStatus("");
      try {
        const images =
          await extractPracticeAnswerImagesFromDataTransfer(dataTransfer);
        if (images.length === 0) {
          setFullscreenPasteStatus("剪贴板里没有图片，请先复制图片后再试。");
          return;
        }
        appendFullscreenAnswerImages(images);
      } catch (error) {
        setFullscreenPasteStatus(
          `粘贴图片失败：${String(error instanceof Error ? error.message : (error ?? "未知错误"))}`,
        );
      } finally {
        setFullscreenPasteBusy(false);
      }
    },
    [appendFullscreenAnswerImages],
  );

  const handleFullscreenPasteButton = useCallback(async () => {
    setFullscreenPasteBusy(true);
    setFullscreenPasteStatus("");
    try {
      const images = await readPracticeAnswerImagesFromClipboard();
      if (images.length === 0) {
        setFullscreenPasteStatus("剪贴板里没有图片，请先复制图片后再试。");
        fullscreenPasteTargetRef.current?.focus();
        return;
      }
      appendFullscreenAnswerImages(images);
    } catch (error) {
      fullscreenPasteTargetRef.current?.focus();
      setFullscreenPasteStatus(formatClipboardReadError(error));
    } finally {
      setFullscreenPasteBusy(false);
    }
  }, [appendFullscreenAnswerImages]);

  const handleFullscreenImagePickerChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files ? Array.from(event.target.files) : [];
      event.target.value = "";
      if (files.length === 0) {
        return;
      }

      setFullscreenPasteBusy(true);
      setFullscreenPasteStatus("");
      try {
        const images = await createPracticeAnswerImagesFromFiles(files);
        if (images.length === 0) {
          setFullscreenPasteStatus("未选择可用图片，请重新选择图片文件。");
          return;
        }
        appendFullscreenAnswerImages(images);
      } catch (error) {
        setFullscreenPasteStatus(`导入图片失败：${formatPracticeError(error)}`);
      } finally {
        setFullscreenPasteBusy(false);
      }
    },
    [appendFullscreenAnswerImages],
  );

  const handleFullscreenImageButton = useCallback(() => {
    if (preferLocalImagePicker) {
      fullscreenImagePickerInputRef.current?.click();
      return;
    }
    void handleFullscreenPasteButton();
  }, [handleFullscreenPasteButton, preferLocalImagePicker]);

  const removeFullscreenAnswerImage = useCallback(
    (imageId: string) => {
      if (!quiz || !fullscreenInkQuestion) return;
      const remaining = getInkAnswerImages(fullscreenInkQuestion.answer).filter(
        (image) => image.id !== imageId,
      );
      setAnswer(
        quiz.id,
        fullscreenInkQuestion.question.id,
        buildInkAnswer(fullscreenInkQuestion.answer, { images: remaining }),
        { commit: true },
      );
      if (fullscreenInkQuestion.submitted) {
        clearQuestionResult(quiz.id, fullscreenInkQuestion.question.id);
      }
      setFullscreenPasteStatus(
        remaining.length > 0 ? "已移除图片答案。" : "已移除最后一张图片答案。",
      );
    },
    [clearQuestionResult, fullscreenInkQuestion, quiz, setAnswer],
  );

  useEffect(() => {
    if (!fullscreenInkQuestion) return;
    const handlePaste = (event: ClipboardEvent) => {
      if (!clipboardDataHasImage(event.clipboardData)) return;
      event.preventDefault();
      void importFullscreenPastedImages(event.clipboardData);
    };
    document.addEventListener("paste", handlePaste);
    return () => {
      document.removeEventListener("paste", handlePaste);
    };
  }, [fullscreenInkQuestion, importFullscreenPastedImages]);

  const renderQuestion = (
    q: PracticeQuestion,
    index: number,
    quiz2: PracticeQuiz,
  ) => {
    const progress = quiz2.progress?.byQuestionId?.[q.id];
    const grading = progress?.grading;
    const answer = progress?.answer;
    const submitted = Boolean(progress?.submittedAt);
    const answerImages = getInkAnswerImages(answer);

    const busy = Boolean(gradeBusy[q.id]);
    const err = gradeError[q.id] || "";
    const copyBusy = Boolean(copyQuestionImageBusy[q.id]);
    const copyFeedback = copyQuestionImageFeedback[q.id];
    const copySuccess = copyFeedback?.kind === "success";
    const chatCopyBusy = Boolean(copyQuestionToChatBusy[q.id]);
    const isFullscreenInkOpen =
      fullscreenInkTarget?.quizId === quiz2.id &&
      fullscreenInkTarget?.questionId === q.id;

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
        ref={(node) => bindQuestionNode(q.id, node)}
        className={clsx(
          "rounded-2xl border bg-white/5 p-4 overflow-x-hidden transition-colors",
          restoredQuestionId === q.id
            ? "border-indigo-300/60 ring-1 ring-indigo-300/40"
            : "border-white/10",
        )}
      >
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-white">
                {index + 1}. {questionTypeLabel(q.type)}
              </div>
              <div className="text-xs text-white/50">{q.points} 分</div>
              <div className="no-window-drag ml-auto flex flex-wrap items-center gap-2">
                {onCopyQuestionToChat ? (
                  <button
                    type="button"
                    className={clsx(
                      "h-8 px-3 rounded-lg border text-xs transition-colors",
                      chatCopyBusy
                        ? "border-sky-300/30 bg-sky-500/15 text-sky-100"
                        : "border-white/10 bg-white/5 text-white/80 hover:bg-white/10",
                    )}
                    onClick={() => void copyQuestionToChat(q, index, quiz2.id)}
                    disabled={chatCopyBusy}
                    title="放入聊天输入框"
                  >
                    {chatCopyBusy ? "处理中…" : "问聊天"}
                  </button>
                ) : null}
                {q.type !== "multiple_choice" ? (
                  <button
                    type="button"
                    className={clsx(
                      "h-8 px-3 rounded-lg border text-xs transition-colors disabled:opacity-60",
                      copySuccess
                        ? "border-emerald-300/30 bg-emerald-500/15 text-emerald-100"
                        : "border-white/10 bg-white/5 text-white/80 hover:bg-white/10",
                    )}
                    onClick={() => void copyQuestionAsImage(q, index)}
                    disabled={copyBusy}
                    title="复制题目为图片"
                  >
                    {copyBusy ? "生成中…" : copySuccess ? "已复制" : "复制题图"}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="mt-2 text-sm text-white/90 max-w-full overflow-x-hidden">
              <RichText content={q.prompt || "（题目为空）"} />
            </div>
            {copyFeedback ? (
              <div
                className={clsx(
                  "mt-2 text-xs",
                  copyFeedback.kind === "error"
                    ? "text-amber-200"
                    : "text-emerald-100/90",
                )}
              >
                {copyFeedback.message}
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-3 grid gap-3">
          {q.type === "multiple_choice" ? (
            <div className="grid auto-rows-fr gap-2 sm:grid-cols-2">
              {q.options.map((opt) => {
                const selected =
                  answer?.kind === "choice" && answer.optionId === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={clsx(
                      "h-full rounded-xl border px-3 py-3 text-left text-sm transition-colors overflow-x-hidden",
                      selected
                        ? "border-indigo-400/80 bg-white/[0.08] ring-1 ring-indigo-400/35 text-white"
                        : "border-white/10 bg-white/[0.04] hover:bg-white/[0.07] text-white/90",
                    )}
                    onClick={() => setChoice(opt.id)}
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <span
                        className={clsx(
                          "shrink-0 text-sm font-semibold",
                          selected ? "text-indigo-200" : "text-white/70",
                        )}
                      >
                        {opt.id}.
                      </span>
                      <RichText
                        content={opt.text || "（空）"}
                        className="min-w-0 flex-1 text-white/90"
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : q.type === "qa" ? (
            <textarea
              className="w-full min-h-[120px] rounded-xl bg-black/20 border border-white/10 px-3 py-2 text-[16px] leading-5 outline-none focus:border-indigo-400"
              value={answer?.kind === "text" ? answer.text : ""}
              onChange={(e) => {
                setAnswer(quiz2.id, q.id, {
                  kind: "text",
                  text: e.target.value,
                });
                if (submitted) clearQuestionResult(quiz2.id, q.id);
              }}
              placeholder="在这里作答…"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          ) : isFullscreenInkOpen ? (
            <div className="rounded-xl border border-indigo-400/30 bg-indigo-500/10 px-3 py-3 text-sm text-indigo-100">
              当前题目正在全屏作答，请在全屏面板中继续书写。
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="text-xs text-white/50">手写 / 图片作答</div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="h-8 px-3 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-white/80"
                    onClick={() =>
                      setFullscreenInkTarget({
                        quizId: quiz2.id,
                        questionId: q.id,
                      })
                    }
                  >
                    全屏作答
                  </button>
                </div>
              </div>
              {answerImages.length > 0 ? (
                <div className="grid grid-cols-2 gap-2">
                  {answerImages.map((image) => (
                    <div
                      key={image.id}
                      className="overflow-hidden rounded-xl border border-white/10 bg-black/20"
                    >
                      <img
                        src={image.url}
                        alt={image.name || "图片答案"}
                        className="h-28 w-full object-cover"
                      />
                      <div className="truncate px-2 py-1 text-[11px] text-white/65">
                        {image.name || "图片答案"}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="h-56">
                <InkPreview
                  value={
                    answer?.kind === "ink" ? answer.ink : createEmptyInkState()
                  }
                  viewportClassName="border-white/15"
                  template={inkTemplate}
                  swallowInteractions
                />
              </div>
            </>
          )}

          <div className="no-window-drag flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className="h-9 px-3 rounded-xl bg-indigo-500 hover:bg-indigo-400 text-white text-sm disabled:opacity-50"
              onClick={submit}
              disabled={busy || quizSubmitBusy}
            >
              {busy ? "批改中…" : "查看解答"}
            </button>
            {err ? <div className="text-sm text-red-300">{err}</div> : null}
          </div>

          {grading ? (
            <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/10 p-3 overflow-x-hidden">
              <div className="text-sm font-semibold text-indigo-100">
                得分：{grading.score} / {grading.maxScore}
              </div>
              {gradingExplanation ? (
                <div className="mt-2 text-sm text-white/90 max-w-full overflow-x-hidden">
                  <RichText content={gradingExplanation} />
                </div>
              ) : null}
              {q.type !== "multiple_choice" ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-indigo-100">
                    查看参考答案
                  </summary>
                  <div className="mt-2 text-sm text-white/90 max-w-full overflow-x-hidden">
                    <RichText
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
      <div className="h-full w-full flex items-center justify-center text-white/50">
        暂无练习
      </div>
    );
  }

  return (
    <>
      <div className="h-full w-full flex flex-col overflow-x-hidden overflow-y-hidden">
        {layout === "compact" ? (
          <div className="border-b border-white/10 bg-white/5">
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

        <div
          ref={scrollContainerRef}
          className="flex-1 min-h-0 overflow-y-auto overscroll-none overflow-x-hidden"
        >
          <div className="px-3 py-4 grid gap-4 max-w-full">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 overflow-x-hidden">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <Input
                    value={quiz.title}
                    onChange={(e) => renameQuiz(quiz.id, e.target.value)}
                  />
                  <div className="mt-2 grid gap-2">
                    <div className="text-xs text-white/50">练习专用 Agent</div>
                    <div className="rounded-xl border border-white/10 bg-black/10 px-3 py-2">
                      <div className="text-sm text-white/90">
                        {practiceAgentInfo.label || SYSTEM_PRACTICE_AGENT_LABEL}
                        <span className="ml-2 text-[11px] text-indigo-200/80">
                          系统内置
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-white/50">
                        {practiceAgentInfo.modelLabel
                          ? `模型：${practiceAgentInfo.modelLabel}`
                          : "模型：未配置"}
                      </div>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="h-10 px-3 rounded-xl bg-red-500/20 hover:bg-red-500/30 text-red-200 text-sm"
                  onClick={() => confirmDeleteQuiz(quiz.id, quiz.title)}
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
                  {PRACTICE_GENERATION_FIELDS.map((field) => (
                    <label
                      key={field.type}
                      className="rounded-xl border border-white/10 bg-black/10 p-2 text-white/90"
                    >
                      <span className="block text-xs text-white/50 mb-1">
                        {field.label}
                      </span>
                      <Input
                        type="number"
                        min={0}
                        max={20}
                        step={INK_SIZE_STEP}
                        inputMode="numeric"
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
                <div className="flex items-center justify-between text-xs text-white/50">
                  <span>共 {totalQuestionCount} 题</span>
                  <span>每种题型可填 0-20</span>
                </div>
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
                    {genBusy ? "生成中…" : `生成 ${totalQuestionCount} 题`}
                  </button>
                </div>
                {genError ? (
                  <div className="text-sm text-red-300">{genError}</div>
                ) : null}
              </div>
            </div>

            {quiz.questions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/15 p-8 text-center text-white/50">
                还没有题目。请使用 AI 出题。
              </div>
            ) : (
              <div className="grid gap-3">
                {quiz.questions.map((q, i) => renderQuestion(q, i, quiz))}

                <div className="rounded-2xl border border-indigo-400/20 bg-white/5 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-base font-semibold text-white">
                        整体提交练习
                      </div>
                      <div className="text-sm text-white/55">
                        按当前整套题目汇总总分与整体批阅。
                      </div>
                    </div>
                    <button
                      type="button"
                      className="h-10 rounded-xl bg-indigo-500 px-4 text-sm text-white transition-colors hover:bg-indigo-400 disabled:opacity-50"
                      onClick={() => void submitQuiz()}
                      disabled={quizSubmitBusy}
                    >
                      {quizSubmitBusy ? "整体提交中…" : "整体提交并汇总得分"}
                    </button>
                  </div>

                  {quizSubmitError ? (
                    <div className="mt-3 text-sm text-red-300">
                      {quizSubmitError}
                    </div>
                  ) : null}

                  {quizGrading ? (
                    <div className="mt-4 rounded-xl border border-indigo-400/20 bg-indigo-500/10 p-3 overflow-x-hidden">
                      <div className="text-base font-semibold text-indigo-100">
                        总分：{quizGrading.score} / {quizGrading.maxScore}
                      </div>
                      <div className="mt-1 text-sm text-indigo-100/80">
                        已批改 {quizGrading.gradedQuestions} /{" "}
                        {quizGrading.totalQuestions} 题
                      </div>
                      <div className="mt-3 text-sm text-white/90 max-w-full overflow-x-hidden">
                        <RichText content={quizGrading.explanation} />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {fullscreenInkQuestion ? (
        <div className="safe-screen fixed inset-0 z-[90] box-border bg-[#0b1220] text-white flex flex-col overflow-hidden">
          <div className="border-b border-white/10 bg-white/5">
            <div className="h-12 px-3 flex items-center justify-between gap-3">
              <div className="min-w-0 text-sm font-semibold truncate">
                {fullscreenInkQuestion.index + 1}.{" "}
                {questionTypeLabel(fullscreenInkQuestion.question.type)} ·
                全屏作答
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
                className="h-8 w-[128px] max-w-full rounded-md border border-white/15 bg-white/8 px-2 text-xs text-white outline-none transition-colors focus:border-indigo-300"
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
                width={52}
                height={22}
              />
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
              >
                橡皮
              </button>
              <span className="ml-1 text-xs text-white/60">粗细</span>
              <button
                type="button"
                className="h-8 w-8 rounded-md border border-white/15 bg-white/5 text-sm font-medium text-white/85"
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
                className="h-8 w-28 accent-indigo-400"
              />
              <button
                type="button"
                className="h-8 w-8 rounded-md border border-white/15 bg-white/5 text-sm font-medium text-white/85"
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
              <span className="w-12 text-right text-xs text-white/70">
                {formatInkSize(activeInkSize)}
              </span>
              <span className="ml-1 text-xs text-white/60">颜色</span>
              {INK_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={clsx(
                    "h-7 w-7 rounded-full border transition-colors",
                    inkUseEraser
                      ? "cursor-not-allowed border-white/10 opacity-40"
                      : inkPenColor === color
                        ? "border-white/90"
                        : "border-white/25",
                  )}
                  style={{ backgroundColor: color }}
                  onClick={() => setInkPenColor(color)}
                  title={`颜色 ${color}`}
                  disabled={inkUseEraser}
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
              <button
                type="button"
                className="ml-auto h-8 px-3 rounded-md border border-emerald-300/25 bg-emerald-500/15 text-xs text-emerald-100 disabled:opacity-60"
                onClick={handleFullscreenImageButton}
                disabled={fullscreenPasteBusy}
              >
                {preferLocalImagePicker
                  ? fullscreenPasteBusy
                    ? "处理中…"
                    : "选择图片"
                  : fullscreenPasteBusy
                    ? "读取中…"
                    : "粘贴图片"}
              </button>
            </div>
          </div>

          <div className="px-3 py-2 border-b border-white/10 bg-black/15">
            <div className="text-xs text-white/60">题目</div>
            <div className="mt-1 max-h-[26vh] overflow-y-auto text-sm text-white/90 max-w-full overflow-x-hidden">
              <RichText
                content={
                  fullscreenInkQuestion.question.prompt || "（题目为空）"
                }
              />
            </div>
          </div>

          <div className="px-3 py-2 border-b border-white/10 bg-black/10">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-white/60">图片答案</div>
              <div className="text-[11px] text-white/45">
                {preferLocalImagePicker
                  ? "支持系统粘贴或本地选择图片"
                  : "支持系统粘贴或按钮读取剪贴板"}
              </div>
            </div>
            <input
              ref={fullscreenImagePickerInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                void handleFullscreenImagePickerChange(event);
              }}
            />
            <div
              ref={fullscreenPasteTargetRef}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              tabIndex={0}
              className="mt-2 rounded-xl border border-dashed border-white/15 bg-white/5 px-3 py-2 text-xs text-white/55 outline-none focus:border-emerald-300/50 focus:bg-emerald-500/10"
              onPaste={(event) => {
                event.preventDefault();
                void importFullscreenPastedImages(event.clipboardData);
              }}
              onInput={(event) => {
                event.currentTarget.textContent = "";
              }}
            >
              {preferLocalImagePicker
                ? "点击这里后使用系统粘贴图片，或直接点上方“选择图片”。"
                : "点击这里后使用系统粘贴图片，或直接点上方“粘贴图片”。"}
            </div>
            {fullscreenPasteStatus ? (
              <div
                className={clsx(
                  "mt-2 text-[11px]",
                  /失败|没有|不支持|未读取/.test(fullscreenPasteStatus)
                    ? "text-amber-200"
                    : "text-emerald-100/90",
                )}
              >
                {fullscreenPasteStatus}
              </div>
            ) : null}
            {getInkAnswerImages(fullscreenInkQuestion.answer).length > 0 ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {getInkAnswerImages(fullscreenInkQuestion.answer).map(
                  (image) => (
                    <div
                      key={image.id}
                      className="overflow-hidden rounded-xl border border-white/10 bg-black/20"
                    >
                      <img
                        src={image.url}
                        alt={image.name || "图片答案"}
                        className="h-28 w-full object-cover"
                      />
                      <div className="flex items-center justify-between gap-2 px-2 py-2">
                        <div className="min-w-0 truncate text-[11px] text-white/65">
                          {image.name || "图片答案"}
                        </div>
                        <button
                          type="button"
                          className="h-7 shrink-0 rounded-md border border-white/10 bg-white/5 px-2 text-[11px] text-white/75"
                          onClick={() => removeFullscreenAnswerImage(image.id)}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                  ),
                )}
              </div>
            ) : null}
          </div>

          <div className="flex-1 min-h-0 px-3 py-3 overflow-hidden">
            <ScrollableInkPad
              className="h-full"
              value={
                getInkAnswer(fullscreenInkQuestion.answer)?.ink ??
                createEmptyInkState()
              }
              onChange={(nextInk) => {
                setInkDraft(
                  quiz.id,
                  fullscreenInkQuestion.question.id,
                  nextInk,
                  { commit: true },
                );
                if (fullscreenInkQuestion.submitted)
                  clearQuestionResult(
                    quiz.id,
                    fullscreenInkQuestion.question.id,
                  );
              }}
              viewportClassName="border-white/15"
              template={inkTemplate}
              tool={activeInkBrush.tool}
              brushId={activeInkBrush.id}
              penColor={inkPenColor}
              penSize={activeInkSize}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

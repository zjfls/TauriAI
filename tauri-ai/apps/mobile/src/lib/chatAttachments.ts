import { processPdfFile } from "../../../desktop/src/utils/pdfUtils";
import type {
  ChatContentPart,
  ChatImageContentPart,
  ChatPdfDocumentContentPart,
  ChatTextFileContentPart,
} from "../types/chat";

export type DraftChatAttachment =
  | {
      id: string;
      kind: "image";
      label: string;
      size: number;
      contentPart: ChatImageContentPart;
    }
  | {
      id: string;
      kind: "text";
      label: string;
      size: number;
      contentPart: ChatTextFileContentPart;
    }
  | {
      id: string;
      kind: "pdf";
      label: string;
      size: number;
      totalPages: number;
      contentPart: ChatPdfDocumentContentPart;
    };

export const MOBILE_SUPPORTED_TEXT_EXTENSIONS = [
  ".tauri.richtxt",
  ".txt", ".md", ".json", ".yaml", ".yml", ".xml", ".csv", ".log",
  ".ini", ".toml", ".html", ".css",
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".pyi", ".rs", ".go", ".java", ".c", ".cc", ".cxx", ".cpp", ".h", ".hh", ".hpp", ".hxx", ".inl", ".ipp", ".ixx", ".cppm", ".lua", ".sh", ".bat", ".sql",
  ".scss", ".sass", ".less",
  ".lock",
] as const;

const MAX_TEXT_FILE_SIZE = 1 * 1024 * 1024;
const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024;

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(reader.error?.message || "读取文本失败"));
    reader.readAsText(file, "UTF-8");
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(reader.error?.message || "读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function isPdfFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return file.type === "application/pdf" || name.endsWith(".pdf");
}

function isImageFile(file: File): boolean {
  const mime = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return mime.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".heif"].some((ext) => name.endsWith(ext));
}

function isSupportedTextFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return file.type.startsWith("text/") || MOBILE_SUPPORTED_TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

async function createImageAttachment(file: File): Promise<DraftChatAttachment> {
  if (file.size > MAX_IMAGE_FILE_SIZE) {
    throw new Error(`图片过大，请选择小于 ${MAX_IMAGE_FILE_SIZE / 1024 / 1024}MB 的图片`);
  }
  const url = await readFileAsDataUrl(file);
  return {
    id: newId("att_img"),
    kind: "image",
    label: file.name || "图片",
    size: file.size,
    contentPart: {
      type: "image",
      url,
      detail: "high",
    },
  };
}

async function createTextAttachment(file: File): Promise<DraftChatAttachment> {
  if (file.size > MAX_TEXT_FILE_SIZE) {
    throw new Error(`文本文件过大，请选择小于 ${MAX_TEXT_FILE_SIZE / 1024 / 1024}MB 的文件`);
  }
  const content = await readFileAsText(file);
  return {
    id: newId("att_txt"),
    kind: "text",
    label: file.name || "文本文件",
    size: file.size,
    contentPart: {
      type: "text_file",
      filename: file.name || "text.txt",
      content,
    },
  };
}

async function createPdfAttachment(file: File): Promise<DraftChatAttachment> {
  const processed = await processPdfFile(file);
  return {
    id: processed.id,
    kind: "pdf",
    label: processed.filename,
    size: processed.size,
    totalPages: processed.totalPages,
    contentPart: {
      type: "pdf_document",
      filename: processed.filename,
      pages: processed.pages,
      totalPages: processed.totalPages,
      metadata: processed.metadata,
    },
  };
}

export async function loadChatDraftAttachments(
  files: File[],
  options?: { allowImages?: boolean },
): Promise<{ attachments: DraftChatAttachment[]; warnings: string[] }> {
  const attachments: DraftChatAttachment[] = [];
  const warnings: string[] = [];
  const allowImages = options?.allowImages ?? true;

  for (const file of files) {
    const name = file.name || "未命名文件";
    if (isPdfFile(file)) {
      attachments.push(await createPdfAttachment(file));
      continue;
    }
    if (isImageFile(file)) {
      if (!allowImages) {
        warnings.push(`当前模型不支持图片输入，已跳过：${name}`);
        continue;
      }
      attachments.push(await createImageAttachment(file));
      continue;
    }
    if (isSupportedTextFile(file)) {
      attachments.push(await createTextAttachment(file));
      continue;
    }
    warnings.push(`暂不支持该文件类型：${name}`);
  }

  return { attachments, warnings };
}

export function toAttachmentContentParts(attachments: DraftChatAttachment[]): ChatContentPart[] {
  return attachments.map((attachment) => attachment.contentPart);
}

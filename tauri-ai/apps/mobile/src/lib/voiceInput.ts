export type BrowserSpeechRecognitionAlternative = {
  transcript: string;
  confidence?: number;
};

export type BrowserSpeechRecognitionResult = {
  isFinal: boolean;
  length: number;
  [index: number]: BrowserSpeechRecognitionAlternative;
};

export type BrowserSpeechRecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<BrowserSpeechRecognitionResult>;
};

export type BrowserSpeechRecognitionErrorEvent = {
  error: string;
  message?: string;
};

export interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

export function getSpeechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export function supportsVoiceInput(): boolean {
  return getSpeechRecognitionConstructor() != null;
}

export async function ensureMicrophonePermission(): Promise<void> {
  if (typeof navigator === "undefined") return;
  const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (!getUserMedia) return;
  const stream = await getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
}

export function mapMicrophonePermissionError(error: unknown): string {
  const domLikeError = error as { name?: string; message?: string } | null;
  switch (domLikeError?.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "麦克风权限被拒绝，请在系统设置中允许录音权限。";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "未检测到可用麦克风，请检查设备录音权限和音频输入。";
    case "NotReadableError":
    case "TrackStartError":
      return "麦克风当前被其他应用占用，请关闭占用后重试。";
    default:
      return String(domLikeError?.message ?? error ?? "无法获取麦克风权限");
  }
}

export function collectSpeechSegments(event: BrowserSpeechRecognitionEvent): {
  finalTranscript: string;
  interimTranscript: string;
} {
  let finalTranscript = "";
  let interimTranscript = "";

  for (let index = 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    const alternative = result?.[0];
    const transcript = String(alternative?.transcript ?? "").trim();
    if (!transcript) continue;
    if (result.isFinal) {
      finalTranscript = `${finalTranscript} ${transcript}`.trim();
    } else {
      interimTranscript = `${interimTranscript} ${transcript}`.trim();
    }
  }

  return { finalTranscript, interimTranscript };
}

export function mergeVoiceText(baseText: string, finalTranscript: string, interimTranscript = ""): string {
  return [baseText.trim(), finalTranscript.trim(), interimTranscript.trim()].filter(Boolean).join(" ").trim();
}

export function mapVoiceInputError(error: string): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "麦克风权限被拒绝，请在系统设置中允许录音权限。";
    case "audio-capture":
      return "未检测到可用麦克风，请检查设备录音权限和音频输入。";
    case "network":
      return "语音识别网络异常，请稍后重试。";
    case "no-speech":
      return "没有识别到语音，请靠近麦克风后重试。";
    case "aborted":
      return "";
    default:
      return "语音输入暂时不可用，请稍后重试。";
  }
}

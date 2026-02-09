import { loadJson, saveJson } from "./storage";

export type ChatRenderMode = "rich" | "plain";

type ChatRenderSettings = {
  mode: ChatRenderMode;
};

const STORAGE_KEY = "tauriai.mobile.chat.render.v1";

const DEFAULT_SETTINGS: ChatRenderSettings = {
  mode: "rich",
};

export function loadChatRenderSettings(): ChatRenderSettings {
  const v = loadJson<ChatRenderSettings>(STORAGE_KEY, DEFAULT_SETTINGS);
  if (v && (v.mode === "rich" || v.mode === "plain")) return v;
  return DEFAULT_SETTINGS;
}

export function loadChatRenderMode(): ChatRenderMode {
  return loadChatRenderSettings().mode;
}

export function saveChatRenderMode(mode: ChatRenderMode): void {
  saveJson(STORAGE_KEY, { mode } satisfies ChatRenderSettings);
}


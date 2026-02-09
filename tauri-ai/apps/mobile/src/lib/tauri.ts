import { invoke, isTauri } from "@tauri-apps/api/core";

export const isTauriRuntime = () => isTauri();

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

export type UnlistenFn = () => void;

export async function tauriListen<T>(
  eventName: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    throw new Error("当前不是 Tauri 运行环境，无法订阅事件。");
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<T>(eventName, (evt) => handler(evt.payload));
  return () => {
    try {
      void unlisten();
    } catch {
      // ignore
    }
  };
}

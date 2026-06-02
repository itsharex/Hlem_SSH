import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./runtime";

export type Unlisten = () => void;

export function call<T>(
  command: string,
  browserFallback: () => T | Promise<T>,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauriRuntime()) return invoke<T>(command, args);
  try {
    return Promise.resolve(browserFallback());
  } catch (error) {
    return Promise.reject(error);
  }
}

export async function listenEvent<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
  if (!isTauriRuntime()) return () => undefined;
  return listen<T>(event, (message) => handler(message.payload));
}

export function browserUnavailable<T = never>(capability: string): Promise<T> {
  return Promise.reject(new Error(`浏览器环境无法使用：${capability}`));
}

export function browserUnavailableSync(capability: string): never {
  throw new Error(`浏览器环境无法使用：${capability}`);
}

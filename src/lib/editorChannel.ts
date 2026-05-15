export interface EditorInitMessage {
  type: "init";
  path: string;
  content: string;
  sessionId: string;
  sessionName: string;
}

export interface EditorAddTabMessage {
  type: "addTab";
  path: string;
  content: string;
  sessionId: string;
  sessionName: string;
}

export interface EditorChangeMessage {
  type: "change";
  path: string;
  content: string;
  sessionId: string;
}

export interface EditorSaveMessage {
  type: "save";
  path: string;
  content: string;
  sessionId: string;
}

export interface EditorSavedMessage {
  type: "saved";
  path: string;
  sessionId: string;
}

export interface EditorErrorMessage {
  type: "error";
  message: string;
  path?: string;
  sessionId?: string;
}

export interface EditorReadyMessage {
  type: "ready";
}

export interface EditorCloseMessage {
  type: "close";
}

export interface EditorSessionDisconnectedMessage {
  type: "sessionDisconnected";
  sessionId: string;
}

export interface EditorSessionReconnectedMessage {
  type: "sessionReconnected";
  sessionId: string;
}

export type EditorChannelMessage =
  | EditorInitMessage
  | EditorAddTabMessage
  | EditorChangeMessage
  | EditorSaveMessage
  | EditorSavedMessage
  | EditorErrorMessage
  | EditorReadyMessage
  | EditorCloseMessage
  | EditorSessionDisconnectedMessage
  | EditorSessionReconnectedMessage;

/** All FileManager instances share one global editor channel */
export const EDITOR_CHANNEL_NAME = "helm-editor-global";

/** @deprecated use EDITOR_CHANNEL_NAME instead */
export function editorChannelName(editorId: string) {
  return `helm-editor-${editorId}`;
}

/** 全局编辑器通道名，所有连接共享同一个编辑器窗口 */
export const GLOBAL_EDITOR_CHANNEL = "helm-editor-global";

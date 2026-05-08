export interface EditorInitMessage {
  type: "init";
  path: string;
  content: string;
}

export interface EditorChangeMessage {
  type: "change";
  content: string;
}

export interface EditorSaveMessage {
  type: "save";
  content: string;
}

export interface EditorSavedMessage {
  type: "saved";
}

export interface EditorErrorMessage {
  type: "error";
  message: string;
}

export interface EditorReadyMessage {
  type: "ready";
}

export interface EditorCloseMessage {
  type: "close";
}

export type EditorChannelMessage =
  | EditorInitMessage
  | EditorChangeMessage
  | EditorSaveMessage
  | EditorSavedMessage
  | EditorErrorMessage
  | EditorReadyMessage
  | EditorCloseMessage;

export function editorChannelName(editorId: string) {
  return `helm-editor-${editorId}`;
}

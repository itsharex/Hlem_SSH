import type { SessionInput } from "../types";

export type SessionModalState =
  | { mode: "create"; input: SessionInput }
  | { mode: "edit"; sessionId: string; input: SessionInput };


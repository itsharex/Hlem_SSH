import type { SessionInput } from "../types";

export type VaultMode = "loading" | "create" | "unlock" | "ready";

export type SessionModalState =
  | { mode: "create"; input: SessionInput }
  | { mode: "edit"; sessionId: string; input: SessionInput };


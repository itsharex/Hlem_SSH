import { useEffect, useRef, type MutableRefObject } from "react";
import type { Dispatch, SetStateAction } from "react";
import { remoteApi } from "../api/remoteApi";
import {
  appendTerminalStreamEntries,
  extractPromptCwd,
  shouldSkipTerminalEntry,
  stripCwdMarkers,
} from "./appHelpers";
import { getErrorMessage } from "../lib/configMapping";
import { normalizePath as normalizeRemotePath } from "../lib/path";
import { useMountedRef } from "../lib/reactLifecycle";
import { createTerminalEntry } from "../lib/session";
import type { RemoteSession, TerminalClosedEvent, TerminalEntry, TerminalOutputEvent } from "../types";

type UseTerminalRuntimeOptions = {
  sessionsRef: MutableRefObject<RemoteSession[]>;
  setSessions: Dispatch<SetStateAction<RemoteSession[]>>;
  updateSession: (sessionId: string, updater: (session: RemoteSession) => RemoteSession) => void;
  setSessionFilesLoading: (sessionId: string, loading: boolean) => void;
  formatSessionError: (error: unknown, session: Pick<RemoteSession, "name" | "connectionId" | "terminalId" | "sftpId">) => string;
};

export function useTerminalRuntime({
  sessionsRef,
  setSessions,
  updateSession,
  setSessionFilesLoading,
  formatSessionError,
}: UseTerminalRuntimeOptions) {
  const terminalSessionMapRef = useRef<Map<string, string>>(new Map());
  const pendingTerminalEntriesRef = useRef<Map<string, TerminalEntry[]>>(new Map());
  const terminalOutputBuffersRef = useRef<Map<string, TerminalEntry[]>>(new Map());
  const terminalOutputFlushRef = useRef<number | null>(null);
  const mountedRef = useMountedRef();

  useEffect(() => {
    return () => clearTerminalOutputBuffers();
  }, []);

  function registerTerminal(terminalId: string, sessionId: string) {
    terminalSessionMapRef.current.set(terminalId, sessionId);
  }

  function consumePendingTerminalEntries(terminalId: string) {
    const entries = pendingTerminalEntriesRef.current.get(terminalId) ?? [];
    if (entries.length) pendingTerminalEntriesRef.current.delete(terminalId);
    return entries;
  }

  function appendTerminal(sessionId: string, kind: TerminalOutputEvent["kind"] | "input", content: string) {
    const entry = createTerminalEntry(kind, content);
    if (!entry.content) return;
    updateSession(sessionId, (session) => ({
      ...session,
      terminal: shouldSkipTerminalEntry(session.terminal, entry) ? session.terminal : [...session.terminal, entry],
    }));
  }

  function handleTerminalOutput(payload: TerminalOutputEvent) {
    const { data, cwd } = stripCwdMarkers(payload.data);
    const promptCwd = extractTerminalPromptCwd(payload.terminalId, data);
    if (cwd || promptCwd) updateTerminalCwd(payload.terminalId, cwd ?? promptCwd ?? "");
    if (!data) return;
    enqueueTerminalOutput(payload.terminalId, createTerminalOutputEntry(payload, data));
  }

  function createTerminalOutputEntry(payload: TerminalOutputEvent, content: string): TerminalEntry {
    return {
      ...createTerminalEntry(payload.kind, content),
      dataBase64: content === payload.data ? payload.dataBase64 : undefined,
    };
  }

  function extractTerminalPromptCwd(terminalId: string, data: string) {
    const session = sessionsRef.current.find((item) => item.terminalId === terminalId);
    if (!session) return null;
    return extractPromptCwd(data, session.username);
  }

  function enqueueTerminalOutput(terminalId: string, entry: TerminalEntry) {
    const buffer = terminalOutputBuffersRef.current.get(terminalId);
    if (buffer) {
      buffer.push(entry);
    } else {
      terminalOutputBuffersRef.current.set(terminalId, [entry]);
    }
    if (terminalOutputFlushRef.current !== null) return;
    terminalOutputFlushRef.current = window.requestAnimationFrame(flushTerminalOutput);
  }

  function flushTerminalOutput() {
    terminalOutputFlushRef.current = null;
    if (terminalOutputBuffersRef.current.size === 0) return;
    const batch = terminalOutputBuffersRef.current;
    terminalOutputBuffersRef.current = new Map();
    const matchedTerminalIds = new Set<string>();
    setSessions((current) =>
      current.map((session) => {
        let nextEntries = session.terminal;
        for (const [terminalId, entries] of batch) {
          const mappedSessionId = terminalSessionMapRef.current.get(terminalId);
          if (session.terminalId !== terminalId && session.id !== mappedSessionId) continue;
          matchedTerminalIds.add(terminalId);
          nextEntries = appendTerminalStreamEntries(nextEntries, entries);
        }
        return nextEntries === session.terminal ? session : { ...session, terminal: nextEntries };
      }),
    );
    for (const [terminalId, entries] of batch) {
      if (matchedTerminalIds.has(terminalId)) continue;
      const pending = pendingTerminalEntriesRef.current.get(terminalId) ?? [];
      pendingTerminalEntriesRef.current.set(terminalId, appendTerminalStreamEntries(pending, entries));
    }
    pruneStalePendingTerminals();
  }

  function pruneStalePendingTerminals() {
    if (pendingTerminalEntriesRef.current.size === 0) return;
    const live = new Set<string>(terminalSessionMapRef.current.keys());
    for (const terminalId of pendingTerminalEntriesRef.current.keys()) {
      if (!live.has(terminalId)) {
        pendingTerminalEntriesRef.current.delete(terminalId);
      }
    }
  }

  function clearTerminalOutputBuffers() {
    if (terminalOutputFlushRef.current !== null) {
      window.cancelAnimationFrame(terminalOutputFlushRef.current);
      terminalOutputFlushRef.current = null;
    }
    terminalOutputBuffersRef.current.clear();
  }

  function resetTerminalRuntime() {
    terminalSessionMapRef.current.clear();
    pendingTerminalEntriesRef.current.clear();
    clearTerminalOutputBuffers();
  }

  function handleTerminalClosed(payload: TerminalClosedEvent) {
    terminalSessionMapRef.current.delete(payload.terminalId);
    pendingTerminalEntriesRef.current.delete(payload.terminalId);
    setSessions((current) =>
      current.map((session) =>
        session.terminalId === payload.terminalId
          ? {
              ...session,
              terminalId: null,
              terminal: [
                ...session.terminal,
                createTerminalEntry("system", "终端通道已关闭"),
              ],
            }
          : session,
      ),
    );
  }

  function updateTerminalCwd(terminalId: string, cwd: string) {
    const rawPath = cwd.trim();
    if (!rawPath.startsWith("/") || rawPath.includes("\n") || rawPath.includes("\r")) return;
    const nextPath = normalizeRemotePath(rawPath);
    const session = sessionsRef.current.find((item) => item.terminalId === terminalId);
    if (!session || session.currentPath === nextPath) return;
    updateSession(session.id, (item) => ({ ...item, currentPath: nextPath }));
    if (!session.sftpId) return;
    setSessionFilesLoading(session.id, true);
    void remoteApi
      .listFiles(session.sftpId, nextPath)
      .then((files) => {
        if (!mountedRef.current) return;
        setSessions((current) =>
          current.map((item) =>
            item.id === session.id && normalizeRemotePath(item.currentPath) === nextPath ? { ...item, files } : item,
          ),
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) setSessionFilesLoading(session.id, false);
      });
  }

  async function sendTerminalData(sessionId: string, terminalId: string | null | undefined, data: string) {
    if (!terminalId) return;
    try {
      await remoteApi.writeTerminal(terminalId, data);
    } catch (error) {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      appendTerminal(sessionId, "error", session ? formatSessionError(error, session) : getErrorMessage(error));
    }
  }

  async function sendTerminalCommand(sessionId: string, terminalId: string | null | undefined, command: string) {
    const trimmed = command.trim();
    if (!trimmed) return;
    await sendTerminalData(sessionId, terminalId, `${trimmed}\r`);
  }

  async function resizeTerminal(terminalId: string | null | undefined, cols: number, rows: number) {
    if (!terminalId) return;
    try {
      await remoteApi.resizeTerminal(terminalId, cols, rows);
    } catch {
      // resize 是交互优化，失败不打断当前终端。
    }
  }

  function clearTerminal(sessionId: string) {
    updateSession(sessionId, (session) => ({ ...session, terminal: [] }));
  }

  async function reopenTerminal(session: RemoteSession) {
    if (!session.connectionId) {
      appendTerminal(session.id, "error", "无法重新打开终端：会话尚未连接");
      return;
    }
    if (session.terminalId) return;
    appendTerminal(session.id, "system", "正在重新打开终端通道...");
    try {
      const terminal = await remoteApi.openTerminal(session.connectionId, 100, 30);
      registerTerminal(terminal.terminalId, session.id);
      const pendingTerminalEntries = consumePendingTerminalEntries(terminal.terminalId);
      updateSession(session.id, (item) => ({
        ...item,
        terminalId: terminal.terminalId,
        terminal: [
          ...item.terminal,
          ...pendingTerminalEntries,
          createTerminalEntry("system", "终端已重新打开"),
        ],
      }));
    } catch (error) {
      appendTerminal(session.id, "error", `终端重新打开失败：${getErrorMessage(error)}`);
    }
  }

  return {
    registerTerminal,
    consumePendingTerminalEntries,
    appendTerminal,
    resetTerminalRuntime,
    handleTerminalOutput,
    handleTerminalClosed,
    sendTerminalData,
    sendTerminalCommand,
    resizeTerminal,
    clearTerminal,
    reopenTerminal,
  };
}

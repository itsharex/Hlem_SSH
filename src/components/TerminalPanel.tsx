import { ClearOutlined, DeleteOutlined, FileTextOutlined, HistoryOutlined } from "@ant-design/icons";
import { Button, Dropdown, Tooltip } from "antd";
import type { MenuProps } from "antd";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { remoteApi } from "../api/remoteApi";
import { appApi } from "../api/appApi";
import { readClipboardText, writeClipboardText } from "../lib/clipboard";
import type { RemoteSession, TerminalEntry, TerminalOutputEvent } from "../types";

interface TerminalPanelProps {
  session: RemoteSession;
  inputHistory: InputHistoryEntry[];
  onSendData: (data: string) => void;
  onSendCommand: (command: string) => void;
  onResize: (cols: number, rows: number) => void;
  onClear: () => void;
  onInputHistoryChange: (history: InputHistoryEntry[]) => void;
}

type AppliedTerminalState = {
  sessionKey: string;
  offsets: Map<string, number>;
};

type InputHistoryEntry = {
  command: string;
  timestamp: number;
};

const INPUT_HISTORY_LIMIT = 15;

export function TerminalPanel({ session, inputHistory: inputHistoryProp, onSendData, onSendCommand, onResize, onClear, onInputHistoryChange }: TerminalPanelProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null);
  const [actionFlash, setActionFlash] = useState<"paste" | "copyAll" | "clear" | "history" | null>(null);
  const [inputHistory, setInputHistory] = useState<InputHistoryEntry[]>(() => mergeInputHistory(loadInputHistory(), inputHistoryProp));
  const onInputHistoryChangeRef = useRef(onInputHistoryChange);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [hoveredHistoryIndex, setHoveredHistoryIndex] = useState<number | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [inputScrollLeft, setInputScrollLeft] = useState(0);
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const appliedRef = useRef<AppliedTerminalState | null>(null);
  const lastSizeRef = useRef({ cols: 0, rows: 0 });
  const sendDataRef = useRef(onSendData);
  const sendCommandRef = useRef(onSendCommand);
  const resizeRef = useRef(onResize);
  const clearRef = useRef(onClear);
  const flashTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingInputEchoRef = useRef("");
  const historyDraftRef = useRef("");
  const historyCursorRef = useRef<number | null>(null);
  const inputHistoryRef = useRef<InputHistoryEntry[]>(inputHistory);
  const connected = session.state === "connected";
  const connectedRef = useRef(connected);

  inputHistoryRef.current = inputHistory;

  useEffect(() => {
    onInputHistoryChangeRef.current = onInputHistoryChange;
  }, [onInputHistoryChange]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  useEffect(() => {
    sendDataRef.current = onSendData;
  }, [onSendData]);

  useEffect(() => {
    sendCommandRef.current = onSendCommand;
  }, [onSendCommand]);

  useEffect(() => {
    resizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    clearRef.current = onClear;
  }, [onClear]);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  useEffect(() => {
    setInputHistory(mergeInputHistory(loadInputHistory(), inputHistoryProp));
    setHistoryOpen(false);
    historyDraftRef.current = "";
    historyCursorRef.current = null;
    pendingInputEchoRef.current = "";
    setInputValue("");
    setInputScrollLeft(0);
  }, [session.id]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;

    const terminal = new XtermTerminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      disableStdin: !connectedRef.current,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: {
        background: "#fbfdff",
        foreground: "#0f172a",
        cursor: "#2563eb",
        selectionBackground: "#bfdbfe",
        black: "#0f172a",
        red: "#dc2626",
        green: "#059669",
        yellow: "#b45309",
        blue: "#2563eb",
        magenta: "#7c3aed",
        cyan: "#0891b2",
        white: "#f8fafc",
        brightBlack: "#64748b",
        brightRed: "#ef4444",
        brightGreen: "#10b981",
        brightYellow: "#d97706",
        brightBlue: "#3b82f6",
        brightMagenta: "#8b5cf6",
        brightCyan: "#06b6d4",
        brightWhite: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon((_event, url) => {
      void appApi.openExternalUrl(url);
    }));
    terminal.open(host);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === "v") {
        event.preventDefault();
        void pasteToTerminal();
        return false;
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && key === "l") {
        event.preventDefault();
        clearTerminal();
        return false;
      }
      return true;
    });
    const dataDisposable = terminal.onData((data) => {
      if (!connectedRef.current) return;
      trackInputEcho(data);
      sendDataRef.current(data);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fitAndResize = () => {
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const { cols, rows } = terminal;
      if (cols > 0 && rows > 0 && (cols !== lastSizeRef.current.cols || rows !== lastSizeRef.current.rows)) {
        lastSizeRef.current = { cols, rows };
        resizeRef.current(cols, rows);
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fitAndResize);
    });
    resizeObserver.observe(host);
    window.requestAnimationFrame(() => {
      fitAndResize();
      terminal.focus();
    });

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      appliedRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const sessionKey = `${session.id}:${session.terminalId ?? "no-terminal"}`;
    if (appliedRef.current?.sessionKey !== sessionKey) {
      terminal.reset();
      appliedRef.current = { sessionKey, offsets: new Map() };
      pendingInputEchoRef.current = "";
    }

    const applied = appliedRef.current;
    if (!applied) return;

    if (session.terminal.length === 0 && applied.offsets.size > 0) {
      terminal.clear();
      applied.offsets.clear();
      return;
    }

    for (const entry of session.terminal) {
      if (entry.kind === "output") continue;
      const content = terminalEntryData(entry);
      const previousLength = applied.offsets.get(entry.id) ?? 0;
      if (previousLength < content.length) {
        const nextContent = content.slice(previousLength);
        terminal.write(nextContent);
        applied.offsets.set(entry.id, content.length);
      }
    }
  }, [session.id, session.terminalId, session.terminal]);

  useEffect(() => {
    const terminalId = session.terminalId;
    if (!terminalId) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void remoteApi.onTerminalOutput((payload) => {
      if (disposed || payload.terminalId !== terminalId) return;
      writeLiveTerminalPayload(payload);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      cleanup = unlisten;
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [session.terminalId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = session.state !== "connected";
    if (session.state === "connected") terminal.focus();
  }, [session.state, session.terminalId]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".ant-dropdown")) return;
      close();
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", closeOnClick);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("click", closeOnClick);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [contextMenu]);

  const menuItems: MenuProps["items"] = [
    { key: "copy", label: "复制选中", disabled: !contextMenu?.selectedText },
    { key: "copyAll", label: "复制全部" },
    { key: "paste", label: "粘贴", disabled: !connected },
    { type: "divider" },
    { key: "selectAll", label: "全选输出" },
    { key: "clear", label: "清空输出" },
  ];

  async function pasteToTerminal() {
    if (!connectedRef.current) return;
    const text = await readClipboardText();
    if (text) {
      trackInputEcho(text);
      sendDataRef.current(text);
    }
    terminalRef.current?.focus();
  }

  async function copySelection() {
    const text = terminalRef.current?.getSelection() ?? "";
    if (text) await writeClipboardText(text);
  }

  async function copyAll() {
    const terminal = terminalRef.current;
    if (!terminal) return;
    await writeClipboardText(terminalBufferText(terminal));
  }

  function selectAll() {
    terminalRef.current?.selectAll();
    terminalRef.current?.focus();
  }

  function clearTerminal() {
    terminalRef.current?.clear();
    clearRef.current();
    terminalRef.current?.focus();
  }

  async function handleMenuClick(key: string) {
    setContextMenu(null);
    if (key === "copy") await copySelection();
    else if (key === "copyAll") await copyAll();
    else if (key === "paste") await pasteToTerminal();
    else if (key === "selectAll") selectAll();
    else if (key === "clear") clearTerminal();
  }

  function flashAction(action: "paste" | "copyAll" | "clear" | "history") {
    setActionFlash(action);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setActionFlash(null), 380);
  }

  function submitInput() {
    if (!connectedRef.current) return;
    const value = inputValue;
    if (value.length === 0) return;
    // Ctrl+U 清空 shell 当前输入行，再发完整命令和回车，保证 shell 显示的命令与本地输入框一致
    const data = `\x15${value}\r`;
    trackInputEcho(data);
    sendDataRef.current(data);
    setInputHistory((prev) => {
      const next = [
        ...prev.filter((entry) => entry.command !== value),
        { command: value, timestamp: Date.now() },
      ].slice(-INPUT_HISTORY_LIMIT);
      saveInputHistory(next);
      onInputHistoryChangeRef.current(next);
      return next;
    });
    setInputValue("");
    setInputScrollLeft(0);
    historyCursorRef.current = null;
    historyDraftRef.current = "";
  }

  function setInputText(value: string) {
    setInputValue(value);
    const end = value.length;
    window.requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      try {
        node.setSelectionRange(end, end);
      } catch {
        /* setSelectionRange can throw on some input types; ignore */
      }
      setInputScrollLeft(node.scrollLeft);
    });
  }

  /**
   * 将本地输入框的当前文本镜像到 SSH shell：先 Ctrl+U 清空 shell 行，再写入新内容。
   * 这样用户按上/下键切换历史时，shell 提示符后会同步显示当前命令。
   */
  function mirrorToShell(_value: string) {
    // Disabled: mirroring to shell while browsing history causes prompt corruption.
    // The shell will receive the final command on Enter via submitInput().
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitInput();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setInputValue("");
      setInputScrollLeft(0);
      historyCursorRef.current = null;
      historyDraftRef.current = "";
      mirrorToShell("");
      terminalRef.current?.focus();
    }
  }

  function applyHistoryEntry(entry: string) {
    setInputHistory((prev) => {
      const next = [
        ...prev.filter((item) => item.command !== entry),
        { command: entry, timestamp: Date.now() },
      ].slice(-INPUT_HISTORY_LIMIT);
      saveInputHistory(next);
      onInputHistoryChangeRef.current(next);
      return next;
    });
    if (connectedRef.current) {
      sendCommandRef.current(entry);
      setInputText("");
    } else {
      setInputText(entry);
    }
    historyCursorRef.current = null;
    historyDraftRef.current = "";
    setHistoryOpen(false);
    window.requestAnimationFrame(() => terminalRef.current?.focus());
  }

  function writeLiveTerminalPayload(payload: TerminalOutputEvent) {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (payload.kind === "system") {
      terminal.write(`\r\n\x1b[2m${new Date().toLocaleTimeString("zh-CN", { hour12: false })}\x1b[0m \x1b[36m${payload.data}\x1b[0m\r\n`);
      return;
    }
    terminal.write(terminalPayloadBytes(payload));
  }

  function terminalPayloadBytes(payload: TerminalOutputEvent) {
    if (!payload.dataBase64) return payload.data;
    const binary = window.atob(payload.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function trackInputEcho(data: string) {
    let next = pendingInputEchoRef.current;
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index];
      if (char === "\x1b") {
        index = skipAnsiSequence(data, index);
        continue;
      }
      if (char === "\b" || char === "\x7f") {
        next = Array.from(next).slice(0, -1).join("");
        continue;
      }
      if (char === "\r" || char === "\n" || char < " ") continue;
      next += char;
    }
    pendingInputEchoRef.current = next.length > 2000 ? next.slice(-2000) : next;
  }

  function colorPendingInputEcho(data: string) {
    let pending = pendingInputEchoRef.current;
    if (!pending) return data;
    let output = "";
    let index = 0;
    while (index < data.length) {
      const char = data[index];
      if (char === "\x1b") {
        const end = skipAnsiSequence(data, index);
        output += data.slice(index, end + 1);
        index = end + 1;
        continue;
      }
      if (pending && isEchoPrintableChar(char) && char === pending[0]) {
        let matched = "";
        while (
          index < data.length &&
          pending &&
          data[index] !== "\x1b" &&
          isEchoPrintableChar(data[index]) &&
          data[index] === pending[0]
        ) {
          matched += data[index];
          pending = pending.slice(1);
          index += 1;
        }
        output += terminalInputColor(matched);
        continue;
      }
      output += char;
      index += 1;
    }
    pendingInputEchoRef.current = pending;
    return output;
  }

  function deleteHistoryEntry(index: number) {
    setHoveredHistoryIndex((current) => (current === index ? null : current));
    setInputHistory((prev) => {
      const next = prev.filter((_, i) => i !== index);
      saveInputHistory(next);
      onInputHistoryChangeRef.current(next);
      return next;
    });
  }

  const historyMenuItems = useMemo<MenuProps["items"]>(
    () =>
      inputHistory.length === 0
        ? [{ key: "__empty__", label: "暂无历史", disabled: true }]
        : inputHistory.map((entry, index) => ({
            key: String(index),
            label: (
              <span className="terminalHistoryTimelineItem" onMouseEnter={() => setHoveredHistoryIndex(index)}>
                <span className="terminalHistoryTime">{formatHistoryTime(entry.timestamp)}</span>
                <span className="terminalHistoryItem">{entry.command}</span>
                <Tooltip title="删除">
                  <DeleteOutlined
                    className="terminalHistoryDelete"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteHistoryEntry(index);
                    }}
                  />
                </Tooltip>
              </span>
            ),
          })),
    [inputHistory],
  );
  const hoveredHistoryEntry = hoveredHistoryIndex === null ? null : inputHistory[hoveredHistoryIndex] ?? null;
  const historyPreview = historyOpen && hoveredHistoryEntry ? (
    <div className="terminalHistoryPreviewPanel" aria-hidden="true">
      <pre className="terminalHistoryPreviewCommand">{renderCommandHighlight(hoveredHistoryEntry.command)}</pre>
      <div className="terminalHistoryPreviewMeta">
        <span>创建时间</span>
        <strong>{formatHistoryPreviewTime(hoveredHistoryEntry.timestamp)}</strong>
      </div>
    </div>
  ) : null;

  return (
    <section className="terminalPanel">
      <div
        className="terminalOutput"
        onClick={() => {
          setContextMenu(null);
          terminalRef.current?.focus();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            selectedText: terminalRef.current?.getSelection() ?? "",
          });
        }}
      >
        <div ref={terminalHostRef} className="terminalHost" />
        <Dropdown
          open={Boolean(contextMenu)}
          trigger={[]}
          menu={{ items: menuItems, onClick: ({ key }) => void handleMenuClick(String(key)) }}
          onOpenChange={(open) => {
            if (!open) setContextMenu(null);
          }}
        >
          <span className="terminalContextMenuAnchor" style={{ left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }} />
        </Dropdown>
      </div>
      <div className="terminalToolbar">
        <span className={`terminalPrompt terminalPrompt-${session.state}`}>
          {session.username}@{session.host}
        </span>
        <div className={`terminalCommandInputWrap${connected ? "" : " terminalCommandInputWrap-disabled"}`}>
          <div className="terminalCommandHighlightViewport" aria-hidden="true">
            <pre className="terminalCommandHighlight" style={{ transform: `translateX(-${inputScrollLeft}px)` }}>
              {renderCommandHighlight(inputValue)}
            </pre>
          </div>
          <input
            ref={inputRef}
            className="terminalInlineInput"
            type="text"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            placeholder={connected ? "输入命令，回车发送" : "未连接"}
            disabled={!connected}
            value={inputValue}
            onChange={(event) => {
              if (historyCursorRef.current !== null) historyCursorRef.current = null;
              setInputValue(event.currentTarget.value);
              setInputScrollLeft(event.currentTarget.scrollLeft);
            }}
            onScroll={(event) => setInputScrollLeft(event.currentTarget.scrollLeft)}
            onKeyDown={handleInputKeyDown}
          />
        </div>
        <span className="terminalToolbarActions">
          <Dropdown
            trigger={["click"]}
            placement="topRight"
            classNames={{ root: "terminalHistoryDropdown" }}
            open={historyOpen}
            onOpenChange={(open) => {
              setHistoryOpen(open);
              if (!open) setHoveredHistoryIndex(null);
            }}
            popupRender={(menus) => (
              <div className="terminalHistoryPopupWrap" onMouseLeave={() => setHoveredHistoryIndex(null)}>
                {menus}
                {historyPreview}
              </div>
            )}
            menu={{
              items: historyMenuItems,
              onClick: ({ key }) => {
                const index = Number(key);
                if (Number.isFinite(index) && inputHistory[index] !== undefined) {
                  applyHistoryEntry(inputHistory[index].command);
                }
              },
            }}
          >
            <Tooltip title="历史输入命令">
              <Button
                aria-label="历史输入命令"
                icon={<HistoryOutlined />}
                size="small"
                type="text"
                className={`terminalActionBtn${actionFlash === "history" ? " terminalActionBtn-flash" : ""}`}
                onClick={() => flashAction("history")}
              />
            </Tooltip>
          </Dropdown>
          <Tooltip title="复制全部输出">
            <Button
              aria-label="复制全部"
              icon={<FileTextOutlined />}
              size="small"
              type="text"
              disabled={!connected}
              className={`terminalActionBtn${actionFlash === "copyAll" ? " terminalActionBtn-flash" : ""}`}
              onClick={() => {
                flashAction("copyAll");
                void copyAll();
              }}
            />
          </Tooltip>
          <Tooltip title="清空输出 (Ctrl+L)">
            <Button
              aria-label="清空输出"
              icon={<ClearOutlined />}
              size="small"
              type="text"
              className={`terminalActionBtn${actionFlash === "clear" ? " terminalActionBtn-flash" : ""}`}
              onClick={() => {
                flashAction("clear");
                clearTerminal();
              }}
            />
          </Tooltip>
        </span>
      </div>
    </section>
  );
}

function renderCommandHighlight(value: string): ReactNode {
  if (!value) return null;
  let expectCommand = true;
  return tokenizeCommand(value).map((token, index) => {
    if (/^\s+$/.test(token)) return token;
    const className = commandTokenClass(token, expectCommand);
    if (isCommandBoundary(token)) {
      expectCommand = true;
    } else if (!isInlineAssignment(token)) {
      expectCommand = false;
    }
    return (
      <span key={`${index}:${token}`} className={className}>
        {token}
      </span>
    );
  });
}

function tokenizeCommand(value: string) {
  return value.match(/(\s+|"(?:\\.|[^"\\])*"|'[^']*'|\|\||&&|>>|2>|[|;&()<>]|[^\s|&;()<>]+)/g) ?? [];
}

function commandTokenClass(token: string, expectCommand: boolean) {
  if (isCommandBoundary(token)) return "terminalSyntaxOperator";
  if (/^(['"]).*\1$/.test(token)) return "terminalSyntaxString";
  if (/^\$[\w?@#$!-]+$/.test(token) || token.includes("$")) return "terminalSyntaxVariable";
  if (isInlineAssignment(token)) return "terminalSyntaxAssignment";
  if (/^-{1,2}[\w-]+(?:=.*)?$/.test(token)) return "terminalSyntaxOption";
  if (/^(?:~|\.{1,2})?\//.test(token) || token.includes("/")) return "terminalSyntaxPath";
  if (/^\d+(?:\.\d+)?$/.test(token)) return "terminalSyntaxNumber";
  if (expectCommand) return "terminalSyntaxCommand";
  return "terminalSyntaxText";
}

function isCommandBoundary(token: string) {
  return token === "|" || token === "||" || token === "&&" || token === ";" || token === "&" || token === "(" || token === ")";
}

function isInlineAssignment(token: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function colorTerminalResponse(data: string) {
  return data
    .split(/(\r\n|\n|\r)/)
    .map((part) => {
      if (part === "\r\n" || part === "\n" || part === "\r") return part;
      if (!part.trim() || hasAnsiOrUnsafeControl(part)) return part;
      return colorResponseLine(colorPromptPrefix(part));
    })
    .join("");
}

function colorPromptPrefix(line: string) {
  return line.replace(/^([\w.-]+)@([\w.-]+):([^\r\n#$>]*)([#$>])(\s?)/, (_, user: string, host: string, cwd: string, sign: string, space: string) => {
    const userColor = user === "root" ? "31;1" : "32;1";
    return `${ansiColor(user, userColor)}@${ansiColor(host, "36;1")}:${ansiColor(cwd, "34;1")}${ansiColor(sign, "33;1")}${space}`;
  });
}

function colorResponseLine(line: string) {
  const pattern =
    /(---[^-\r\n]+statistics ---)|\b((?:\d{1,3}\.){3}\d{1,3})\b|\b(icmp_seq|ttl|time)=([^\s]+)|\b(0%\s+packet\s+loss|connected|success|received|transmitted)\b|\b(error|failed|denied|refused|timeout|timed\s+out|unreachable|packet\s+loss)\b|\b(\d+(?:\.\d+)?)(\s?)(ms|s|bytes|packets?|%)(?=\b)/gi;
  return line.replace(
    pattern,
    (
      match,
      heading: string | undefined,
      ip: string | undefined,
      metricKey: string | undefined,
      metricValue: string | undefined,
      success: string | undefined,
      error: string | undefined,
      numberValue: string | undefined,
      numberSpace: string | undefined,
      numberUnit: string | undefined,
    ) => {
      if (heading) return ansiColor(heading, "36;1");
      if (ip) return ansiColor(ip, "36");
      if (metricKey && metricValue) return `${ansiColor(metricKey, "35")}=${ansiColor(metricValue, "33")}`;
      if (success) return ansiColor(success, "32");
      if (error) return ansiColor(error, "31");
      if (numberValue && numberUnit) return `${ansiColor(numberValue, "33")}${numberSpace ?? ""}${ansiColor(numberUnit, "90")}`;
      return match;
    },
  );
}

function ansiColor(value: string, color: string) {
  return `\x1b[${color}m${value}\x1b[39;22m`;
}

function hasAnsiOrUnsafeControl(value: string) {
  return /[\x1b\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

function terminalInputColor(value: string) {
  return `\x1b[38;2;5;150;105m${value}\x1b[39m`;
}

function isEchoPrintableChar(char: string) {
  return char >= " " && char !== "\x7f";
}

function skipAnsiSequence(value: string, start: number) {
  let index = start + 1;
  if (value[index] === "[") {
    index += 1;
    while (index < value.length && !/[A-Za-z~]/.test(value[index])) index += 1;
    return Math.min(index, value.length - 1);
  }
  return Math.min(index, value.length - 1);
}

function terminalEntryData(entry: TerminalEntry) {
  if (entry.kind === "system") {
    return `\r\n\x1b[2m${entry.timestamp}\x1b[0m \x1b[36m${entry.content}\x1b[0m\r\n`;
  }
  if (entry.kind === "input") {
    return `\x1b[32m${entry.content}\x1b[0m\r\n`;
  }
  if (entry.kind === "error" && !hasTerminalControl(entry.content)) {
    return `\x1b[31m${entry.content}\x1b[0m\r\n`;
  }
  return entry.content;
}

function hasTerminalControl(content: string) {
  return /[\x1b\r\n]/.test(content);
}

function terminalBufferText(terminal: XtermTerminal) {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n").replace(/\s+$/g, "");
}

const INPUT_HISTORY_STORAGE_KEY = "helm:terminalInputHistory";

function loadInputHistory(): InputHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(INPUT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    if (parsed.every((item) => typeof item === "string")) {
      return parsed
        .filter((item): item is string => typeof item === "string")
        .reverse()
        .slice(-INPUT_HISTORY_LIMIT)
        .map((command, index, items) => ({
          command,
          timestamp: now - (items.length - index) * 1000,
        }));
    }
    return parsed
      .filter(isInputHistoryEntry)
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-INPUT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveInputHistory(history: InputHistoryEntry[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INPUT_HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    /* localStorage 可能不可用（隐私模式、配额不足）；忽略 */
  }
}

function isInputHistoryEntry(item: unknown): item is InputHistoryEntry {
  if (!item || typeof item !== "object") return false;
  const entry = item as Partial<InputHistoryEntry>;
  return typeof entry.command === "string" && typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp);
}

/**
 * 合并 localStorage 本地历史与 vault 中持久化的历史，
 * 去重后按时间升序排列，保留最新的 INPUT_HISTORY_LIMIT 条。
 */
function mergeInputHistory(local: InputHistoryEntry[], vault: InputHistoryEntry[]): InputHistoryEntry[] {
  const map = new Map<string, InputHistoryEntry>();
  for (const entry of [...local, ...vault]) {
    const existing = map.get(entry.command);
    if (!existing || entry.timestamp > existing.timestamp) {
      map.set(entry.command, entry);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-INPUT_HISTORY_LIMIT);
}

/** 格式化历史时间为北京时间 MM-DD HH:mm */
const historyTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const historyPreviewTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatHistoryTime(timestamp: number) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "--/-- --:--";
  return historyTimeFormatter.format(date);
}

function formatHistoryPreviewTime(timestamp: number) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "---- -- -- --:--:--";
  const parts = Object.fromEntries(historyPreviewTimeFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

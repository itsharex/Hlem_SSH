import { ClearOutlined, DeleteOutlined, FileTextOutlined, HistoryOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Dropdown, Tooltip } from "antd";
import type { MenuProps } from "antd";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { appApi } from "../api/appApi";
import { readClipboardText, writeClipboardText } from "../lib/clipboard";
import { readJsonStorage, writeJsonStorage } from "../lib/storage";
import type { RemoteSession, TerminalEntry } from "../types";

interface TerminalPanelProps {
  session: RemoteSession;
  inputHistory: InputHistoryEntry[];
  onSendData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onClear: () => void;
  onReopenTerminal?: () => void;
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

export function TerminalPanel({ session, inputHistory: inputHistoryProp, onSendData, onResize, onClear, onReopenTerminal, onInputHistoryChange }: TerminalPanelProps) {
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
  const lastSizeRef = useRef<{ terminalId: string | null; cols: number; rows: number }>({ terminalId: null, cols: 0, rows: 0 });
  const terminalIdRef = useRef<string | null>(session.terminalId ?? null);
  const sendDataRef = useRef(onSendData);
  const resizeRef = useRef(onResize);
  const clearRef = useRef(onClear);
  const flashTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyDraftRef = useRef("");
  const historyCursorRef = useRef<number | null>(null);
  const inputHistoryRef = useRef<InputHistoryEntry[]>(inputHistory);
  const inputValueRef = useRef(inputValue);
  const connected = session.state === "connected";
  const connectedRef = useRef(connected);

  inputHistoryRef.current = inputHistory;
  inputValueRef.current = inputValue;
  terminalIdRef.current = session.terminalId ?? null;

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
    resizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    clearRef.current = onClear;
  }, [onClear]);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  function fitAndResizeTerminal() {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    const { cols, rows } = terminal;
    const terminalId = terminalIdRef.current;
    if (!terminalId || cols <= 0 || rows <= 0) return;
    const last = lastSizeRef.current;
    if (cols !== last.cols || rows !== last.rows || terminalId !== last.terminalId) {
      lastSizeRef.current = { terminalId, cols, rows };
      resizeRef.current(cols, rows);
    }
  }

  useEffect(() => {
    setInputHistory(mergeInputHistory(loadInputHistory(), inputHistoryProp));
    setHistoryOpen(false);
    historyDraftRef.current = "";
    historyCursorRef.current = null;
    inputValueRef.current = "";
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
    // 接入 WebGL renderer，避免 DOM renderer 在 display:none -> block 切换时
    // 的暂停-重画跳变；加载失败（旧显卡/驱动）自动回退到默认 DOM renderer。
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        // GPU 上下文丢失时主动 dispose，xterm 会自动切回 DOM renderer
        webgl.dispose();
      });
      terminal.loadAddon(webgl);
    } catch (err) {
      console.warn("[TerminalPanel] WebGL renderer 加载失败，已回退到 DOM renderer", err);
    }
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
      sendDataRef.current(data);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fitAndResizeTerminal);
    });
    resizeObserver.observe(host);
    window.requestAnimationFrame(() => {
      fitAndResizeTerminal();
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
    if (!session.terminalId) return;
    window.requestAnimationFrame(fitAndResizeTerminal);
  }, [session.terminalId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const sessionKey = `${session.id}:${session.terminalId ?? "no-terminal"}`;
    if (appliedRef.current?.sessionKey !== sessionKey) {
      terminal.reset();
      appliedRef.current = { sessionKey, offsets: new Map() };
    }

    const applied = appliedRef.current;
    if (!applied) return;

    if (session.terminal.length === 0 && applied.offsets.size > 0) {
      terminal.clear();
      applied.offsets.clear();
      return;
    }

    for (const entry of session.terminal) {
      const content = terminalEntryData(entry);
      const contentLength = terminalEntryDataLength(content);
      const previousLength = applied.offsets.get(entry.id) ?? 0;
      if (previousLength < contentLength) {
        const nextContent = sliceTerminalEntryData(content, previousLength);
        const shouldClearForFreshTui = shouldClearForFreshInteractiveFrame(nextContent);
        const shouldStickToBottom = shouldClearForFreshTui || isTerminalAtBottom(terminal) || shouldFollowTerminalOutput(nextContent);
        if (shouldClearForFreshTui) {
          terminal.write(TERMINAL_VIEW_CLEAR_SEQUENCE);
        }
        terminal.write(nextContent, () => {
          if (shouldStickToBottom) terminal.scrollToBottom();
        });
        applied.offsets.set(entry.id, contentLength);
      }
    }
  }, [session.id, session.terminalId, session.terminal]);

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
    sendInputCommand(inputValueRef.current);
  }

  function sendInputCommand(value: string) {
    const command = value;
    if (!command.trim()) return;
    // Ctrl+U 清空 shell 当前输入行，再发完整命令和回车，避免和远端 readline 的历史状态互相缠住。
    sendDataRef.current(`\x15${command}\r`);
    setInputHistory((prev) => {
      const next = [
        ...prev.filter((entry) => entry.command !== command),
        { command, timestamp: Date.now() },
      ].slice(-INPUT_HISTORY_LIMIT);
      saveInputHistory(next);
      onInputHistoryChangeRef.current(next);
      return next;
    });
    resetHistoryNavigation();
    setInputText("");
  }

  function setInputText(value: string) {
    inputValueRef.current = value;
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

  function resetHistoryNavigation() {
    historyCursorRef.current = null;
    historyDraftRef.current = "";
  }

  function navigateInputHistory(direction: -1 | 1) {
    const history = inputHistoryRef.current;
    if (history.length === 0) return;

    const cursor = historyCursorRef.current;
    if (direction < 0) {
      const nextCursor = cursor === null ? history.length - 1 : Math.max(0, cursor - 1);
      if (cursor === null) historyDraftRef.current = inputValueRef.current;
      historyCursorRef.current = nextCursor;
      setInputText(history[nextCursor].command);
      setHistoryOpen(false);
      return;
    }

    if (cursor === null) return;
    const nextCursor = cursor + 1;
    if (nextCursor >= history.length) {
      historyCursorRef.current = null;
      const draft = historyDraftRef.current;
      historyDraftRef.current = "";
      setInputText(draft);
      return;
    }
    historyCursorRef.current = nextCursor;
    setInputText(history[nextCursor].command);
    setHistoryOpen(false);
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitInput();
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && inputHistoryRef.current.length > 0) {
      event.preventDefault();
      navigateInputHistory(event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resetHistoryNavigation();
      setInputText("");
      terminalRef.current?.focus();
    }
  }

  function applyHistoryEntry(entry: string) {
    if (connectedRef.current) {
      sendInputCommand(entry);
    } else {
      setInputText(entry);
      resetHistoryNavigation();
    }
    setHistoryOpen(false);
    window.requestAnimationFrame(() => terminalRef.current?.focus());
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
  const commandHighlight = useMemo(() => renderCommandHighlight(inputValue), [inputValue]);
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
        {connected && !session.terminalId && session.connectionId && onReopenTerminal ? (
          <div className="terminalReopenOverlay">
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              size="middle"
              onClick={(event) => {
                event.stopPropagation();
                onReopenTerminal();
              }}
            >
              重新打开终端
            </Button>
            <span className="terminalReopenHint">
              SSH 连接仍在线，点击可重新开启 shell 通道（无需断开整个会话）
            </span>
          </div>
        ) : null}
        {!connected && session.state === "connecting" ? (
          <div className="terminalReopenOverlay">
            <span className="terminalReopenHint">正在连接...</span>
          </div>
        ) : null}
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
              {commandHighlight}
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
              // 必须在闭包外把值固化下来：updater 是延后执行的，
              // 等到 React 调度它时事件已经分发完毕，event.currentTarget 会被
              // 浏览器置为 null，再去取属性会抛 TypeError 把整棵 React 树打白。
              const nextValue = event.currentTarget.value;
              const nextScrollLeft = event.currentTarget.scrollLeft;
              resetHistoryNavigation();
              inputValueRef.current = nextValue;
              setInputValue(nextValue);
              setInputScrollLeft((current) => (current === nextScrollLeft ? current : nextScrollLeft));
            }}
            onScroll={(event) => {
              const nextScrollLeft = event.currentTarget.scrollLeft;
              setInputScrollLeft((current) => (current === nextScrollLeft ? current : nextScrollLeft));
            }}
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

function hasAnsiOrUnsafeControl(value: string) {
  return /[\x1b\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

type TerminalWriteData = string | Uint8Array;
const TERMINAL_VIEW_CLEAR_SEQUENCE = "\x1b[3J\x1b[H\x1b[2J";

function terminalEntryData(entry: TerminalEntry): TerminalWriteData {
  if (entry.dataBase64) return decodeBase64Bytes(entry.dataBase64);
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

function decodeBase64Bytes(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function terminalEntryDataLength(value: TerminalWriteData) {
  return typeof value === "string" ? value.length : value.length;
}

function sliceTerminalEntryData(value: TerminalWriteData, start: number): TerminalWriteData {
  return typeof value === "string" ? value.slice(start) : value.slice(start);
}

function isTerminalAtBottom(terminal: XtermTerminal) {
  const buffer = terminal.buffer.active;
  return buffer.viewportY >= Math.max(0, buffer.baseY - 1);
}

function shouldFollowTerminalOutput(value: TerminalWriteData) {
  const text = terminalWriteDataText(value);
  return hasFullScreenTerminalControl(text) || hasInteractiveTerminalMarker(text) || /\r(?!\n)/.test(text);
}

function shouldClearForFreshInteractiveFrame(value: TerminalWriteData) {
  const text = terminalWriteDataText(value);
  if (!text) return false;
  if (hasAlternateScreenEnter(text)) return true;
  return hasFreshScreenDraw(text) && hasInteractiveTerminalMarker(text);
}

function terminalWriteDataText(value: TerminalWriteData) {
  if (typeof value === "string") return value;
  try {
    return new TextDecoder().decode(value);
  } catch {
    return "";
  }
}

function hasAlternateScreenEnter(text: string) {
  return /\x1b\[\?(?:47|1047|1049)h/.test(text);
}

function hasFreshScreenDraw(text: string) {
  return /\x1b\[(?:H|1;1H|0;0H)/.test(text) && /\x1b\[(?:J|0J|2J|3J)/.test(text);
}

function hasFullScreenTerminalControl(text: string) {
  return hasAlternateScreenEnter(text) || hasFreshScreenDraw(text) || /\x1b\[\d+;\d+[Hf]/.test(text);
}

function hasInteractiveTerminalMarker(text: string) {
  return (
    /Package configuration|Configuring [^\r\n]+|<\s*(?:Ok|OK|Yes|No|Cancel|Back)\s*>/.test(text) ||
    /[┌┐└┘─│╭╮╰╯═║╔╗╚╝]/.test(text) ||
    /\x1b\(0/.test(text)
  );
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
  return readJsonStorage<InputHistoryEntry[]>(INPUT_HISTORY_STORAGE_KEY, [], (parsed) => {
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
  });
}

function saveInputHistory(history: InputHistoryEntry[]) {
  writeJsonStorage(INPUT_HISTORY_STORAGE_KEY, history);
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

import {
  ArrowUpOutlined,
  BookOutlined,
  CodeOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  FileTextOutlined,
  ExportOutlined,
  FileImageOutlined,
  FileMarkdownOutlined,
  FilePdfOutlined,
  FileZipOutlined,
  FolderAddOutlined,
  FolderOutlined,
  LoadingOutlined,
  PlaySquareOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  SettingOutlined,
  UpOutlined,
} from "@ant-design/icons";
import { App as AntdApp, Button, Dropdown, Form, Input, Modal, Radio, Space, Spin, Table, Tooltip, Tree } from "antd";
import type { MenuProps } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { DataNode } from "antd/es/tree";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { writeClipboardText } from "../lib/clipboard";
import { formatFileSize } from "../lib/format";
import { getErrorMessage } from "../lib/configMapping";
import { editorChannelName, type EditorChannelMessage } from "../lib/editorChannel";
import { getParentPath, getPathSegments, joinPath, normalizePath } from "../lib/path";
import { isTauriRuntime } from "../api/runtime";
import type { QuickCommand, RemoteFileEntry, RemoteSession } from "../types";

const CodeEditor = lazy(() => import("./CodeEditor").then((module) => ({ default: module.CodeEditor })));

const beijingTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

interface FileManagerProps {
  session: RemoteSession;
  onPathChange: (path: string) => void;
  onRefresh: () => Promise<void>;
  onRemoteSearch: (query: string) => Promise<string | null>;
  onListDirectory: (path: string) => Promise<RemoteFileEntry[]>;
  onFileOperation: (operation: FileOperation) => Promise<void>;
  onUploadFiles: (localPaths: string[], targetDirectory: string) => Promise<void>;
  onDownloadFile: (remotePath: string, fileName: string) => Promise<void>;
  onReadText: (path: string) => Promise<string>;
  onWriteText: (path: string, content: string) => Promise<void>;
  onSendCommand: (command: string) => Promise<void>;
  quickCommands: QuickCommand[];
  onQuickCommandsChange: (commands: QuickCommand[]) => Promise<void>;
  filesLoading?: boolean;
}

export type FileOperation =
  | { kind: "create"; entryType: "file" | "directory"; path: string }
  | { kind: "rename"; sourcePath: string; targetPath: string }
  | { kind: "copy"; sourcePath: string; targetPath: string }
  | { kind: "move"; sourcePath: string; targetPath: string }
  | { kind: "delete"; sourcePath: string };

type FileDialogState =
  | { kind: "create"; entryType: "file" | "directory"; name: string }
  | { kind: "rename"; entry: RemoteFileEntry; value: string }
  | { kind: "copy"; entry: RemoteFileEntry; value: string }
  | { kind: "move"; entry: RemoteFileEntry; value: string };

type ContextMenuState = { entry: RemoteFileEntry; x: number; y: number };
type EditorState = { path: string; content: string; saving: boolean };
type FileCategory =
  | "directory"
  | "archive"
  | "script"
  | "document"
  | "log"
  | "text"
  | "media"
  | "env"
  | "config"
  | "data"
  | "binary"
  | "symlink"
  | "other";

const baseColumns: ColumnsType<RemoteFileEntry> = [
  {
    title: "文件名",
    key: "name",
    dataIndex: "name",
    sorter: (a, b) => compareEntryGroup(a, b) || compareEntryName(a, b),
    render: (name: string, entry) => {
      const meta = fileCategoryMeta(entry);
      return (
        <span className={`fileName fileName-${meta.category}`} title={entry.path || name}>
          {meta.icon}
          {name}
        </span>
      );
    },
  },
  {
    title: "大小",
    key: "size",
    sorter: (a, b) => compareEntryGroup(a, b) || a.size - b.size || compareEntryName(a, b),
    render: (_, entry) => <span title={formatFileSize(entry)}>{formatFileSize(entry)}</span>,
  },
  {
    title: "类型",
    key: "type",
    render: (_, entry) => {
      const meta = fileCategoryMeta(entry);
      return <span className={`fileTypeBadge fileTypeBadge-${meta.category}`} title={meta.description}>{meta.label}</span>;
    },
  },
  {
    title: "修改时间",
    key: "modifiedAt",
    dataIndex: "modifiedAt",
    sorter: (a, b) => compareEntryGroup(a, b) || a.modifiedAt.localeCompare(b.modifiedAt) || compareEntryName(a, b),
    render: (value: string) => {
      const formatted = formatBeijingModifiedTime(value);
      return <span title={formatted === value ? value : `${formatted}（北京时间）`}>{formatted}</span>;
    },
  },
  { title: "权限", key: "permissions", dataIndex: "permissions", render: (value: string) => <span title={value}>{value}</span> },
  { title: "用户/组", key: "owner", dataIndex: "owner", render: (value: string) => <span title={value}>{value || "-"}</span> },
];

const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
  name: 260,
  size: 88,
  type: 80,
  modifiedAt: 190,
  permissions: 112,
  owner: 96,
};
const MIN_COLUMN_WIDTH = 64;

// 模块级缓存：组件卸载/重新挂载、切换会话/标签都保留；仅在程序重启（页面重载）时回到默认值。
let inMemoryColumnWidths: Record<string, number> = { ...DEFAULT_COLUMN_WIDTHS };

interface ResizableHeaderCellProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  columnKey?: string;
  onStartResize?: (key: string, startX: number) => void;
}

function ResizableHeaderCell({ columnKey, onStartResize, children, ...rest }: ResizableHeaderCellProps) {
  return (
    <th {...rest}>
      {children}
      {columnKey && onStartResize ? (
        <span
          className="columnResizer"
          aria-hidden="true"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onStartResize(columnKey, event.clientX);
          }}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
    </th>
  );
}

const tableComponents = { header: { cell: ResizableHeaderCell } };

export function FileManager({
  session,
  onPathChange,
  onRefresh,
  onRemoteSearch,
  onListDirectory,
  onFileOperation,
  onUploadFiles,
  onDownloadFile,
  onReadText,
  onWriteText,
  onSendCommand,
  quickCommands,
  onQuickCommandsChange,
  filesLoading = false,
}: FileManagerProps) {
  const { message, modal } = AntdApp.useApp();
  const [searchText, setSearchText] = useState("");
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [tableScrollY, setTableScrollY] = useState(180);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<FileDialogState | null>(null);
  const [directoryEntries, setDirectoryEntries] = useState<Record<string, RemoteFileEntry[]>>({});
  const [directoryLoadingKeys, setDirectoryLoadingKeys] = useState<string[]>([]);
  const [directoryExpandedKeys, setDirectoryExpandedKeys] = useState<string[]>(["/"]);
  const [dragging, setDragging] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [openingEditorPath, setOpeningEditorPath] = useState<string | null>(null);
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [quickCommandOpen, setQuickCommandOpen] = useState(false);
  const [commandEditingId, setCommandEditingId] = useState<string | null>(null);
  const [commandName, setCommandName] = useState("");
  const [commandValue, setCommandValue] = useState("");
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => ({ ...inMemoryColumnWidths }));
  const columnWidthsRef = useRef(columnWidths);
  useEffect(() => {
    columnWidthsRef.current = columnWidths;
    inMemoryColumnWidths = columnWidths;
  }, [columnWidths]);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);
  const directoryExpandedKeysRef = useRef<string[]>(["/"]);
  const detachedEditorsRef = useRef<Map<string, BroadcastChannel>>(new Map());
  const path = normalizePath(session.currentPath);
  const canUseFiles = session.state === "connected" && Boolean(session.sftpId);
  const canRefreshFiles = canUseFiles || (session.state === "connected" && Boolean(session.connectionId));
  const allFiles = useMemo(() => sortRemoteEntries(session.files), [session.files]);
  const lowerSearchText = searchText.toLowerCase();
  const files = useMemo(
    () => (lowerSearchText ? allFiles.filter((f) => f.name.toLowerCase().includes(lowerSearchText)) : allFiles),
    [allFiles, lowerSearchText],
  );
  const filesMatchCurrentPath = filesBelongToDirectory(allFiles, path);
  const directoryChanging = canUseFiles && (filesLoading || !filesMatchCurrentPath);
  const tableLoading = searching || refreshing || directoryChanging;
  const treeData = useMemo(() => buildTreeData(directoryEntries, path, new Set(directoryLoadingKeys)), [directoryEntries, path, directoryLoadingKeys]);
  const commandItems = useMemo(
    () =>
      [...quickCommands]
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")),
    [quickCommands],
  );

  const handleColumnResizeStart = useCallback((key: string, startX: number) => {
    const startWidth = columnWidthsRef.current[key] ?? DEFAULT_COLUMN_WIDTHS[key] ?? 100;
    function onMove(event: MouseEvent) {
      const next = Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + event.clientX - startX));
      setColumnWidths((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("isResizingColumn");
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.classList.add("isResizingColumn");
  }, []);

  const resizableColumns = useMemo<ColumnsType<RemoteFileEntry>>(
    () =>
      baseColumns.map((column) => {
        const key = column.key as string;
        return {
          ...column,
          width: columnWidths[key] ?? DEFAULT_COLUMN_WIDTHS[key],
          onHeaderCell: () => ({
            columnKey: key,
            onStartResize: handleColumnResizeStart,
          } as React.ThHTMLAttributes<HTMLTableCellElement>),
        };
      }),
    [columnWidths, handleColumnResizeStart],
  );

  const tableScrollX = useMemo(
    () => Object.keys(DEFAULT_COLUMN_WIDTHS).reduce((sum, key) => sum + (columnWidths[key] ?? DEFAULT_COLUMN_WIDTHS[key]), 0),
    [columnWidths],
  );

  useEffect(() => {
    directoryExpandedKeysRef.current = directoryExpandedKeys;
  }, [directoryExpandedKeys]);

  useEffect(() => {
    return () => {
      detachedEditorsRef.current.forEach((channel) => channel.close());
      detachedEditorsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    void import("./CodeEditor");
  }, []);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const update = () => {
      setTableScrollY(Math.max(120, element.clientHeight - 39));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canUseFiles) {
      setSearching(false);
      setFocusedPath(null);
      setDirectoryEntries({});
      setDirectoryLoadingKeys([]);
      setDirectoryExpandedKeys(["/"]);
      return;
    }
    if (filesMatchCurrentPath) {
      setDirectoryEntries((current) => ({ ...current, [path]: allFiles }));
    }
    setDirectoryExpandedKeys((current) => uniqueKeys([...current, ...getDirectoryAncestorPaths(path)]));
    if (path !== "/" && !directoryEntries["/"]) void loadDirectory("/");
  }, [allFiles, canUseFiles, path]);

  async function loadDirectory(directoryPath: string, force = false) {
    if (!canUseFiles) return;
    const targetPath = normalizePath(directoryPath);
    if (!force && directoryEntries[targetPath]) return;
    setDirectoryLoadingKeys((current) => uniqueKeys([...current, targetPath]));
    try {
      const entries = targetPath === path && filesBelongToDirectory(allFiles, targetPath)
        ? allFiles
        : await onListDirectory(targetPath);
      setDirectoryEntries((current) => ({ ...current, [targetPath]: sortRemoteEntries(entries) }));
    } catch (error) {
      message.error(getErrorMessage(error));
    } finally {
      setDirectoryLoadingKeys((current) => current.filter((key) => key !== targetPath));
    }
  }

  function expandDirectory(directoryPath: string) {
    const targetPath = normalizePath(directoryPath);
    setDirectoryExpandedKeys((current) => uniqueKeys([...current, targetPath]));
    void loadDirectory(targetPath);
  }

  function toggleDirectory(directoryPath: string) {
    const targetPath = normalizePath(directoryPath);
    const isExpanded = directoryExpandedKeysRef.current.includes(targetPath);
    setDirectoryExpandedKeys((current) =>
      current.includes(targetPath) ? current.filter((key) => key !== targetPath) : uniqueKeys([...current, targetPath]),
    );
    if (!isExpanded) void loadDirectory(targetPath);
  }

  function openDirectoryFromTree(directoryPath: string) {
    const targetPath = normalizePath(directoryPath);
    onPathChange(targetPath);
    setSearchText("");
    setFocusedPath(null);
  }

  function isTreeSwitcherClick(target: EventTarget | null) {
    return target instanceof HTMLElement && Boolean(target.closest(".ant-tree-switcher"));
  }

  useEffect(() => {
    if (!canUseFiles) {
      setSearching(false);
      setFocusedPath(null);
      return;
    }
    const query = searchText.trim();
    const seq = searchSeq.current + 1;
    searchSeq.current = seq;
    if (!query) {
      setSearching(false);
      setFocusedPath(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearching(true);
      void onRemoteSearch(query)
        .then((targetPath) => {
          if (searchSeq.current !== seq) return;
          setFocusedPath(targetPath);
        })
        .catch(() => {
          if (searchSeq.current !== seq) return;
          setFocusedPath(null);
        })
        .finally(() => {
          if (searchSeq.current === seq) setSearching(false);
        });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [canUseFiles, searchText]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (disposed) return;
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragging(true);
          } else if (event.payload.type === "leave") {
            setDragging(false);
          } else if (event.payload.type === "drop") {
            setDragging(false);
            void uploadPaths(event.payload.paths);
          }
        }),
      )
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [canUseFiles, path]);

  function openDirectory(entry: RemoteFileEntry) {
    if (!canUseFiles) return;
    if (entry.fileType !== "directory") {
      void openEditor(entry);
      return;
    }
    onPathChange(entry.path || joinPath(path, entry.name));
    setSearchText("");
    setFocusedPath(null);
  }

  async function openEditor(entry: RemoteFileEntry) {
    if (!canUseFiles) return;
    const targetPath = entry.path || joinPath(path, entry.name);
    if (openingEditorPath || editor) return;
    setOpeningEditorPath(targetPath);
    const messageKey = `editor-open-${targetPath}`;
    message.open({ key: messageKey, type: "loading", content: "正在读取文件...", duration: 0 });
    try {
      const content = await onReadText(targetPath);
      setEditor({ path: targetPath, content, saving: false });
      message.destroy(messageKey);
    } catch (error) {
      message.open({ key: messageKey, type: "error", content: getErrorMessage(error), duration: 3 });
    } finally {
      setOpeningEditorPath(null);
    }
  }

  async function saveEditor() {
    if (!editor) return;
    setEditor({ ...editor, saving: true });
    try {
      await onWriteText(editor.path, editor.content);
      message.open({ key: `editor-save-${editor.path}`, type: "success", content: "文件已保存", duration: 2 });
      setEditor(null);
    } catch (error) {
      setEditor({ ...editor, saving: false });
      message.error(getErrorMessage(error));
    }
  }

  async function detachEditor() {
    if (!editor) return;
    const editorId = crypto.randomUUID();
    const editorPath = editor.path;
    let latestContent = editor.content;
    const channel = new BroadcastChannel(editorChannelName(editorId));
    detachedEditorsRef.current.set(editorId, channel);
    channel.onmessage = (event: MessageEvent<EditorChannelMessage>) => {
      const payload = event.data;
      if (payload.type === "ready") {
        channel.postMessage({ type: "init", path: editorPath, content: latestContent } satisfies EditorChannelMessage);
      }
      if (payload.type === "change") {
        latestContent = payload.content;
      }
      if (payload.type === "save") {
        latestContent = payload.content;
        void onWriteText(editorPath, payload.content)
          .then(() => {
            channel.postMessage({ type: "saved" } satisfies EditorChannelMessage);
          })
          .catch((error) => {
            channel.postMessage({ type: "error", message: getErrorMessage(error) } satisfies EditorChannelMessage);
          });
      }
      if (payload.type === "close") {
        channel.close();
        detachedEditorsRef.current.delete(editorId);
      }
    };

    try {
      if (isTauriRuntime()) {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const windowLabel = `editor-${editorId}`;
        const webview = new WebviewWindow(windowLabel, {
          url: `index.html?editorWindow=${editorId}`,
          title: `编辑 ${getFileName(editorPath)}`,
          width: 1100,
          height: 760,
          minWidth: 760,
          minHeight: 520,
          resizable: true,
        });
        await webview.once("tauri://error", (event) => {
          message.error(String(event.payload));
        });
      } else {
        window.open(`${window.location.origin}${window.location.pathname}?editorWindow=${editorId}`, `editor-${editorId}`, "width=1100,height=760");
      }
      setEditor(null);
    } catch (error) {
      channel.close();
      detachedEditorsRef.current.delete(editorId);
      message.error(getErrorMessage(error));
    }
  }

  async function uploadPaths(localPaths: string[]) {
    if (!canUseFiles) return;
    if (localPaths.length === 0) return;
    try {
      await onUploadFiles(localPaths, path);
      message.success(`已开始上传 ${localPaths.length} 个文件`);
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  function goParent() {
    if (!canUseFiles) return;
    onPathChange(getParentPath(path));
    setSearchText("");
    setFocusedPath(null);
  }

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  async function refresh() {
    if (!canRefreshFiles) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  function startBackgroundOperation(operation: FileOperation) {
    if (!canUseFiles) return;
    const key = `file-operation-${crypto.randomUUID()}`;
    const label = operationLabel(operation);
    message.open({ key, type: "loading", content: `已开始${label}...`, duration: 0 });
    void onFileOperation(operation)
      .then(() => {
        message.open({ key, type: "success", content: `${label}完成`, duration: 2.5 });
      })
      .catch((error) => {
        message.open({ key, type: "error", content: `${label}失败：${getErrorMessage(error)}`, duration: 4 });
      });
  }

  async function copyPath(entry: RemoteFileEntry) {
    const fullPath = normalizePath(entry.path || joinPath(path, entry.name));
    const copied = await writeClipboardText(fullPath);
    if (copied) {
      message.success(`完整路径已复制：${fullPath}`);
    } else {
      message.error("复制失败，请手动复制路径");
    }
  }

  function openCreateDialog() {
    if (!canUseFiles) return;
    setDialog({ kind: "create", entryType: "file", name: "" });
  }

  async function sendQuickCommand(command: QuickCommand) {
    if (session.state !== "connected" || !session.terminalId) {
      message.error("当前终端不可用");
      return;
    }
    try {
      await onSendCommand(command.command);
      void onQuickCommandsChange(
        quickCommands.map((item) =>
          item.id === command.id ? { ...item, clickCount: (item.clickCount ?? 0) + 1, updatedAt: new Date().toISOString() } : item,
        ),
      );
      message.open({ key: `quick-command-${command.id}`, type: "success", content: `已发送：${command.name}`, duration: 1.8 });
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  function openCommandDialog(command?: QuickCommand) {
    setCommandEditingId(command?.id ?? null);
    setCommandName(command?.name ?? "");
    setCommandValue(command?.command ?? "");
    setCommandDialogOpen(true);
  }

  function addQuickCommand() {
    const name = commandName.trim();
    const command = commandValue.trim();
    if (!name || !command) return;
    if (commandEditingId) {
      void onQuickCommandsChange(
        quickCommands.map((item) =>
          item.id === commandEditingId ? { ...item, name, command, updatedAt: new Date().toISOString() } : item,
        ),
      );
    } else {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      void onQuickCommandsChange([...quickCommands, { id, name, command, clickCount: 0, createdAt: now, updatedAt: now }].slice(-100));
    }
    setCommandName("");
    setCommandValue("");
    setCommandEditingId(null);
    setCommandDialogOpen(false);
  }

  function deleteQuickCommand(command: QuickCommand) {
    modal.confirm({
      title: "删除常用命令",
      content: command.name,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        void onQuickCommandsChange(quickCommands.filter((item) => item.id !== command.id));
      },
    });
  }

  function submitDialog() {
    if (!dialog) return;
    if (dialog.kind === "create") {
      const name = dialog.name.trim();
      if (!name) return;
      setDialog(null);
      startBackgroundOperation({ kind: "create", entryType: dialog.entryType, path: joinPath(path, name) });
      return;
    }
    const value = dialog.value.trim();
    if (!value) return;
    const sourcePath = dialog.entry.path || joinPath(path, dialog.entry.name);
    setDialog(null);
    if (dialog.kind === "rename") {
      startBackgroundOperation({ kind: "rename", sourcePath, targetPath: joinPath(getParentPath(sourcePath), value) });
      return;
    }
    startBackgroundOperation({ kind: dialog.kind, sourcePath, targetPath: value });
  }

  const contextMenuItems: MenuProps["items"] = [
    { key: "rename", label: "重命名" },
    { key: "copyPath", label: "复制完整路径" },
    ...(contextMenu?.entry.fileType !== "directory" ? [{ key: "download", label: "下载" }] : []),
    { key: "copy", label: "复制到" },
    { key: "move", label: "移动到" },
    { type: "divider" },
    { key: "delete", label: "删除", danger: true },
  ];

  function handleContextMenuClick(key: string) {
    const entry = contextMenu?.entry;
    setContextMenu(null);
    if (!entry) return;
    const fullPath = entry.path || joinPath(path, entry.name);
    if (key === "rename") setDialog({ kind: "rename", entry, value: entry.name });
    if (key === "copyPath") void copyPath(entry);
    if (key === "download" && entry.fileType !== "directory") void downloadFile(fullPath, entry.name);
    if (key === "copy") setDialog({ kind: "copy", entry, value: getParentPath(fullPath) });
    if (key === "move") setDialog({ kind: "move", entry, value: getParentPath(fullPath) });
    if (key === "delete") {
      modal.confirm({
        title: "删除文件",
        content: fullPath,
        okText: "删除",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: () => {
          startBackgroundOperation({ kind: "delete", sourcePath: fullPath });
        },
      });
    }
  }

  async function downloadFile(remotePath: string, fileName: string) {
    try {
      await onDownloadFile(remotePath, fileName);
      message.success(`已开始下载 ${fileName}`);
    } catch (error) {
      message.error(getErrorMessage(error));
    }
  }

  return (
    <section className="filePanel">
      <div className="fileWorkspace">
        <div className="fileTopArea">
        <div className="fileToolbar">
          <Space className="fileToolbarActions" size={4}>
            <Tooltip title="常用命令">
              <Button
                aria-label="常用命令"
                className={`fileCommandDropdownButton${quickCommandOpen ? " fileCommandDropdownButton-active" : ""}`}
                icon={<CodeOutlined />}
                size="small"
                onClick={() => setQuickCommandOpen((prev) => !prev)}
              >
                {quickCommandOpen ? <UpOutlined className="fileToolbarDropdownArrow" /> : <DownOutlined className="fileToolbarDropdownArrow" />}
              </Button>
            </Tooltip>
            <Input
              size="small"
              placeholder="搜索文件"
              prefix={<SearchOutlined style={{ color: "#9ca3af" }} />}
              suffix={searching ? <LoadingOutlined className="fileSearchLoading" /> : null}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              allowClear
              disabled={!canUseFiles}
              style={{ width: 160 }}
            />
            <Tooltip title="新建">
              <Button
                aria-label="新建文件或目录"
                icon={<PlusOutlined />}
                size="small"
                disabled={!canUseFiles}
                onClick={openCreateDialog}
              />
            </Tooltip>
            <Tooltip title="上级目录">
              <Button
                aria-label="上级目录"
                icon={<ArrowUpOutlined />}
                size="small"
                onClick={goParent}
                disabled={!canUseFiles || path === "/"}
              />
            </Tooltip>
            <Tooltip title={canUseFiles ? "刷新" : "连接 SFTP"}>
              <Button
                aria-label={canUseFiles ? "刷新" : "连接 SFTP"}
                icon={<ReloadOutlined spin={refreshing} />}
                size="small"
                loading={refreshing}
                disabled={!canRefreshFiles}
                onClick={() => void refresh()}
              />
            </Tooltip>
          </Space>
        </div>

        {/* 常用命令折叠抽屉面板 - 向下展开 */}
        <div className={`quickCommandDrawer${quickCommandOpen ? " quickCommandDrawer-open" : ""}`}>
            <div className="quickCommandDrawerHeader">
              <span className="quickCommandDrawerTitle">
                <CodeOutlined />
                常用命令
                <small>({commandItems.length})</small>
              </span>
              <button type="button" className="quickCommandAdd" onClick={() => openCommandDialog()}>
                <PlusOutlined />
                <span>添加</span>
              </button>
            </div>
            <div className="quickCommandScrollList">
              {commandItems.length === 0 ? (
                <div className="quickCommandEmpty">暂无命令，点击上方添加</div>
              ) : (
                commandItems.map((item) => (
                  <Tooltip
                    key={item.id}
                    title={quickCommandDetailTooltip(item)}
                    placement="bottom"
                    overlayClassName="detailHoverTooltip"
                  >
                    <span
                      className="quickCommandTag"
                      role="button"
                      tabIndex={0}
                      onClick={() => void sendQuickCommand(item)}
                      onKeyDown={(event) => { if (event.key === "Enter") void sendQuickCommand(item); }}
                    >
                      {item.name}
                      <span className="quickCommandTagActions">
                        <Button
                          aria-label={`编辑 ${item.name}`}
                          size="small"
                          type="text"
                          icon={<EditOutlined />}
                          onClick={(event) => {
                            event.stopPropagation();
                            openCommandDialog(item);
                          }}
                        />
                        <Button
                          aria-label={`删除 ${item.name}`}
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteQuickCommand(item);
                          }}
                        />
                      </span>
                    </span>
                  </Tooltip>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="fileContent" ref={contentRef}>
          <div className="pathTree">
            {canUseFiles ? (
              <>
                <button
                  type="button"
                  className={`pathTreeRoot${path === "/" ? " pathTreeRoot-selected" : ""}`}
                  onClick={() => {
                    onPathChange("/");
                    setSearchText("");
                    setFocusedPath(null);
                    setDirectoryExpandedKeys((current) => uniqueKeys(["/", ...current]));
                    void loadDirectory("/");
                  }}
                >
                  <FolderOutlined />
                  <span>/</span>
                </button>
                <Tree
                  className="pathTreeList"
                  showIcon
                  blockNode
                  virtual={false}
                  expandAction={false}
                  selectedKeys={path === "/" ? [] : [path]}
                  expandedKeys={directoryExpandedKeys}
                  treeData={treeData}
                  switcherIcon={({ isLeaf }) => (isLeaf ? null : <span className="pathTreeChevron" />)}
                  loadData={(node) => loadDirectory(String(node.key))}
                  onExpand={(keys, info) => {
                    setDirectoryExpandedKeys(keys.map(String));
                    if (info.expanded) void loadDirectory(String(info.node.key));
                  }}
                  onClick={(event, node) => {
                    if (isTreeSwitcherClick(event.target)) return;
                    openDirectoryFromTree(String(node.key));
                  }}
                />
              </>
            ) : (
              <div className="pathTreeUnavailable">
                <FolderOutlined />
                <span>SFTP 未连接</span>
              </div>
            )}
          </div>
          <div
            className={`fileTableSurface${canUseFiles ? "" : " fileTableSurface-disabled"}`}
            onClick={() => setContextMenu(null)}
            onDragOver={(event) => {
              if (!canUseFiles) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              if (!canUseFiles) return;
              event.preventDefault();
              setDragging(false);
              const paths = Array.from(event.dataTransfer.files)
                .map((file) => (file as File & { path?: string }).path)
                .filter(Boolean) as string[];
              void uploadPaths(paths);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          >
            <Table
              rowKey={(entry) => entry.path || `${path}/${entry.name}`}
              size="small"
              columns={resizableColumns}
              components={tableComponents}
              dataSource={files}
              loading={tableLoading}
              tableLayout="fixed"
              showSorterTooltip={false}
              rowClassName={(entry) => (focusedPath && entry.path === focusedPath ? "fileTableRow-focused" : "")}
              pagination={false}
              onRow={(entry) => ({
                onDoubleClick: () => openDirectory(entry),
                onContextMenu: (event) => {
                  if (!canUseFiles) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setContextMenu(null);
                  setContextMenu({ entry, x: event.clientX, y: event.clientY });
                },
                style: { cursor: entry.fileType === "directory" ? "pointer" : "default" },
              })}
              scroll={{ x: tableScrollX, y: tableScrollY }}
              locale={{ emptyText: canUseFiles ? (searchText ? "无匹配文件" : "目录为空") : "SFTP 可用后显示文件" }}
            />
            <Dropdown
              open={Boolean(contextMenu)}
              disabled={!canUseFiles}
              trigger={[]}
              menu={{
                items: contextMenuItems,
                onClick: ({ key }) => handleContextMenuClick(String(key)),
              }}
              onOpenChange={(open) => {
                if (!open) setContextMenu(null);
              }}
            >
              <span
                className="fileContextMenuAnchor"
                style={{ left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }}
              />
            </Dropdown>
            {dragging && <div className="fileDropOverlay">拖放到当前目录上传</div>}
          </div>
        </div>
      </div>
      <Modal
        open={commandDialogOpen}
        className="commandDialogModal"
        title={commandEditingId ? "编辑常用命令" : "添加常用命令"}
        okText={commandEditingId ? "保存" : "添加"}
        cancelText="取消"
        onCancel={() => {
          setCommandDialogOpen(false);
          setCommandEditingId(null);
        }}
        onOk={addQuickCommand}
        destroyOnHidden
      >
        <Form layout="vertical">
          <Form.Item label="名称">
            <Input
              autoFocus
              value={commandName}
              onChange={(event) => setCommandName(event.target.value)}
              onPressEnter={addQuickCommand}
            />
          </Form.Item>
          <Form.Item label="命令">
            <Input.TextArea
              className="commandDialogTextarea"
              autoSize={{ minRows: 6, maxRows: 14 }}
              value={commandValue}
              onChange={(event) => setCommandValue(event.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        open={Boolean(dialog)}
        title={dialogTitle(dialog)}
        okText="执行"
        cancelText="取消"
        onCancel={() => setDialog(null)}
        onOk={submitDialog}
        destroyOnHidden
        className="fileOperationModal"
      >
        {dialog?.kind === "create" && (
          <Form layout="vertical">
            <Form.Item label="类型">
              <Radio.Group
                value={dialog.entryType}
                onChange={(event) => setDialog({ ...dialog, entryType: event.target.value })}
                options={[
                  { label: "文件", value: "file" },
                  { label: "目录", value: "directory" },
                ]}
              />
            </Form.Item>
            <Form.Item label="名称">
              <Input
                autoFocus
                placeholder={dialog.entryType === "file" ? "new-file.txt" : "new-folder"}
                value={dialog.name}
                onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
                onPressEnter={submitDialog}
              />
            </Form.Item>
          </Form>
        )}
        {dialog?.kind === "rename" && (
          <Form layout="vertical">
            <Form.Item label="新名称">
              <Input
                autoFocus
                value={dialog.value}
                onChange={(event) => setDialog({ ...dialog, value: event.target.value })}
                onPressEnter={submitDialog}
              />
            </Form.Item>
          </Form>
        )}
        {(dialog?.kind === "copy" || dialog?.kind === "move") && (
          <Form layout="vertical">
            <div className="fileOperationTree">
              <Tree
                showIcon
                blockNode
                virtual={false}
                expandAction={false}
                selectedKeys={[dialog.value]}
                expandedKeys={directoryExpandedKeys}
                treeData={treeData}
                switcherIcon={({ isLeaf }) => (isLeaf ? null : <span className="pathTreeChevron" />)}
                loadData={(node) => loadDirectory(String(node.key))}
                onExpand={(keys, info) => {
                  setDirectoryExpandedKeys(keys.map(String));
                  if (info.expanded) void loadDirectory(String(info.node.key));
                }}
                onClick={(event, node) => {
                  if (isTreeSwitcherClick(event.target)) return;
                  const selectedPath = normalizePath(String(node.key));
                  setDialog({ ...dialog, value: selectedPath });
                  toggleDirectory(selectedPath);
                }}
              />
            </div>
            <Form.Item label={dialog.kind === "copy" ? "复制到路径" : "移动到路径"}>
              <Input
                autoFocus
                prefix={<FolderAddOutlined />}
                placeholder="/目标目录/或/完整目标路径"
                value={dialog.value}
                onChange={(event) => {
                  setDialog({ ...dialog, value: event.target.value });
                  setDirectoryExpandedKeys((current) => uniqueKeys([...current, ...getDirectoryAncestorPaths(event.target.value)]));
                }}
                onPressEnter={submitDialog}
              />
            </Form.Item>
            <div className="fileOperationHint">可以从目录树选择，也可以输入目录或完整目标路径。</div>
          </Form>
        )}
      </Modal>
      <Modal
        open={Boolean(editor)}
        centered
        title={
          <div className="fileEditorTitle">
            <span title={editor?.path ?? ""}>{editor?.path ?? ""}</span>
            <Tooltip title="独立窗口">
              <Button
                aria-label="独立窗口"
                size="small"
                icon={<ExportOutlined />}
                disabled={!editor}
                onClick={(event) => {
                  event.stopPropagation();
                  void detachEditor();
                }}
              />
            </Tooltip>
          </div>
        }
        onCancel={() => setEditor(null)}
        footer={[
          <Button key="close" onClick={() => setEditor(null)}>
            关闭
          </Button>,
          <Button
            key="save"
            type="primary"
            icon={<SaveOutlined />}
            loading={editor?.saving}
            className="fileEditorSaveButton"
            onClick={() => void saveEditor()}
          >
            保存
          </Button>,
        ]}
        width={820}
        className="fileEditorModal"
        destroyOnHidden
      >
        <Suspense fallback={<EditorFallback />}>
          <CodeEditor
            path={editor?.path ?? ""}
            value={editor?.content ?? ""}
            onChange={(content) => editor && setEditor({ ...editor, content })}
            onFormatJson={(content) => editor && setEditor({ ...editor, content })}
          />
        </Suspense>
      </Modal>
    </section>
  );
}

function EditorFallback() {
  return (
    <div className="fileEditorLoading">
      <Spin />
    </div>
  );
}

function dialogTitle(dialog: FileDialogState | null) {
  if (!dialog) return "";
  if (dialog.kind === "create") return "新建文件或目录";
  if (dialog.kind === "rename") return "重命名";
  if (dialog.kind === "copy") return "复制到";
  return "移动到";
}

function getFileName(path: string) {
  return path.split("/").filter(Boolean).pop() || path || "文件";
}

function operationLabel(operation: FileOperation) {
  if (operation.kind === "create") return operation.entryType === "directory" ? "新建目录" : "新建文件";
  if (operation.kind === "rename") return "重命名";
  if (operation.kind === "copy") return "复制";
  if (operation.kind === "move") return "移动";
  return "删除";
}

function buildTreeData(
  entriesByPath: Record<string, RemoteFileEntry[]>,
  currentPath: string,
  loadingKeys: Set<string>,
): DataNode[] {
  const normalizedCurrentPath = normalizePath(currentPath);
  const rootChildren = buildDirectoryChildren("/", entriesByPath, normalizedCurrentPath, loadingKeys, new Set(["/"]));
  if (rootChildren.length > 0) return rootChildren;
  return [buildDirectoryNode("/", entriesByPath, normalizedCurrentPath, loadingKeys, new Set())];
}

function buildDirectoryNode(
  directoryPath: string,
  entriesByPath: Record<string, RemoteFileEntry[]>,
  currentPath: string,
  loadingKeys: Set<string>,
  ancestors: Set<string>,
): DataNode {
  const normalizedPath = normalizePath(directoryPath);
  const entries = entriesByPath[normalizedPath];
  const loading = loadingKeys.has(normalizedPath);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(normalizedPath);
  const children = buildDirectoryChildren(normalizedPath, entriesByPath, currentPath, loadingKeys, nextAncestors);
  return {
    title: getDirectoryTitle(normalizedPath),
    key: normalizedPath,
    icon: loading ? <LoadingOutlined /> : <FolderOutlined />,
    isLeaf: Boolean(entries) && children.length === 0,
    ...(children.length > 0 ? { children } : {}),
  };
}

function buildDirectoryChildren(
  directoryPath: string,
  entriesByPath: Record<string, RemoteFileEntry[]>,
  currentPath: string,
  loadingKeys: Set<string>,
  ancestors: Set<string>,
): DataNode[] {
  const childPaths = new Map<string, string>();
  const entries = entriesByPath[directoryPath] ?? [];
  for (const entry of entries) {
    if (entry.fileType !== "directory") continue;
    if (!entry.name || entry.name === "." || entry.name === "..") continue;
    const childPath = normalizePath(entry.path || joinPath(directoryPath, entry.name));
    if (getParentPath(childPath) !== directoryPath) continue;
    if (childPath === directoryPath || ancestors.has(childPath)) continue;
    childPaths.set(childPath, entry.name);
  }

  const activeChildPath = getActiveChildPath(directoryPath, currentPath);
  if (activeChildPath && activeChildPath !== directoryPath && !ancestors.has(activeChildPath) && !childPaths.has(activeChildPath)) {
    childPaths.set(activeChildPath, getDirectoryTitle(activeChildPath));
  }

  return Array.from(childPaths.keys())
    .sort(comparePathName)
    .map((childPath) => buildDirectoryNode(childPath, entriesByPath, currentPath, loadingKeys, ancestors));
}

function getActiveChildPath(directoryPath: string, currentPath: string) {
  const parentSegments = getPathSegments(directoryPath);
  const currentSegments = getPathSegments(currentPath);
  if (parentSegments.length >= currentSegments.length) return null;
  if (parentSegments.some((segment, index) => segment !== currentSegments[index])) return null;
  return joinPath(directoryPath, currentSegments[parentSegments.length]);
}

function getDirectoryTitle(path: string) {
  const segments = getPathSegments(path);
  return segments[segments.length - 1] ?? "/";
}

function getDirectoryAncestorPaths(path: string) {
  const segments = getPathSegments(path);
  const paths = ["/"];
  let current = "/";
  for (const segment of segments) {
    current = joinPath(current, segment);
    paths.push(current);
  }
  return paths;
}

function uniqueKeys(keys: string[]) {
  return Array.from(new Set(keys));
}

function filesBelongToDirectory(files: RemoteFileEntry[], directoryPath: string) {
  const normalizedDirectory = normalizePath(directoryPath);
  return files.every((entry) => {
    if (!entry.path) return true;
    return getParentPath(entry.path) === normalizedDirectory;
  });
}

function sortRemoteEntries(entries: RemoteFileEntry[]) {
  return [...entries].sort((a, b) => compareEntryGroup(a, b) || compareEntryName(a, b));
}

function compareEntryGroup(a: RemoteFileEntry, b: RemoteFileEntry) {
  return entryGroupWeight(a) - entryGroupWeight(b);
}

function entryGroupWeight(entry: RemoteFileEntry) {
  if (entry.fileType === "directory") return 0;
  if (entry.fileType === "file") return 1;
  if (entry.fileType === "symlink") return 2;
  return 3;
}

function compareEntryName(a: RemoteFileEntry, b: RemoteFileEntry) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function fileCategoryMeta(entry: RemoteFileEntry): {
  category: FileCategory;
  label: string;
  description: string;
  icon: React.ReactNode;
} {
  const category = fileCategory(entry);
  const map: Record<FileCategory, { label: string; description: string; icon: React.ReactNode }> = {
    directory: { label: "文件夹", description: "目录", icon: <FolderOutlined /> },
    archive: { label: "压缩包", description: "压缩包 / 归档文件", icon: <FileZipOutlined /> },
    script: { label: "脚本", description: "Shell / Python / Node / PowerShell 等脚本", icon: <CodeOutlined /> },
    document: { label: "文档", description: "Markdown / PDF / Office / README 等文档", icon: documentIcon(entry.name) },
    log: { label: "日志", description: "日志文件", icon: <BookOutlined /> },
    text: { label: "文本", description: "纯文本文件", icon: <FileTextOutlined /> },
    media: { label: "媒体", description: "图片 / 音频 / 视频文件", icon: <FileImageOutlined /> },
    env: { label: "环境变量", description: "环境变量或 dotenv 配置", icon: <SettingOutlined /> },
    config: { label: "配置", description: "配置文件", icon: <SettingOutlined /> },
    data: { label: "数据", description: "JSON / YAML / CSV / SQL 等数据文件", icon: <DatabaseOutlined /> },
    binary: { label: "可执行", description: "可执行程序或二进制文件", icon: <PlaySquareOutlined /> },
    symlink: { label: "链接", description: "符号链接", icon: <ExportOutlined /> },
    other: { label: "文件", description: "普通文件", icon: <FileTextOutlined /> },
  };
  return { category, ...map[category] };
}

function fileCategory(entry: RemoteFileEntry): FileCategory {
  if (entry.fileType === "directory") return "directory";
  if (entry.fileType === "symlink") return "symlink";
  const name = entry.name.toLowerCase();
  const ext = fileExtension(name);
  if (isEnvFile(name)) return "env";
  if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war", "apk", "deb", "rpm"].includes(ext)) return "archive";
  if (["sh", "bash", "zsh", "fish", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "ps1", "bat", "cmd", "lua", "rb", "pl"].includes(ext)) return "script";
  if (["md", "markdown", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf"].includes(ext) || /^readme(?:\.|$)/.test(name)) return "document";
  if (["log", "out", "err", "trace"].includes(ext) || name.endsWith(".log.1")) return "log";
  if (["txt", "text", "ini", "conf", "properties", "service"].includes(ext)) return "text";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "mp4", "mov", "avi", "mkv", "mp3", "wav", "flac"].includes(ext)) return "media";
  if (["json", "yaml", "yml", "toml", "xml", "csv", "tsv", "sql", "db", "sqlite"].includes(ext)) return "data";
  if (["config", "cnf", "cfg"].includes(ext) || ["dockerfile", "nginx.conf", "package.json", "tsconfig.json"].includes(name)) return "config";
  if (["exe", "bin", "run", "appimage"].includes(ext) || isExecutable(entry)) return "binary";
  return "other";
}

function fileExtension(name: string) {
  const trimmed = name.replace(/\.+$/g, "");
  const index = trimmed.lastIndexOf(".");
  return index > 0 ? trimmed.slice(index + 1) : "";
}

function isEnvFile(name: string) {
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
}

function isExecutable(entry: RemoteFileEntry) {
  return entry.fileType === "file" && /x/.test(entry.permissions.slice(1));
}

function documentIcon(name: string) {
  const ext = fileExtension(name.toLowerCase());
  if (ext === "md" || ext === "markdown") return <FileMarkdownOutlined />;
  if (ext === "pdf") return <FilePdfOutlined />;
  return <FileTextOutlined />;
}

function formatBeijingModifiedTime(value: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = beijingTimeFormatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function quickCommandDetailTooltip(command: QuickCommand) {
  return (
    <div className="detailHoverPanel">
      <div className="detailHoverTitle">{command.name}</div>
      <div className="detailHoverCommand">{command.command}</div>
      {command.createdAt && (
        <div className="detailHoverGrid">
          <span>创建时间</span>
          <strong>{formatBeijingModifiedTime(command.createdAt)}</strong>
        </div>
      )}
    </div>
  );
}

function comparePathName(a: string, b: string) {
  return getDirectoryTitle(a).localeCompare(getDirectoryTitle(b), undefined, { numeric: true, sensitivity: "base" });
}

import { App as AntdApp, Button, ConfigProvider, Spin, message, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useRef, useState } from "react";
import { CodeEditor } from "./CodeEditor";
import { editorChannelName, type EditorChannelMessage } from "../lib/editorChannel";

export function EditorWindowApp() {
  const editorId = new URLSearchParams(window.location.search).get("editorWindow") ?? "";
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (!editorId) return;
    const channel = new BroadcastChannel(editorChannelName(editorId));
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<EditorChannelMessage>) => {
      const payload = event.data;
      if (payload.type === "init") {
        setPath(payload.path);
        setContent(payload.content);
        setReady(true);
      }
      if (payload.type === "saved") {
        setSaving(false);
        message.open({ key: "detached-editor-save", type: "success", content: "文件已保存", duration: 2 });
      }
      if (payload.type === "error") {
        setSaving(false);
        message.error(payload.message);
      }
    };
    channel.postMessage({ type: "ready" } satisfies EditorChannelMessage);
    const close = () => {
      try {
        channel.postMessage({ type: "close" } satisfies EditorChannelMessage);
      } catch {
        // 窗口关闭时 channel 可能已被 WebView 回收。
      }
    };
    window.addEventListener("beforeunload", close);
    return () => {
      window.removeEventListener("beforeunload", close);
      if (channelRef.current === channel) channelRef.current = null;
      channel.close();
    };
  }, [editorId, message]);

  function updateContent(value: string) {
    setContent(value);
    channelRef.current?.postMessage({ type: "change", content: value } satisfies EditorChannelMessage);
  }

  function save() {
    setSaving(true);
    channelRef.current?.postMessage({ type: "save", content } satisfies EditorChannelMessage);
  }

  return (
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm }}>
      <AntdApp>
        <main className="detachedEditorWindow">
          <header className="detachedEditorHeader">
            <div>
              <strong>{path || "文件编辑器"}</strong>
              <span>内容仅保存在当前窗口内存中，不写入本地临时文件。</span>
            </div>
            <Button
              type="primary"
              className="editorPrimarySaveButton"
              loading={saving}
              disabled={!ready}
              onClick={save}
            >
              保存
            </Button>
          </header>
          {ready ? (
            <CodeEditor
              path={path}
              value={content}
              height="100%"
              onChange={updateContent}
              onFormatJson={updateContent}
            />
          ) : (
            <div className="detachedEditorLoading">
              <Spin />
            </div>
          )}
        </main>
      </AntdApp>
    </ConfigProvider>
  );
}

import { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "antd/dist/reset.css";
import "./styles.css";
import { isTauriRuntime } from "./api/runtime";

const isEditorWindow = new URLSearchParams(window.location.search).has("editorWindow");
const App = lazy(() => import("./App"));
const EditorWindowApp = lazy(() =>
  import("./components/EditorWindowApp").then((module) => ({ default: module.EditorWindowApp })),
);

function BootFallback() {
  return (
    <div className="bootScreen" role="status" aria-live="polite">
      <img className="bootMark" src="./nexus_icon.svg" alt="" aria-hidden="true" />
      <div>
        <strong>HelM</strong>
        <span>正在启动...</span>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <Suspense fallback={<BootFallback />}>
    {isEditorWindow ? <EditorWindowApp /> : <App />}
  </Suspense>,
);

if (!isEditorWindow && isTauriRuntime()) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      void invoke("frontend_ready");
    });
  });
}

import { ApartmentOutlined, ApiOutlined, AppleOutlined, CheckCircleOutlined, CheckOutlined, CloudDownloadOutlined, CopyOutlined, DatabaseOutlined, DesktopOutlined, ExclamationCircleOutlined, ExportOutlined, EyeInvisibleOutlined, FolderOpenOutlined, FundProjectionScreenOutlined, InfoCircleOutlined, LinkOutlined, ReloadOutlined, RocketOutlined, SyncOutlined, WindowsOutlined } from "@ant-design/icons";
import { Button, Form, Input, InputNumber, Modal, Select, Space, Switch, Tooltip, Typography, message } from "antd";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { AppInfo, AppSettings, UpdateInfo } from "../types";
import { appApi, type ApiServerInfo, type ApiLogEntry } from "../api/appApi";
import { vaultApi } from "../api/vaultApi";

interface SettingsModalProps {
  open: boolean;
  initialValue: AppSettings;
  sessions: { id: string; name: string; host: string; state: string }[];
  onClose: () => void;
  onSubmit: (settings: AppSettings) => Promise<void>;
  onBackupOpen: () => void;
  onTunnelOpen: () => void;
  onApiServerChange: (running: boolean) => void;
  aiApiOpen: boolean;
  onAiApiOpenChange: (open: boolean) => void;
  appInfo: AppInfo | null;
  updateInfo: UpdateInfo | null;
  updateError: string | null;
  updateChecking: boolean;
  updateDownloading: boolean;
  downloadedUpdatePath: string | null;
  updateRepo: string;
  onCheckUpdate: (manual?: boolean) => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onIgnoreUpdate: () => Promise<void>;
  onOpenDatabaseDir: () => Promise<void>;
  onOpenPathDir: (path: string) => Promise<void>;
  onOpenExternalUrl: (url: string) => Promise<void>;
}

interface SettingsFormValues {
  enabled: boolean;
  kind: "socks5" | "httpConnect";
  host: string;
  port: number;
}

export function SettingsModal({
  open,
  initialValue,
  sessions,
  onClose,
  onSubmit,
  onBackupOpen,
  onTunnelOpen,
  onApiServerChange,
  aiApiOpen,
  onAiApiOpenChange,
  appInfo,
  updateInfo,
  updateError,
  updateChecking,
  updateDownloading,
  downloadedUpdatePath,
  updateRepo,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
  onIgnoreUpdate,
  onOpenDatabaseDir,
  onOpenPathDir,
  onOpenExternalUrl,
}: SettingsModalProps) {
  const [form] = Form.useForm<SettingsFormValues>();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [aiApiInfo, setAiApiInfo] = useState<ApiServerInfo | null>(null);
  const [aiApiLoading, setAiApiLoading] = useState(false);
  const [aiApiPort, setAiApiPort] = useState(() => initialValue.aiApiPort ?? 19880);
  const [aiApiCopied, setAiApiCopied] = useState(false);
  const [aiApiAutoStart, setAiApiAutoStart] = useState(() => initialValue.aiApiAutoStart ?? false);
  const [aiApiSessionId, setAiApiSessionId] = useState<string | null>(() => {
    const saved = initialValue.aiApiSessionId ?? null;
    if (saved && sessions.some((s) => s.id === saved)) return saved;
    return null;
  });
  const [aiApiLogs, setAiApiLogs] = useState<ApiLogEntry[]>([]);
  const enabled = Form.useWatch("enabled", form);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      enabled: initialValue.proxy?.enabled ?? false,
      kind: initialValue.proxy?.kind ?? "socks5",
      host: initialValue.proxy?.host ?? "127.0.0.1",
      port: initialValue.proxy?.port ?? 1080,
    });
    setAiApiSessionId(initialValue.aiApiSessionId ?? null);
    setAiApiPort(initialValue.aiApiPort ?? 19880);
    setAiApiAutoStart(initialValue.aiApiAutoStart ?? false);
  }, [form, initialValue, open]);

  useEffect(() => {
    if (!aiApiOpen) return;
    const poll = () => void appApi.apiServerLogs().then(setAiApiLogs).catch(() => undefined);
    poll();
    void refreshAiApiStatus();
    if (!aiApiInfo?.running) return;
    const timer = setInterval(poll, 500);
    return () => clearInterval(timer);
  }, [aiApiOpen, aiApiInfo?.running]);

  async function submit() {
    const values = await form.validateFields();
    await onSubmit({
      ...initialValue,
      proxy: values.enabled
        ? {
            enabled: true,
            kind: values.kind,
            host: values.host.trim(),
            port: values.port,
          }
        : null,
    });
  }

  async function refreshAiApiStatus() {
    try {
      const info = await appApi.apiServerStatus();
      setAiApiInfo(info);
      onApiServerChange(info.running);
      if (info.running && info.port) setAiApiPort(info.port);
    } catch {
      setAiApiInfo(null);
    }
  }

  async function startAiApi() {
    setAiApiLoading(true);
    try {
      const info = await appApi.apiServerStart(aiApiPort, aiApiSessionId);
      setAiApiInfo(info);
      onApiServerChange(true);
      // 持久化端口配置
      await vaultApi.settingsUpdate({ ...initialValue, aiApiPort, aiApiSessionId, aiApiAutoStart }).catch(() => undefined);
    } catch (error) {
      Modal.error({ title: "启动 API 服务失败", content: String(error) });
    } finally {
      setAiApiLoading(false);
    }
  }

  async function stopAiApi() {
    setAiApiLoading(true);
    try {
      await appApi.apiServerStop();
      setAiApiInfo({ running: false, port: 0, apiKey: "" });
      onApiServerChange(false);
    } catch (error) {
      Modal.error({ title: "停止 API 服务失败", content: String(error) });
    } finally {
      setAiApiLoading(false);
    }
  }

  async function regenerateKey() {
    try {
      const info = await appApi.apiServerRegenerateKey();
      setAiApiInfo(info);
      message.success("API Key 已重新生成");
    } catch (error) {
      Modal.error({ title: "重新生成密钥失败", content: String(error) });
    }
  }

  async function changeAiApiSession(sessionId: string | null) {
    setAiApiSessionId(sessionId);
    // Persist silently without triggering parent state update
    try {
      await vaultApi.settingsUpdate({ ...initialValue, aiApiSessionId: sessionId, aiApiPort, aiApiAutoStart });
      const sessionName = sessions.find((s) => s.id === sessionId)?.name;
      message.success(sessionId ? `已切换至「${sessionName}」` : "已清除会话限制");
    } catch {
      message.error("保存失败");
    }
    // If server is running, restart with new session filter
    if (aiApiInfo?.running) {
      try {
        await appApi.apiServerStop();
        const info = await appApi.apiServerStart(aiApiPort, sessionId);
        setAiApiInfo(info);
      } catch (error) {
        Modal.error({ title: "重启 API 服务失败", content: String(error) });
      }
    }
  }

  async function changeAiApiAutoStart(checked: boolean) {
    setAiApiAutoStart(checked);
    try {
      await vaultApi.settingsUpdate({ ...initialValue, aiApiAutoStart: checked, aiApiSessionId, aiApiPort });
      message.success(checked ? "已开启随应用自动启动" : "已关闭自动启动");
    } catch {
      message.error("保存失败");
      setAiApiAutoStart(!checked);
    }
  }

  async function openLogWindow() {
    try {
      const { isTauriRuntime } = await import("../api/runtime");
      if (isTauriRuntime()) {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const existing = await WebviewWindow.getByLabel("api-logs");
        if (existing) {
          await existing.setFocus();
          return;
        }
        const webview = new WebviewWindow("api-logs", {
          url: "index.html?logWindow=1",
          title: "AI API 操作日志",
          width: 680,
          height: 480,
          minWidth: 480,
          minHeight: 320,
          resizable: true,
        });
        await webview.once("tauri://error", (event) => {
          message.error(String(event.payload));
        });
      } else {
        window.open(
          `${window.location.origin}${window.location.pathname}?logWindow=1`,
          "api-logs",
          "width=680,height=480",
        );
      }
    } catch (error) {
      message.error(String(error));
    }
  }

  function copyApiInfo() {
    if (!aiApiInfo?.running) return;
    const selectedSession = aiApiSessionId ? sessions.find((s) => s.id === aiApiSessionId) : null;
    const sid = selectedSession ? selectedSession.id : "<sessionId>";
    const base = `http://127.0.0.1:${aiApiInfo.port}`;
    const text = [
      "# HelM 远程服务器 API",
      "",
      "## 认证",
      `Base URL: ${base}`,
      `Header: Authorization: Bearer ${aiApiInfo.apiKey}`,
      ...(selectedSession
        ? [`会话: ${selectedSession.name} (${selectedSession.host})`, `Session ID: ${sid}`]
        : ["模式: 全部会话（先调 GET /api/sessions 获取 sessionId）"]),
      "",
      "## 远程操作",
      "",
      `| 接口 | 说明 | 参数 |`,
      `|------|------|------|`,
      `| GET /api/sessions | 列出已连接会话 | — |`,
      `| POST /api/exec | 执行命令 | {sessionId, command, timeoutMs?} → {exitCode, stdout, stderr} |`,
      `| POST /api/upload | 上传文件 | multipart: sessionId, remotePath, file |`,
      `| GET /api/files | 浏览目录 | ?sessionId=&path= → [{name, path, fileType, size}] |`,
      `| GET /api/download | 下载文件 | ?sessionId=&path= → 二进制流 |`,
      "",
      "## 隧道管理",
      "",
      `| 接口 | 说明 | 参数 |`,
      `|------|------|------|`,
      `| GET /api/tunnels | 列出隧道模板 | — |`,
      `| POST /api/tunnels/create | 新建隧道 | {name, sessionId, forwardType: "local"/"remote"/"dynamic", bindHost, bindPort, targetHost, targetPort} |`,
      `| POST /api/tunnels/update | 编辑隧道 | {tunnelId, ...同上} |`,
      `| POST /api/tunnels/delete | 删除隧道 | {tunnelId} |`,
      `| POST /api/tunnels/start | 启动隧道 | {tunnelId} → {forwardId, bindHost, bindPort} |`,
      `| POST /api/tunnels/stop | 停止隧道 | {tunnelId: "forwardId"} |`,
      "",
      "## 数据备份",
      "",
      `| 接口 | 说明 | 参数 |`,
      `|------|------|------|`,
      `| GET /api/backup/settings | 获取备份配置 | — |`,
      `| POST /api/backup/settings | 更新备份配置 | {localDirectory, autoEnabled, frequency, retentionCount, retentionDays, cloud: {enabled, kind: "webdav"/"s3", webdav: {endpoint, username, password, remotePath}, s3: {endpoint, region, bucket, accessKeyId, secretAccessKey, prefix}}} |`,
      `| GET /api/backup/records | 列出备份记录 | — |`,
      `| POST /api/backup/run | 立即备份 | — |`,
      `| POST /api/backup/delete | 删除备份记录 | {recordId, deleteFile?} |`,
      "",
      "## 规则",
      "",
      "- 所有 POST 请求 Content-Type: application/json（upload 除外用 multipart）",
      `- sessionId 固定使用: ${sid}`,
      "- 路径使用绝对路径（如 /home/user/...）",
      "- 返回 503 表示会话未连接，需用户在 HelM 手动连接后重试，不要自动重连",
      "- API Key 持久有效，无需重复获取",
      "- 隧道启动前需确保对应会话已连接",
    ].join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setAiApiCopied(true);
      setTimeout(() => setAiApiCopied(false), 2000);
      message.success("已复制 API 使用说明");
    });
  }

  const canDownloadUpdate = Boolean(updateInfo?.hasUpdate && updateInfo.asset);
  const canInstallUpdate = Boolean(downloadedUpdatePath);
  const updateActionLoading = canInstallUpdate ? false : canDownloadUpdate ? updateDownloading : updateChecking;
  const updateActionLabel = canInstallUpdate ? "立即安装" : canDownloadUpdate ? "下载更新" : "检查更新";
  const updateActionIcon = canInstallUpdate ? (
    <RocketOutlined />
  ) : canDownloadUpdate ? (
    <CloudDownloadOutlined />
  ) : (
    <SyncOutlined spin={updateChecking} />
  );
  const handleUpdateAction = () => {
    if (canInstallUpdate) {
      void onInstallUpdate();
      return;
    }
    if (canDownloadUpdate) {
      void onDownloadUpdate();
      return;
    }
    void onCheckUpdate(true);
  };

  return (
    <>
    <Modal
      open={open}
      title="全局设置"
      className="settingsModal"
      okText="保存"
      cancelText="取消"
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <div className="settingsPanel">
          <div className="settingsSectionTitle">数据与连接</div>
          <div className="settingsShortcutGrid">
            <Button block icon={<ExportOutlined />} onClick={onBackupOpen}>
              数据备份与恢复
            </Button>
            <Button block icon={<ApartmentOutlined />} onClick={onTunnelOpen}>
              SSH 隧道管理
            </Button>
            <Button block icon={<ApiOutlined />} onClick={() => { onAiApiOpenChange(true); void refreshAiApiStatus(); }}>
              AI 接入
            </Button>
            <Button block icon={<InfoCircleOutlined />} onClick={() => setAboutOpen(true)}>
              关于版本
            </Button>
          </div>
        </div>
        <div className="settingsPanel">
          <div className="settingsProxyHeader">
            <span className="settingsSectionTitle">应用内全局代理</span>
            <Form form={form} component={false}>
              <Form.Item name="enabled" valuePropName="checked" noStyle>
                <Switch />
              </Form.Item>
            </Form>
          </div>
          <Form form={form} layout="vertical" requiredMark={false} className="settingsProxyForm">
            <Form.Item label="代理类型" name="kind">
              <Select
                disabled={!enabled}
                options={[
                  { label: "SOCKS5", value: "socks5" },
                  { label: "HTTP CONNECT", value: "httpConnect" },
                ]}
              />
            </Form.Item>
            <Form.Item label="代理主机" name="host" rules={enabled ? [{ required: true, message: "请输入代理主机" }] : []}>
              <Input disabled={!enabled} placeholder="127.0.0.1" />
            </Form.Item>
            <Form.Item label="代理端口" name="port" rules={enabled ? [{ required: true, message: "请输入代理端口" }] : []}>
              <InputNumber disabled={!enabled} min={1} max={65535} precision={0} style={{ width: "100%" }} />
            </Form.Item>
          </Form>
        </div>
      </Space>
      <Modal
        open={aboutOpen}
        title={null}
        className="aboutVersionModal"
        footer={null}
        closable
        onCancel={() => setAboutOpen(false)}
        width={420}
      >
        <div className="aboutHero">
          <div className="aboutHeroGlow" />
          <div className="aboutHeroIcon">
            <img src="./nexus_icon.svg" alt="" aria-hidden="true" />
          </div>
          <h2 className="aboutHeroTitle">HelM</h2>
          <span className="aboutHeroVersion">
            {updateRepo ? (
              <Tooltip title={`点击查看 v${appInfo?.version ?? "0.0.0"} 的 Release 页面`}>
                <Typography.Link
                  className="aboutVersionLink"
                  href={`https://github.com/${updateRepo}/releases/tag/v${appInfo?.version ?? "0.0.0"}`}
                  onClick={(event) => {
                    event.preventDefault();
                    void onOpenExternalUrl(`https://github.com/${updateRepo}/releases/tag/v${appInfo?.version ?? "0.0.0"}`);
                  }}
                >
                  v{appInfo?.version ?? "0.0.0"}
                </Typography.Link>
              </Tooltip>
            ) : (
              <span>v{appInfo?.version ?? "0.0.0"}</span>
            )}
          </span>
          <p className="aboutHeroTagline">安全、高效的 SSH 连接管理工具</p>
        </div>

        {/* 更新状态横幅 */}
        {updateInfo?.hasUpdate ? (
          <button
            type="button"
            className="aboutStatusBanner aboutStatusBanner--success aboutStatusBanner--action"
            onClick={() => setReleaseNotesOpen(true)}
            aria-label="查看更新日志"
          >
            <RocketOutlined className="aboutStatusIcon" />
            <div className="aboutStatusText">
              <strong>发现新版本 {updateInfo.tagName || `v${updateInfo.latestVersion}`}</strong>
              <span>
                {updateInfo.asset
                  ? `${updateInfo.asset.name} · ${formatBytes(updateInfo.asset.size)}`
                  : "当前 Release 没有找到 Windows 安装包"}
              </span>
            </div>
          </button>
        ) : updateInfo ? (
          <button
            type="button"
            className="aboutStatusBanner aboutStatusBanner--info aboutStatusBanner--action"
            onClick={() => setReleaseNotesOpen(true)}
            aria-label="查看更新日志"
          >
            <CheckCircleOutlined className="aboutStatusIcon" />
            <div className="aboutStatusText">
              <strong>当前已是最新版本 {updateInfo.tagName || `v${updateInfo.latestVersion}`}</strong>
              <span>点击查看更新日志</span>
            </div>
          </button>
        ) : updateError ? (
          <div className="aboutStatusBanner aboutStatusBanner--warning">
            <ExclamationCircleOutlined className="aboutStatusIcon" />
            <div className="aboutStatusText">
              <strong>检查更新失败</strong>
              <span>{updateError}</span>
            </div>
          </div>
        ) : !updateRepo ? (
          <div className="aboutStatusBanner aboutStatusBanner--warning">
            <ExclamationCircleOutlined className="aboutStatusIcon" />
            <div className="aboutStatusText">
              <strong>当前构建未配置更新仓库</strong>
              <span>GitHub Actions 发布版会自动写入仓库地址</span>
            </div>
          </div>
        ) : null}

        {/* 信息卡片 */}
        <div className="aboutInfoCards">
          <div className="aboutInfoCard">
            <span className="aboutInfoCardIcon">{systemIcon(appInfo?.os)}</span>
            <div className="aboutInfoCardContent">
              <span className="aboutInfoCardLabel">系统架构</span>
              <span className="aboutInfoCardValue">{(appInfo?.os ?? "--") + " / " + (appInfo?.arch ?? "--")}</span>
            </div>
          </div>
          <div className="aboutInfoCard">
            <span className="aboutInfoCardIcon"><DatabaseOutlined /></span>
            <div className="aboutInfoCardContent">
              <span className="aboutInfoCardLabel">数据库</span>
              <span className="aboutInfoCardValue aboutInfoCardValue--path">
                <Typography.Text ellipsis={{ tooltip: appInfo?.databasePath }}>
                  {appInfo?.databasePath ?? "--"}
                </Typography.Text>
                <Tooltip title="打开数据库目录">
                  <Button
                    type="text"
                    size="small"
                    icon={<FolderOpenOutlined />}
                    aria-label="打开数据库目录"
                    className="aboutPathBtn"
                    onClick={() => void onOpenDatabaseDir()}
                  />
                </Tooltip>
              </span>
            </div>
          </div>
          <div className="aboutInfoCard">
            <span className="aboutInfoCardIcon"><LinkOutlined /></span>
            <div className="aboutInfoCardContent">
              <span className="aboutInfoCardLabel">更新源</span>
              <span className="aboutInfoCardValue">
                {updateRepo ? (
                  <Tooltip title="点击在浏览器打开 GitHub 仓库">
                    <Typography.Link
                      href={`https://github.com/${updateRepo}`}
                      ellipsis
                      onClick={(event) => {
                        event.preventDefault();
                        void onOpenExternalUrl(`https://github.com/${updateRepo}`);
                      }}
                    >
                      {updateRepo}
                    </Typography.Link>
                  </Tooltip>
                ) : (
                  <Typography.Text type="secondary">未配置</Typography.Text>
                )}
              </span>
            </div>
          </div>
          {downloadedUpdatePath ? (
            <div className="aboutInfoCard">
              <span className="aboutInfoCardIcon"><FolderOpenOutlined /></span>
              <div className="aboutInfoCardContent">
                <span className="aboutInfoCardLabel">下载位置</span>
                <span className="aboutInfoCardValue aboutInfoCardValue--path">
                  <Typography.Text ellipsis={{ tooltip: downloadedUpdatePath }}>
                    {downloadedUpdatePath}
                  </Typography.Text>
                  <Tooltip title="打开下载目录">
                    <Button
                      type="text"
                      size="small"
                      icon={<FolderOpenOutlined />}
                      aria-label="打开下载目录"
                      className="aboutPathBtn"
                      onClick={() => void onOpenPathDir(downloadedUpdatePath)}
                    />
                  </Tooltip>
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {/* 操作按钮 */}
        <div className="aboutActions">
          <Button
            className="aboutUpdateBtn"
            block
            type={canInstallUpdate || canDownloadUpdate ? "primary" : "default"}
            icon={updateActionIcon}
            loading={updateActionLoading}
            disabled={!canInstallUpdate && (!updateRepo || (Boolean(updateInfo?.hasUpdate) && !updateInfo?.asset))}
            onClick={handleUpdateAction}
            size="large"
          >
            {updateActionLabel}
          </Button>
        </div>
      </Modal>
      <Modal
        open={releaseNotesOpen}
        title={null}
        className="releaseNotesModal"
        footer={null}
        onCancel={() => setReleaseNotesOpen(false)}
        destroyOnHidden
        width={520}
      >
        <div className="releaseNotesHeader">
          <div className="releaseNotesHeaderIcon">
            <RocketOutlined />
          </div>
          <div className="releaseNotesHeaderMeta">
            <span className="releaseNotesLabel">更新日志</span>
            <strong className="releaseNotesVersionTag">
              {updateInfo?.tagName || (updateInfo?.latestVersion ? `v${updateInfo.latestVersion}` : "--")}
            </strong>
          </div>
          {updateInfo?.publishedAt ? (
            <span className="releaseNotesDate">{formatReleaseDate(updateInfo.publishedAt)}</span>
          ) : null}
        </div>

        <div className="releaseNotesBody">{renderReleaseNotes(updateInfo)}</div>

        <div className="releaseNotesFooter">
          {updateInfo?.hasUpdate ? (
            <>
              <Button
                className="releaseNotesIgnoreBtn"
                icon={<EyeInvisibleOutlined />}
                onClick={() => {
                  void onIgnoreUpdate();
                  setReleaseNotesOpen(false);
                }}
              >
                忽略版本
              </Button>
              <Button
                className="aboutUpdateBtn releaseNotesDownloadBtn"
                type="primary"
                icon={<CloudDownloadOutlined />}
                loading={updateDownloading}
                disabled={!canDownloadUpdate}
                onClick={() => {
                  void onDownloadUpdate();
                  setReleaseNotesOpen(false);
                }}
              >
                下载更新
              </Button>
            </>
          ) : (
            <Button type="primary" onClick={() => setReleaseNotesOpen(false)}>
              关闭
            </Button>
          )}
        </div>
      </Modal>
    </Modal>
    <Modal
      open={aiApiOpen}
      title="AI 接入"
      className="aiApiModal"
      footer={null}
      onCancel={() => onAiApiOpenChange(false)}
      destroyOnHidden
      width={480}
    >
      <div className="aiApiContent">
        <div className="aiApiPanel">
          <div className="aiApiStatusRow">
            <span className="aiApiStatusLabel">服务状态</span>
            <span className={`aiApiStatusBadge aiApiStatusBadge-${aiApiInfo?.running ? "running" : "stopped"}`}>
              {aiApiInfo?.running ? "运行中" : "已停止"}
            </span>
            {aiApiLogs.length > 0 && (
              <Tooltip title="查看日志">
                <Button size="small" type="link" icon={<FundProjectionScreenOutlined />} onClick={() => void openLogWindow()} />
              </Tooltip>
            )}
          </div>
          <div className="aiApiFormRow">
            <span className="aiApiFormLabel">监听端口</span>
            <InputNumber
              min={1024}
              max={65535}
              precision={0}
              value={aiApiPort}
              disabled={aiApiInfo?.running}
              onChange={(value) => value && setAiApiPort(value)}
              style={{ width: 120 }}
            />
          </div>
          <div className="aiApiFormRow">
            <span className="aiApiFormLabel">指定会话</span>
            <Select
              style={{ flex: 1 }}
              placeholder="全部会话（AI 可访问所有已连接终端）"
              allowClear
              disabled={aiApiInfo?.running}
              value={aiApiSessionId}
              onChange={(value) => void changeAiApiSession(value ?? null)}
              options={sessions.map((s) => ({ label: s.name, value: s.id }))}
            />
          </div>
          <div className="aiApiFormRow">
            <span className="aiApiFormLabel">自动启动</span>
            <Switch
              checked={aiApiAutoStart}
              disabled={!aiApiSessionId}
              onChange={(checked) => void changeAiApiAutoStart(checked)}
            />
            {!aiApiSessionId && (
              <span style={{ fontSize: 12, color: "var(--text-tertiary, #999)" }}>需先指定会话</span>
            )}
          </div>
          {aiApiInfo?.running && aiApiInfo.apiKey && (
            <>
              <div className="aiApiFormRow">
                <span className="aiApiFormLabel">API 地址</span>
                <Input
                  readOnly
                  value={`http://127.0.0.1:${aiApiInfo.port}`}
                  style={{ flex: 1 }}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
              </div>
              <div className="aiApiFormRow">
                <span className="aiApiFormLabel">API Key</span>
                <Input.Password
                  readOnly
                  value={aiApiInfo.apiKey}
                  style={{ flex: 1 }}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <Tooltip title="重新生成密钥">
                  <Button
                    icon={<ReloadOutlined />}
                    size="small"
                    onClick={() => void regenerateKey()}
                  />
                </Tooltip>
              </div>
            </>
          )}
        </div>
        {aiApiInfo?.running && aiApiInfo.apiKey && (
          <div className="aiApiPanel aiApiPanel-endpoints">
            <div className="aiApiEndpointHeader">
              <div className="aiApiEndpointTitle">可用接口</div>
              <Tooltip title={aiApiCopied ? "已复制" : "复制 API 使用说明"}>
                <Button
                  icon={aiApiCopied ? <CheckOutlined style={{ color: "#10b981" }} /> : <CopyOutlined />}
                  size="small"
                  type="text"
                  onClick={copyApiInfo}
                />
              </Tooltip>
            </div>
            <div className="aiApiEndpointScroll">
              <div className="aiApiEndpointItem"><code>GET /api/sessions</code> — 列出已连接会话</div>
              <div className="aiApiEndpointItem"><code>POST /api/exec</code> — 执行命令</div>
              <div className="aiApiEndpointItem"><code>POST /api/upload</code> — 上传文件</div>
              <div className="aiApiEndpointItem"><code>GET /api/files</code> — 浏览目录</div>
              <div className="aiApiEndpointItem"><code>GET /api/download</code> — 下载文件</div>
              <div className="aiApiEndpointItem"><code>GET /api/tunnels</code> — 列出隧道模板</div>
              <div className="aiApiEndpointItem"><code>POST /api/tunnels/create</code> — 新建隧道</div>
              <div className="aiApiEndpointItem"><code>POST /api/tunnels/start</code> — 启动隧道</div>
              <div className="aiApiEndpointItem"><code>POST /api/tunnels/stop</code> — 停止隧道</div>
              <div className="aiApiEndpointItem"><code>GET /api/backup/settings</code> — 获取备份配置</div>
              <div className="aiApiEndpointItem"><code>POST /api/backup/run</code> — 立即备份</div>
              <div className="aiApiEndpointItem"><code>GET /api/backup/records</code> — 备份记录</div>
            </div>
            <p className="aiApiEndpointNote">请求头需携带 <code>Authorization: Bearer &lt;API Key&gt;</code></p>
          </div>
        )}
        <div className="aiApiActions">
          {aiApiInfo?.running ? (
            <Button danger loading={aiApiLoading} onClick={() => void stopAiApi()}>
              停止服务
            </Button>
          ) : (
            <Button type="primary" loading={aiApiLoading} disabled={!aiApiSessionId} onClick={() => void startAiApi()}>
              启动服务
            </Button>
          )}
        </div>
      </div>
    </Modal>
    </>
  );
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "未知大小";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function systemIcon(os?: string | null) {
  const value = os?.toLowerCase() ?? "";
  if (value.includes("windows")) return <WindowsOutlined />;
  if (value.includes("mac")) return <AppleOutlined />;
  return <DesktopOutlined />;
}

function formatReleaseDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

type ReleaseNotesBlock =
  | { type: "heading"; level: 2 | 3; text: string }
  | { type: "list"; items: string[] }
  | { type: "paragraph"; text: string };

function parseReleaseNotesMarkdown(body: string): ReleaseNotesBlock[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReleaseNotesBlock[] = [];
  let currentList: string[] | null = null;
  let currentParagraph: string[] | null = null;

  const flushList = () => {
    if (currentList && currentList.length > 0) blocks.push({ type: "list", items: currentList });
    currentList = null;
  };
  const flushParagraph = () => {
    if (currentParagraph && currentParagraph.length > 0) {
      blocks.push({ type: "paragraph", text: currentParagraph.join(" ") });
    }
    currentParagraph = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      flushParagraph();
      continue;
    }
    const h3 = line.match(/^###\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (h3) {
      flushList();
      flushParagraph();
      blocks.push({ type: "heading", level: 3, text: h3[1] });
      continue;
    }
    if (h2) {
      flushList();
      flushParagraph();
      blocks.push({ type: "heading", level: 2, text: h2[1] });
      continue;
    }
    if (listItem) {
      flushParagraph();
      currentList ??= [];
      currentList.push(listItem[1]);
      continue;
    }
    flushList();
    currentParagraph ??= [];
    currentParagraph.push(line);
  }
  flushList();
  flushParagraph();
  return blocks;
}

function renderInline(text: string) {
  // 处理 `inline code` 与 **加粗**；其余按普通文本保留
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderReleaseNotes(updateInfo: UpdateInfo | null) {
  const body = updateInfo?.body?.trim();
  if (!body) {
    return <div className="releaseNotesEmpty">当前版本没有填写更新日志。</div>;
  }
  const blocks = parseReleaseNotesMarkdown(body);
  return (
    <div className="releaseNotesContent">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Tag = block.level === 2 ? "h3" : "h4";
          return (
            <Tag key={index} className={`releaseNotesHeading releaseNotesHeading--h${block.level}`}>
              {renderInline(block.text)}
            </Tag>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={index} className="releaseNotesList">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={index} className="releaseNotesParagraph">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}

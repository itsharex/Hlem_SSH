import { ApartmentOutlined, AppleOutlined, CheckCircleOutlined, CloudDownloadOutlined, DatabaseOutlined, DesktopOutlined, ExclamationCircleOutlined, ExportOutlined, FolderOpenOutlined, InfoCircleOutlined, LinkOutlined, RocketOutlined, SyncOutlined, WindowsOutlined } from "@ant-design/icons";
import { Button, Form, Input, InputNumber, Modal, Select, Space, Switch, Tooltip, Typography } from "antd";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { AppInfo, AppSettings, UpdateInfo } from "../types";

interface SettingsModalProps {
  open: boolean;
  initialValue: AppSettings;
  onClose: () => void;
  onSubmit: (settings: AppSettings) => Promise<void>;
  onBackupOpen: () => void;
  onTunnelOpen: () => void;
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
  onClose,
  onSubmit,
  onBackupOpen,
  onTunnelOpen,
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
  onOpenDatabaseDir,
  onOpenPathDir,
  onOpenExternalUrl,
}: SettingsModalProps) {
  const [form] = Form.useForm<SettingsFormValues>();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const enabled = Form.useWatch("enabled", form);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      enabled: initialValue.proxy?.enabled ?? false,
      kind: initialValue.proxy?.kind ?? "socks5",
      host: initialValue.proxy?.host ?? "127.0.0.1",
      port: initialValue.proxy?.port ?? 1080,
    });
  }, [form, initialValue, open]);

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
          <Button type="primary" onClick={() => setReleaseNotesOpen(false)}>
            关闭
          </Button>
        </div>
      </Modal>
    </Modal>
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

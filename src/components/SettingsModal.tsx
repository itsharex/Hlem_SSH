import { ApartmentOutlined, AppleOutlined, CheckCircleOutlined, CloudDownloadOutlined, DatabaseOutlined, DesktopOutlined, ExclamationCircleOutlined, ExportOutlined, FolderOpenOutlined, InfoCircleOutlined, LinkOutlined, RocketOutlined, SyncOutlined, TagsOutlined, WindowsOutlined } from "@ant-design/icons";
import { Button, Form, Input, InputNumber, Modal, Select, Space, Switch, Tooltip, Typography } from "antd";
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
  onOpenDatabaseDir: () => Promise<void>;
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
  onOpenDatabaseDir,
  onOpenExternalUrl,
}: SettingsModalProps) {
  const [form] = Form.useForm<SettingsFormValues>();
  const [aboutOpen, setAboutOpen] = useState(false);
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
  const updateActionLoading = canDownloadUpdate ? updateDownloading : updateChecking;

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
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
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
              <Typography.Link
                className="aboutVersionLink"
                href={updateInfo?.htmlUrl ?? `https://github.com/${updateRepo}/releases/latest`}
                onClick={(event) => {
                  event.preventDefault();
                  void onOpenExternalUrl(updateInfo?.htmlUrl ?? `https://github.com/${updateRepo}/releases/latest`);
                }}
              >
                v{appInfo?.version ?? "0.0.0"}
              </Typography.Link>
            ) : (
              <span>v{appInfo?.version ?? "0.0.0"}</span>
            )}
          </span>
          <p className="aboutHeroTagline">安全、高效的 SSH 连接管理工具</p>
        </div>

        {/* 更新状态横幅 */}
        {updateInfo?.hasUpdate ? (
          <div className="aboutStatusBanner aboutStatusBanner--success">
            <RocketOutlined className="aboutStatusIcon" />
            <div className="aboutStatusText">
              <strong>发现新版本 {updateInfo.tagName}</strong>
              <span>{updateInfo.asset ? updateInfo.asset.name : "当前 Release 没有找到 Windows 安装包"}</span>
            </div>
          </div>
        ) : updateInfo ? (
          <div className="aboutStatusBanner aboutStatusBanner--info">
            <CheckCircleOutlined className="aboutStatusIcon" />
            <div className="aboutStatusText">
              <strong>当前已是最新版本</strong>
            </div>
          </div>
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
                ) : (
                  <Typography.Text type="secondary">未配置</Typography.Text>
                )}
              </span>
            </div>
          </div>
          {updateInfo ? (
            <div className="aboutInfoCard">
              <span className="aboutInfoCardIcon"><TagsOutlined /></span>
              <div className="aboutInfoCardContent">
                <span className="aboutInfoCardLabel">最新版本</span>
                <span className="aboutInfoCardValue">
                  {updateInfo.tagName || updateInfo.latestVersion}
                  {updateInfo.asset ? (
                    <span className="aboutInfoCardMeta"> · {formatBytes(updateInfo.asset.size)}</span>
                  ) : null}
                </span>
              </div>
            </div>
          ) : null}
          {downloadedUpdatePath ? (
            <div className="aboutInfoCard">
              <span className="aboutInfoCardIcon"><FolderOpenOutlined /></span>
              <div className="aboutInfoCardContent">
                <span className="aboutInfoCardLabel">下载位置</span>
                <span className="aboutInfoCardValue aboutInfoCardValue--path">
                  <Typography.Text copyable ellipsis={{ tooltip: downloadedUpdatePath }}>
                    {downloadedUpdatePath}
                  </Typography.Text>
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
            type={canDownloadUpdate ? "primary" : "default"}
            icon={canDownloadUpdate ? <CloudDownloadOutlined /> : <SyncOutlined spin={updateChecking} />}
            loading={updateActionLoading}
            disabled={!updateRepo || (Boolean(updateInfo?.hasUpdate) && !updateInfo?.asset)}
            onClick={() => void (canDownloadUpdate ? onDownloadUpdate() : onCheckUpdate(true))}
            size="large"
          >
            {canDownloadUpdate ? "下载更新" : "检查更新"}
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

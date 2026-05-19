import {
  CodeOutlined, DatabaseOutlined, ExportOutlined,
  FileExcelOutlined, FileImageOutlined, FileMarkdownOutlined,
  FilePdfOutlined, FilePptOutlined, FileTextOutlined, FileWordOutlined,
  FileZipOutlined, FolderOutlined, LockOutlined, PlaySquareOutlined,
  ProfileOutlined, SettingOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";
import type { RemoteFileEntry } from "../../types";
import { fileCategory, fileExtension, type FileCategory } from "../../lib/fileClassify";

export function documentIcon(name: string): ReactNode {
  const ext = fileExtension(name.toLowerCase());
  if (ext === "md" || ext === "markdown") return <FileMarkdownOutlined style={{ color: "#1890ff" }} />;
  if (ext === "pdf") return <FilePdfOutlined style={{ color: "#f5222d" }} />;
  if (["xls", "xlsx", "ods", "numbers", "csv"].includes(ext)) return <FileExcelOutlined style={{ color: "#52c41a" }} />;
  if (["ppt", "pptx", "odp", "key"].includes(ext)) return <FilePptOutlined style={{ color: "#fa541c" }} />;
  if (["doc", "docx", "odt", "pages", "rtf"].includes(ext)) return <FileWordOutlined style={{ color: "#1890ff" }} />;
  return <FileTextOutlined style={{ color: "#722ed1" }} />;
}

export function fileCategoryMeta(entry: RemoteFileEntry): { category: FileCategory; label: string; description: string; icon: ReactNode } {
  const category = fileCategory(entry);
  const map: Record<FileCategory, { label: string; description: string; icon: ReactNode }> = {
    directory: { label: "文件夹", description: "目录", icon: <FolderOutlined style={{ color: "#faad14" }} /> },
    archive: { label: "压缩包", description: "压缩包 / 归档文件", icon: <FileZipOutlined style={{ color: "#fa8c16" }} /> },
    script: { label: "脚本", description: "Shell / Python / Node / PowerShell 等脚本", icon: <CodeOutlined style={{ color: "#52c41a" }} /> },
    document: { label: "文档", description: "Markdown / PDF / Office / README 等文档", icon: documentIcon(entry.name) },
    log: { label: "日志", description: "日志文件", icon: <ProfileOutlined style={{ color: "#8c8c8c" }} /> },
    text: { label: "文本", description: "纯文本文件", icon: <FileTextOutlined style={{ color: "#595959" }} /> },
    media: { label: "媒体", description: "图片 / 音频 / 视频文件", icon: <FileImageOutlined style={{ color: "#13c2c2" }} /> },
    env: { label: "环境变量", description: "环境变量或 dotenv 配置", icon: <SettingOutlined style={{ color: "#fa8c16" }} /> },
    config: { label: "配置", description: "配置文件", icon: <SettingOutlined style={{ color: "#722ed1" }} /> },
    data: { label: "数据", description: "JSON / YAML / CSV / SQL 等数据文件", icon: <DatabaseOutlined style={{ color: "#1890ff" }} /> },
    cert: { label: "证书", description: "SSL/TLS 证书或密钥文件", icon: <LockOutlined style={{ color: "#d48806" }} /> },
    binary: { label: "可执行", description: "可执行程序或二进制文件", icon: <PlaySquareOutlined style={{ color: "#f5222d" }} /> },
    symlink: { label: "链接", description: "符号链接", icon: <ExportOutlined style={{ color: "#2f54eb" }} /> },
    other: { label: "文件", description: "普通文件", icon: <FileTextOutlined style={{ color: "#8c8c8c" }} /> },
  };
  return { category, ...map[category] };
}

import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ReactNode } from "react";
import { appTheme } from "../../app/appTheme";

type AppProvidersProps = {
  children: ReactNode;
};

export function AppProviders({ children }: AppProvidersProps) {
  return (
    <ConfigProvider locale={zhCN} theme={appTheme}>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}


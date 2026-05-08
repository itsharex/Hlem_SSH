import { expect, test } from "@playwright/test";

const MASTER_PASSWORD = "pass-123456";
const viewports = [
  { width: 1365, height: 768 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 768 },
];

async function createVault(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "设置本机主密码" })).toBeVisible();
  await page.getByRole("textbox", { name: "本机主密码", exact: true }).fill(MASTER_PASSWORD);
  await page.getByRole("textbox", { name: "确认本机主密码" }).fill(MASTER_PASSWORD);
  await page.getByRole("button", { name: "开始使用" }).click();
  await expect(page.getByText("HelM")).toBeVisible();
  await expect(page.getByText("暂无会话")).toBeVisible();
}

async function unlockVault(page: import("@playwright/test").Page) {
  await expect(page.getByRole("heading", { name: "输入本机主密码" })).toBeVisible();
  await page.getByRole("textbox", { name: "本机主密码", exact: true }).fill(MASTER_PASSWORD);
  await page.getByRole("button", { name: "解锁工作区" }).click();
  await expect(page.getByText("HelM")).toBeVisible();
}

async function createSession(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "新建会话" }).first().click();
  await expect(page.getByRole("dialog", { name: /新建 SSH 连接/ })).toBeVisible();
  await page.getByRole("textbox", { name: "主机地址" }).fill("127.0.0.1");
  await page.getByRole("button", { name: "创建" }).click();
  await expect(page.locator(".sessionTabName", { hasText: "新服务器 1" })).toBeVisible();
}

for (const viewport of viewports) {
  test(`工作区在 ${viewport.width}x${viewport.height} 下无溢出`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await createVault(page);
    await createSession(page);

    const layout = await page.evaluate(() => {
      const selectors = [".topBar", ".telemetrySidebar", ".terminalPanel", ".filePanel"];
      return {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        boxes: selectors.map((selector) => {
          const rect = document.querySelector(selector)?.getBoundingClientRect();
          return {
            selector,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
          };
        }),
      };
    });

    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight + 1);
    for (const box of layout.boxes) {
      expect(box.width, `${box.selector} width`).toBeGreaterThan(20);
      expect(box.height, `${box.selector} height`).toBeGreaterThan(20);
    }
  });
}

test("会话、命令、文件和拖拽交互可用", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 768 });
  await createVault(page);

  await createSession(page);

  await page.getByRole("button", { name: "会话列表" }).click();
  await page.getByRole("button", { name: "连接 新服务器 1", exact: true }).click();
  await expect(page.getByText("浏览器环境无法使用：SSH 连接")).toBeVisible();

  await expect(page.locator(".ant-table-tbody").getByText("SFTP 可用后显示文件")).toBeVisible();

  const handle = page.locator(".splitHandle");
  const topPane = page.locator(".splitTop");
  const before = await topPane.boundingBox();
  const handleBox = await handle.boundingBox();
  expect(before).not.toBeNull();
  expect(handleBox).not.toBeNull();

  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + 70);
  await page.mouse.up();

  const after = await topPane.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.height - before!.height)).toBeGreaterThan(20);
});

test("本机数据创建后刷新需要重新解锁", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 768 });
  await createVault(page);
  await page.reload();
  await unlockVault(page);
  await expect(page.getByText("暂无会话")).toBeVisible();
});

test("手动锁定后可重新解锁", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 768 });
  await createVault(page);
  await page.getByRole("button", { name: "锁定工作区" }).click();
  await unlockVault(page);
  await expect(page.getByText("暂无会话")).toBeVisible();
});

test("备份、隧道和全局代理入口可用", async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 768 });
  await createVault(page);
  await createSession(page);

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("button", { name: "数据备份与恢复" }).click();
  const backupDialog = page.getByRole("dialog", { name: "数据备份与恢复" });
  await expect(backupDialog).toBeVisible();
  await expect(backupDialog.getByRole("button", { name: "导出备份" })).toBeVisible();
  await expect(backupDialog.getByRole("button", { name: "恢复备份" })).toBeVisible();
  await backupDialog.getByRole("button", { name: "Close" }).click();
  await expect(backupDialog).toBeHidden();
  const settingsDialog = page.getByRole("dialog", { name: "全局设置" });
  await expect(settingsDialog).toBeVisible();

  await settingsDialog.getByRole("switch").click();
  await settingsDialog.getByRole("textbox", { name: "代理主机" }).fill("10.0.0.2");
  await settingsDialog.getByRole("spinbutton", { name: "代理端口" }).fill("1081");
  await settingsDialog.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.getByRole("dialog", { name: "全局设置" })).toBeHidden();

  await page.getByRole("button", { name: "设置" }).click();
  await expect(settingsDialog.getByRole("textbox", { name: "代理主机" })).toHaveValue("10.0.0.2");
  await expect(settingsDialog.getByRole("spinbutton", { name: "代理端口" })).toHaveValue("1081");
  await settingsDialog.getByRole("button", { name: "Close" }).click();
  await expect(settingsDialog).toBeHidden();

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("button", { name: "SSH 隧道管理" }).click();
  const tunnelDialog = page.getByRole("dialog", { name: "SSH 隧道" });
  await expect(tunnelDialog).toBeVisible();
  await expect(settingsDialog).toBeVisible();
  await tunnelDialog.getByRole("button", { name: /新建/ }).click();
  const tunnelConfigDialog = page.getByRole("dialog", { name: "新建隧道" });
  await tunnelConfigDialog.getByRole("textbox", { name: "名称" }).fill("测试隧道");
  await tunnelConfigDialog.getByRole("button", { name: /保\s*存/ }).click();
  await expect(tunnelDialog.getByText("测试隧道")).toBeVisible();
  await tunnelDialog.getByRole("button", { name: "启动" }).click();
  await expect(page.getByText("浏览器环境无法使用：本地端口转发")).toBeVisible();
});

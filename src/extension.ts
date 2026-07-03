import * as vscode from "vscode";
import { ProviderStore } from "./providerStore";
import { OpencodeManager } from "./opencodeManager";
import { SettingsPanel } from "./settingsPanel";
import { ChatViewProvider } from "./chatViewProvider";

import { log, showDiag } from "./log";
import { getHxxCodeDir } from "./storage";

export async function activate(context: vscode.ExtensionContext) {
  log("=== HxxCode 扩展激活 ===");
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    log("未找到工作区文件夹，退出激活");
    vscode.window.showWarningMessage("请先打开一个工作区文件夹再使用 HxxCode 扩展");
    return;
  }
  log("工作区路径:", workspaceRoot);

  const providerStore = new ProviderStore(context);
  await providerStore.ensureDefaultProvider();
  log("ProviderStore 初始化完成");
  log("providers:", providerStore.list());
  log("active:", providerStore.getActive());

  const opencodeManager = new OpencodeManager(context, providerStore, workspaceRoot);
  context.subscriptions.push(opencodeManager);

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeBridge.openSettings", () => {
      SettingsPanel.show(context.extensionUri, providerStore, opencodeManager);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeBridge.startServer", async () => {
      try {
        await opencodeManager.start();
        vscode.window.showInformationMessage("HxxCode server 已启动");
      } catch (err) {
        vscode.window.showErrorMessage(`启动失败：${(err as Error).message}`);
      }
    })
  );

  // 注册诊断命令
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeBridge.showDiag", () => {
      showDiag();
    })
  );

  // 注册聊天侧栏面板
  const chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    opencodeManager,
    providerStore
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // 启动后端（直连模式不需要 opencode CLI，有供应商配置即可工作）
  await opencodeManager.start().catch((err) => {
    const msg = (err as Error).message;
    log("opencodeManager.start() 跳过:", msg);
    // 没有供应商配置时静默跳过，用户去设置面板配好后会自动重连
  });

  log("数据目录:", getHxxCodeDir());
  log("=== HxxCode 扩展激活完成 ===");
}

export function deactivate() {
  // OpencodeManager 已注册进 context.subscriptions，VS Code 会自动调用其 dispose()
}

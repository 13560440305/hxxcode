import * as vscode from "vscode";
import { ProviderStore } from "./providerStore";
import { OpencodeManager } from "./opencodeManager";
import { SettingsPanel } from "./settingsPanel";
import { ChatViewProvider } from "./chatViewProvider";

import { log, showDiag } from "./log";
import { getHxxCodeDir } from "./storage";
import { checkCommandExists, detectFirstAvailableBackend } from "./agentBackend";

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
  log("agent backend:", providerStore.getActiveAgentBackend());

  // ── 自动检测可用的 CLI 后端 ──────────────────────────────────────────
  const currentBackend = providerStore.getActiveAgentBackend();
  const hasLildax = checkCommandExists("lildax");
  const hasOpencode = checkCommandExists("opencode");

  // 若配置了 opencode 别名但 lildax 可用，自动切到 lildax
  if (currentBackend.id === "opencode-ai/cli:opencode" && hasLildax) {
    log("检测到 lildax 可用，自动从 opencode 别名切换到 lildax");
    await providerStore.setActiveAgentBackend("opencode-ai/cli");
    log("agent backend (auto-switched):", providerStore.getActiveAgentBackend());
  } else if (!checkCommandExists(currentBackend.command)) {
    const detected = detectFirstAvailableBackend();
    if (detected) {
      log(`当前后端的命令「${currentBackend.command}」不可用，自动切换到「${detected}」`);
      await providerStore.setActiveAgentBackend(detected);
      log("agent backend (auto-detected):", providerStore.getActiveAgentBackend());
    } else {
      log("⚠ 未检测到任何 Agent CLI（lildax / opencode），请安装 @opencode-ai/cli");
    }
  } else {
    log(`Agent CLI「${providerStore.getActiveAgentBackend().command}」可用`);
  }

  if (!hasLildax && hasOpencode) {
    log("⚠ 仅检测到标准 opencode CLI (v1.x)，HxxCode 需要 OpenCode 2.0 (lildax)。请运行: npm install -g @opencode-ai/cli");
    void vscode.window.showWarningMessage(
      "HxxCode 需要 OpenCode 2.0 预览版 (lildax)。当前 opencode 1.x 与扩展不兼容，请运行 npm install -g @opencode-ai/cli，并执行 kill $(lsof -t -i :4096) 释放端口。"
    );
  }

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

  // 启动 OpenCode Server（需要 lildax CLI 在 PATH 上）
  await opencodeManager.start().catch((err) => {
    const msg = (err as Error).message;
    log("opencodeManager.start() 失败:", msg);
    void vscode.window.showErrorMessage(`HxxCode 启动失败：${msg}`);
  });

  log("数据目录:", getHxxCodeDir());
  log("=== HxxCode 扩展激活完成 ===");
}

export function deactivate() {
  // OpencodeManager 已注册进 context.subscriptions，VS Code 会自动调用其 dispose()
}

import * as vscode from "vscode";
import { ProviderStore } from "./providerStore";
import { OpencodeManager } from "./opencodeManager";
import { SettingsPanel } from "./settingsPanel";
import { ChatViewProvider } from "./chatViewProvider";

import { initLogging, log, logError, showDiag } from "./log";
import { getDefaultWorkspaceDir, ensureDefaultWorkspaceDir } from "./storage";
import { checkCommandExists, detectFirstAvailableBackend } from "./agentBackend";

let providerStore: ProviderStore | null = null;
let opencodeManager: OpencodeManager | null = null;
let activeWorkspaceRoot = "";
let agentStartupPromise: Promise<void> | null = null;

function getEffectiveWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? getDefaultWorkspaceDir();
}

async function startOpencodeManager(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<void> {
  if (!providerStore) {
    return;
  }

  if (opencodeManager) {
    opencodeManager.dispose();
    opencodeManager = null;
  }

  opencodeManager = new OpencodeManager(context, providerStore, workspaceRoot);
  context.subscriptions.push(opencodeManager);
  ChatViewProvider.attachOpencodeManager(opencodeManager);

  await opencodeManager.start().catch((err) => {
    const msg = (err as Error).message;
    logError("Agent 启动失败:", msg);
    void vscode.window.showErrorMessage(`HxxCode 启动失败：${msg}`);
  });
}

/** 快速初始化：仅加载配置，不阻塞 UI */
async function initializeCore(context: vscode.ExtensionContext): Promise<void> {
  if (providerStore) {
    return;
  }

  activeWorkspaceRoot = getEffectiveWorkspaceRoot();
  if (!vscode.workspace.workspaceFolders?.[0]) {
    await ensureDefaultWorkspaceDir();
  }

  providerStore = new ProviderStore(context);
  await providerStore.ensureDefaultProvider();
}

/** 后台启动 Agent CLI（耗时操作，不阻塞侧栏渲染） */
function startAgentInBackground(context: vscode.ExtensionContext): Promise<void> {
  if (agentStartupPromise) {
    return agentStartupPromise;
  }

  agentStartupPromise = (async () => {
    if (!providerStore) {
      return;
    }

    const currentBackend = providerStore.getActiveAgentBackend();
    const hasLildax = checkCommandExists("lildax");
    const hasOpencode = checkCommandExists("opencode");

    if (currentBackend.id === "opencode-ai/cli:opencode" && hasLildax) {
      await providerStore.setActiveAgentBackend("opencode-ai/cli");
    } else if (!checkCommandExists(currentBackend.command)) {
      const detected = detectFirstAvailableBackend();
      if (detected) {
        await providerStore.setActiveAgentBackend(detected);
      } else {
        log("未检测到 Agent CLI（lildax / opencode）");
      }
    }

    if (!hasLildax && hasOpencode) {
      void vscode.window.showWarningMessage(
        "HxxCode 需要 OpenCode 2.0 预览版 (lildax)。当前 opencode 1.x 与扩展不兼容，请运行 npm install -g @opencode-ai/cli。"
      );
    }

    await startOpencodeManager(context, activeWorkspaceRoot);
  })().finally(() => {
    agentStartupPromise = null;
  });

  return agentStartupPromise;
}

export async function activate(context: vscode.ExtensionContext) {
  initLogging(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeBridge.openSettings", () => {
      if (!providerStore) {
        void vscode.window.showErrorMessage("HxxCode 尚未完成初始化，请稍后重试");
        return;
      }
      SettingsPanel.show(context.extensionUri, providerStore, opencodeManager);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeBridge.startServer", async () => {
      if (!providerStore) {
        void vscode.window.showErrorMessage("HxxCode 尚未完成初始化，请稍后重试");
        return;
      }
      try {
        await startAgentInBackground(context);
        vscode.window.showInformationMessage("HxxCode server 已启动");
      } catch (err) {
        vscode.window.showErrorMessage(`启动失败：${(err as Error).message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeBridge.showDiag", () => {
      showDiag();
    })
  );

  const chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    () => opencodeManager,
    () => providerStore,
    async () => {
      await initializeCore(context);
      return !!providerStore;
    }
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      const nextRoot = getEffectiveWorkspaceRoot();
      if (!providerStore || nextRoot === activeWorkspaceRoot) {
        return;
      }
      activeWorkspaceRoot = nextRoot;
      await startOpencodeManager(context, nextRoot);
    })
  );

  // 仅等待轻量配置加载，Agent 在后台启动
  await initializeCore(context);
  const autoStart = vscode.workspace.getConfiguration("opencodeBridge").get<boolean>("autoStart", true);
  if (autoStart) {
    void startAgentInBackground(context);
  }
}

export function deactivate() {
  // OpencodeManager 已注册进 context.subscriptions，VS Code 会自动调用其 dispose()
}

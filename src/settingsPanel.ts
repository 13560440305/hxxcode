import * as vscode from "vscode";
import { ProviderStore, ProviderConfig } from "./providerStore";
import { OpencodeManager } from "./opencodeManager";
import { ChatViewProvider } from "./chatViewProvider";

/**
 * 设置面板：新增/编辑供应商、拉取模型列表、切换当前激活的供应商与模型。
 * 用一个独立的 WebviewPanel（而不是塞进聊天侧栏），避免聊天区域拥挤。
 */
export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(
    extensionUri: vscode.Uri,
    providerStore: ProviderStore,
    opencodeManager: OpencodeManager
  ) {
    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "opencodeBridge.settings",
      "模型供应商设置",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    SettingsPanel.currentPanel = new SettingsPanel(
      panel,
      extensionUri,
      providerStore,
      opencodeManager
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly providerStore: ProviderStore,
    private readonly opencodeManager: OpencodeManager
  ) {
    this.panel = panel;
    this.panel.webview.html = this.renderHtml();
    this.postState();

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleMessage(message: {
    type: string;
    payload?: unknown;
  }): Promise<void> {
    switch (message.type) {
      case "requestState":
        this.postState();
        break;

      case "fetchModels": {
        const { baseURL, apiKey } = message.payload as { baseURL: string; apiKey: string };
        try {
          const models = await this.providerStore.fetchModels(baseURL, apiKey);
          this.panel.webview.postMessage({ type: "modelsFetched", payload: { models } });
        } catch (err) {
          this.panel.webview.postMessage({
            type: "error",
            payload: { message: (err as Error).message },
          });
        }
        break;
      }

      case "saveProvider": {
        const { config, apiKey } = message.payload as {
          config: ProviderConfig;
          apiKey: string;
        };
        await this.providerStore.upsertProvider(config, apiKey);
        await this.opencodeManager.restart();
        vscode.window.showInformationMessage(`供应商「${config.name}」已保存`);
        this.postState();
        ChatViewProvider.notifyProviderChanged();
        break;
      }

      case "removeProvider": {
        const { id } = message.payload as { id: string };
        await this.providerStore.removeProvider(id);
        await this.opencodeManager.restart();
        this.postState();
        ChatViewProvider.notifyProviderChanged();
        break;
      }

      case "setActive": {
        const { providerId, model } = message.payload as {
          providerId: string;
          model: string;
        };
        await this.opencodeManager.switchModel(providerId, model);
        this.postState();
        ChatViewProvider.notifyProviderChanged();
        break;
      }

      case "setAgentBackend": {
        const { backendId } = message.payload as { backendId: string };
        await this.providerStore.setActiveAgentBackend(backendId);
        await this.opencodeManager.restart();
        vscode.window.showInformationMessage(
          `已切换 Agent 后端为「${this.providerStore.getActiveAgentBackend().name}」`
        );
        this.postState();
        break;
      }
    }
  }

  private postState(): void {
    const { provider, model } = this.providerStore.getActive();
    const activeAgent = this.providerStore.getActiveAgentBackend();
    this.panel.webview.postMessage({
      type: "state",
      payload: {
        providers: this.providerStore.list(),
        activeProviderId: provider?.id ?? null,
        activeModel: model,
        agentBackends: this.providerStore.listAgentBackends(),
        activeAgentBackendId: activeAgent.id,
      },
    });
  }

  private renderHtml(): string {
    // 生产代码建议用独立的 webview-ui 构建产物 + CSP nonce，这里给出最简结构示意。
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
  .provider-card { border: 1px solid var(--vscode-widget-border); border-radius: 6px; padding: 12px; margin-bottom: 12px; }
  .provider-card.active { border-color: var(--vscode-focusBorder); }
  label { display: block; font-size: 12px; margin: 8px 0 4px; opacity: 0.8; }
  input, select { width: 100%; box-sizing: border-box; padding: 4px 6px; }
  button { margin-top: 8px; margin-right: 8px; }
  .section { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--vscode-widget-border); }
  .hint { font-size: 11px; opacity: 0.75; margin-top: 6px; line-height: 1.5; }
  code { font-size: 11px; }
</style>
</head>
<body>
  <div class="section">
    <h2>Agent 后端（CLI 插件）</h2>
    <label>当前使用的 Agent CLI</label>
    <select id="agentBackendSelect"></select>
    <p class="hint">
      默认使用官方 <code>@opencode-ai/cli</code>（命令 <code>lildax</code>）。
      可在 <code>~/.hxxcode/config.json</code> 的 <code>agentBackend</code> 中注册定制 CLI 并切换。
    </p>
  </div>

  <h2>模型供应商</h2>
  <div id="providerList"></div>

  <h3>添加 / 编辑供应商</h3>
  <label>名称</label><input id="name" placeholder="例如：我的 NewAPI" />
  <label>类型</label>
  <select id="kind">
    <option value="openai-compatible">OpenAI 兼容</option>
    <option value="anthropic-compatible">Anthropic 兼容</option>
    <option value="custom">自定义 npm 包</option>
  </select>
  <label>Base URL</label><input id="baseURL" placeholder="https://your-newapi-domain.com/v1" />
  <label>API Key</label><input id="apiKey" type="password" />
  <label>模型列表（逗号分隔，或点击下方按钮自动拉取）</label>
  <input id="models" placeholder="gpt-4o, claude-sonnet-4-6, deepseek-v3" />
  <div>
    <button id="fetchModelsBtn">获取模型列表</button>
    <button id="saveBtn">保存供应商</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    let currentId = "newapi-default";

    vscode.postMessage({ type: "requestState" });

    window.addEventListener("message", (event) => {
      const { type, payload } = event.data;
      if (type === "state") renderState(payload);
      if (type === "modelsFetched") $("models").value = payload.models.join(", ");
      if (type === "error") alert(payload.message);
    });

    function renderState(state) {
      renderAgentBackends(state);
      renderProviders(state);
    }

    function renderAgentBackends(state) {
      const sel = $("agentBackendSelect");
      if (!sel) return;
      sel.innerHTML = "";
      for (const b of state.agentBackends || []) {
        const opt = document.createElement("option");
        opt.value = b.id;
        opt.textContent = b.name + " → " + b.command + (b.builtin ? "" : " (自定义)");
        sel.appendChild(opt);
      }
      if (state.activeAgentBackendId) sel.value = state.activeAgentBackendId;
      sel.onchange = () => {
        vscode.postMessage({
          type: "setAgentBackend",
          payload: { backendId: sel.value },
        });
      };
    }

    function renderProviders(state) {
      const list = $("providerList");
      list.innerHTML = "";
      for (const p of state.providers) {
        const card = document.createElement("div");
        card.className = "provider-card" + (p.id === state.activeProviderId ? " active" : "");
        card.innerHTML =
          "<strong>" + p.name + "</strong> (" + p.kind + ")<br/>" +
          "<small>" + p.baseURL + "</small><br/>" +
          "<button data-act='use' data-id='" + p.id + "'>设为当前</button>" +
          "<button data-act='edit' data-id='" + p.id + "'>编辑</button>" +
          "<button data-act='del' data-id='" + p.id + "'>删除</button>";
        list.appendChild(card);
      }
      list.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-id");
          const act = btn.getAttribute("data-act");
          const provider = state.providers.find((p) => p.id === id);
          if (act === "use") {
            vscode.postMessage({
              type: "setActive",
              payload: { providerId: id, model: provider.models[0] },
            });
          } else if (act === "edit") {
            currentId = id;
            $("name").value = provider.name;
            $("kind").value = provider.kind;
            $("baseURL").value = provider.baseURL;
            $("models").value = provider.models.join(", ");
          } else if (act === "del") {
            vscode.postMessage({ type: "removeProvider", payload: { id } });
          }
        });
      });
    }

    $("fetchModelsBtn").addEventListener("click", () => {
      vscode.postMessage({
        type: "fetchModels",
        payload: { baseURL: $("baseURL").value, apiKey: $("apiKey").value },
      });
    });

    $("saveBtn").addEventListener("click", () => {
      const config = {
        id: currentId,
        name: $("name").value,
        kind: $("kind").value,
        baseURL: $("baseURL").value,
        models: $("models").value.split(",").map((s) => s.trim()).filter(Boolean),
      };
      vscode.postMessage({ type: "saveProvider", payload: { config, apiKey: $("apiKey").value } });
    });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    SettingsPanel.currentPanel = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}

import * as vscode from "vscode";
import { ProviderStore, ProviderConfig } from "./providerStore";
import { OpencodeManager } from "./opencodeManager";
import { ChatViewProvider } from "./chatViewProvider";

/**
 * 设置面板：新增/编辑供应商、拉取模型列表、切换当前激活的供应商与模型。
 * 用独立的 WebviewPanel（双栏布局），左侧供应商列表，右侧编辑表单。
 */
export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(
    extensionUri: vscode.Uri,
    providerStore: ProviderStore,
    opencodeManager: OpencodeManager | null
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
    private readonly opencodeManager: OpencodeManager | null
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
        if (this.opencodeManager) {
          await this.opencodeManager.restart();
        }
        vscode.window.showInformationMessage(`供应商「${config.name}」已保存`);
        this.postState();
        ChatViewProvider.notifyProviderChanged();
        break;
      }

      case "removeProvider": {
        const { id } = message.payload as { id: string };
        await this.providerStore.removeProvider(id);
        if (this.opencodeManager) {
          await this.opencodeManager.restart();
        }
        this.postState();
        ChatViewProvider.notifyProviderChanged();
        break;
      }

      case "setActive": {
        const { providerId, model } = message.payload as {
          providerId: string;
          model: string;
        };
        if (this.opencodeManager) {
          await this.opencodeManager.switchModel(providerId, model);
        } else {
          await this.providerStore.setActive(providerId, model);
        }
        this.postState();
        ChatViewProvider.notifyProviderChanged();
        break;
      }
    }
  }

  private postState(): void {
    const { provider, model } = this.providerStore.getActive();
    this.panel.webview.postMessage({
      type: "state",
      payload: {
        providers: this.providerStore.list(),
        activeProviderId: provider?.id ?? null,
        activeModel: model,
      },
    });
  }

  private renderHtml(): string {
    const nonce = crypto.randomUUID();
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --bg-elevated: color-mix(in srgb, var(--vscode-input-background, #252526) 100%, transparent);
    --bg-input: var(--vscode-input-background, #2a2a2c);
    --border: var(--vscode-widget-border, #3c3c3c);
    --border-subtle: color-mix(in srgb, var(--border) 60%, transparent);
    --text: var(--vscode-foreground, #cccccc);
    --text-muted: var(--vscode-descriptionForeground, #9d9d9d);
    --text-faint: color-mix(in srgb, var(--text-muted) 60%, transparent);
    --accent: var(--vscode-button-background, #0e639c);
    --accent-soft: color-mix(in srgb, var(--accent) 18%, var(--bg));
    --surface-hover: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06));
    --ok: #5fb85f;
    --err: #d97c7c;
    --radius: 6px;
    --radius-sm: 4px;
    --font: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif);
    --mono-font: var(--vscode-editor-font-family, "Cascadia Code", Consolas, monospace);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    height: 100%; width: 100%;
    font-family: var(--font);
    font-size: 13px;
    background: var(--bg);
    color: var(--text);
    display: flex;
    overflow: hidden;
  }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  button { font-family: inherit; cursor: pointer; }
  input, select { font-family: inherit; }

  /* ── Left sidebar ── */
  .side {
    width: 270px;
    min-width: 270px;
    border-right: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .side-section {
    padding: 14px 14px 12px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .side-section .label {
    font-size: 10.5px;
    color: var(--text-muted);
    margin-bottom: 6px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .side-section .desc {
    font-size: 10.5px;
    color: var(--text-faint);
    margin-top: 6px;
    line-height: 1.6;
  }
  .field-select {
    width: 100%;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    color: var(--text);
    font-size: 12px;
    padding: 6px 8px;
    border-radius: 7px;
    appearance: none;
    cursor: pointer;
    outline: none;
  }
  .field-select:hover { border-color: var(--border); }
  .field-select:focus { border-color: var(--accent); }

  /* ── Provider list ── */
  .provider-list-wrap { flex: 1; padding: 10px 10px; }
  .plw-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 8px;
  }
  .plw-head .t {
    font-size: 10.5px;
    color: var(--text-muted);
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .add-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--accent-soft);
    color: var(--accent);
    border: none;
    border-radius: 6px;
    padding: 4px 9px;
    font-size: 11px;
    cursor: pointer;
  }
  .add-btn:hover { filter: brightness(1.1); }

  .provider-row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 8px;
    border-radius: 7px;
    cursor: pointer;
    margin-bottom: 2px;
  }
  .provider-row:hover { background: var(--surface-hover); }
  .provider-row.selected { background: var(--accent-soft); }
  .p-dot {
    width: 26px; height: 26px;
    border-radius: 7px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    color: #fff;
  }
  .p-info { flex: 1; min-width: 0; }
  .p-name {
    font-size: 12px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .p-url {
    font-size: 10px;
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .current-badge {
    font-size: 8.5px;
    background: color-mix(in srgb, var(--ok) 18%, transparent);
    color: var(--ok);
    padding: 1px 5px;
    border-radius: 10px;
    font-weight: 600;
  }

  /* ── Right main ── */
  .main {
    flex: 1;
    overflow-y: auto;
    padding: 20px 28px 40px;
  }
  .main-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
  }
  .main-header h2 {
    font-size: 15px;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .main-header h2 .p-dot {
    width: 20px; height: 20px;
    border-radius: 5px;
    display: inline-block;
  }
  .main-header .actions { display: flex; gap: 8px; }

  .btn {
    border: none;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { filter: brightness(1.08); }
  .btn-ghost {
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
  }
  .btn-ghost:hover { border-color: var(--border); color: var(--text); }
  .btn-danger { background: transparent; color: var(--err); }
  .btn-danger:hover { background: color-mix(in srgb, var(--err) 10%, transparent); }

  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px 18px;
    margin-bottom: 16px;
  }
  .form-grid.full { grid-template-columns: 1fr; }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .field label {
    font-size: 11px;
    color: var(--text-muted);
    font-weight: 600;
  }
  .field input, .field select {
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    color: var(--text);
    font-size: 12px;
    padding: 7px 9px;
    border-radius: 7px;
    outline: none;
  }
  .field input:focus, .field select:focus { border-color: var(--accent); }
  .field input::placeholder { color: var(--text-faint); }
  .key-wrap { position: relative; }
  .key-wrap input { width: 100%; padding-right: 32px; font-family: var(--mono-font); }
  .key-toggle {
    position: absolute; right: 5px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: var(--text-faint); cursor: pointer; padding: 3px;
  }
  .key-toggle:hover { color: var(--text); }

  .section-title {
    font-size: 12px; font-weight: 700;
    margin: 18px 0 2px;
    padding-top: 14px;
    border-top: 1px solid var(--border-subtle);
    display: flex; align-items: center; justify-content: space-between;
  }
  .section-title .hint {
    font-weight: 400; font-size: 10.5px; color: var(--text-faint);
  }

  .model-chips-editor {
    display: flex; flex-wrap: wrap; gap: 5px;
    padding: 8px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 7px;
    min-height: 36px;
  }
  .model-tag {
    display: flex; align-items: center; gap: 4px;
    background: var(--bg-input);
    border: 1px solid var(--border-subtle);
    padding: 3px 5px 3px 9px;
    border-radius: 20px;
    font-size: 11px;
  }
  .model-tag .x {
    width: 14px; height: 14px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-faint); cursor: pointer; font-size: 10px;
  }
  .model-tag .x:hover { background: rgba(255,255,255,0.1); color: var(--text); }
  .model-tag-add {
    border: 1px dashed var(--border);
    background: transparent;
    color: var(--text-faint);
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 11px;
    cursor: pointer;
  }
  .model-tag-add:hover { color: var(--accent); border-color: var(--accent); }

  .model-add-inline {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1 1 180px;
    min-width: 160px;
  }
  .model-add-inline input {
    flex: 1;
    min-width: 0;
    background: var(--bg-input);
    border: 1px solid var(--border-subtle);
    color: var(--text);
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 6px;
    outline: none;
  }
  .model-add-inline input:focus { border-color: var(--accent); }
  .model-add-inline button {
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--text-muted);
    font-size: 10.5px;
    padding: 3px 8px;
    border-radius: 6px;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .model-add-inline button:hover { border-color: var(--border); color: var(--text); }
  .model-add-inline button.confirm {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: transparent;
  }

  .fetch-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  .fetch-row .hint-text { font-size: 10.5px; color: var(--text-faint); }

  .bottom-actions {
    display: flex;
    justify-content: space-between;
    margin-top: 24px;
    padding-top: 14px;
    border-top: 1px solid var(--border-subtle);
  }
  .bottom-actions .right { display: flex; gap: 8px; }

  .empty-state {
    text-align: center;
    padding: 40px 20px;
    color: var(--text-faint);
    font-size: 13px;
  }
  .empty-state .hint { margin-top: 8px; font-size: 11px; }
</style>
</head>
<body>

  <!-- Left sidebar -->
  <div class="side">
    <div class="side-section">
      <div class="label">Agent 后端</div>
      <select class="field-select" id="agentBackendSelect">
        <option>OpenCode CLI（官方 @opencode-ai/cli）→ lildax</option>
      </select>
      <div class="desc">默认使用官方 @opencode-ai/cli（命令别名 lildax）。可在 ~/.hxxcode/config.json 中注册自定义 CLI。</div>
    </div>

    <div class="provider-list-wrap">
      <div class="plw-head">
        <span class="t">模型供应商</span>
        <button type="button" class="add-btn" id="addBtn">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          添加
        </button>
      </div>
      <div id="providerList"></div>
    </div>
  </div>

  <!-- Right main -->
  <div class="main">
    <div id="editorArea">

      <div class="empty-state" id="emptyState">
        <div>选择一个供应商开始编辑</div>
        <div class="hint">或点击左侧「添加」按钮新建供应商</div>
      </div>

      <div id="editorForm" style="display:none">
        <div class="main-header">
          <h2><span class="p-dot" id="editDot"></span><span id="editTitle">供应商名称</span></h2>
          <div class="actions">
            <button class="btn btn-ghost" id="setActiveBtn">设为当前</button>
            <button class="btn btn-primary" id="saveBtn">保存</button>
          </div>
        </div>

        <div class="form-grid">
          <div class="field">
            <label>供应商名称</label>
            <input type="text" id="editName" placeholder="例如：我的 NewAPI" />
          </div>
          <div class="field">
            <label>类型</label>
            <select id="editKind">
              <option value="openai-compatible">OpenAI 兼容</option>
              <option value="anthropic-compatible">Anthropic 兼容</option>
              <option value="custom">自定义 npm 包</option>
            </select>
          </div>
        </div>
        <div class="form-grid full">
          <div class="field">
            <label>Base URL</label>
            <input type="text" id="editBaseURL" placeholder="https://api.example.com/v1" />
          </div>
        </div>
        <div class="form-grid full">
          <div class="field">
            <label>API Key</label>
            <div class="key-wrap">
              <input type="password" id="editApiKey" placeholder="sk-..." />
              <button type="button" class="key-toggle" id="keyToggle">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/></svg>
              </button>
            </div>
          </div>
        </div>

        <div class="section-title">
          模型列表
          <span class="hint">点击 × 删除；点 + 添加或自动拉取</span>
        </div>
        <div class="model-chips-editor" id="modelsEditor"></div>
        <div class="fetch-row">
          <button class="btn btn-ghost" id="fetchModelsBtn">↻ 自动拉取模型列表</button>
          <span class="hint-text">通过 /v1/models 接口获取该供应商支持的全部模型</span>
        </div>

        <div class="bottom-actions">
          <button class="btn btn-danger" id="deleteBtn">删除该供应商</button>
          <div class="right">
            <button class="btn btn-ghost" id="setActiveBtn2">设为当前</button>
            <button class="btn btn-primary" id="saveBtn2">保存修改</button>
          </div>
        </div>
      </div>

    </div>
  </div>

<script nonce="${nonce}">
(function() {
  try {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  let state = { providers: [], activeProviderId: null, activeModel: null };
  let currentEditId = null;
  let pendingModels = [];

  // ── Dynamic color for provider dot ──
  const DOT_COLORS = [
    "linear-gradient(135deg,#4f8ef7,#6a5cf0)",
    "linear-gradient(135deg,#5fb85f,#3a8f5f)",
    "linear-gradient(135deg,#d9a441,#c96442)",
    "linear-gradient(135deg,#d97c7c,#a862ea)",
    "linear-gradient(135deg,#4fc4d9,#2b8a9e)",
    "linear-gradient(135deg,#f7a54f,#e07b3a)",
  ];
  function dotColor(index) { return DOT_COLORS[index % DOT_COLORS.length]; }
  function dotLetter(name) { return (name || "?").charAt(0).toUpperCase(); }

  // ── Render ──

  function renderState(payload) {
    state = payload;
    renderProviders();
    // 如果正在新建中（ID 以 new- 开头），保持编辑表单不重置
    if (currentEditId && currentEditId.startsWith("new-")) {
      showEditForm();
      return;
    }
    // 如果当前编辑的供应商还在列表中，刷新编辑区；否则清空
    if (currentEditId && state.providers.some(p => p.id === currentEditId)) {
      const p = state.providers.find(p => p.id === currentEditId);
      if (p) fillEditForm(p);
    } else {
      currentEditId = null;
      showEmptyState();
    }
  }

  function formatProviderUrl(baseURL) {
    if (!baseURL) return "";
    let s = baseURL;
    if (s.indexOf("https://") === 0) s = s.slice(8);
    else if (s.indexOf("http://") === 0) s = s.slice(7);
    while (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  }

  function renderProviders() {
    const list = $("providerList");
    if (!list) return;
    list.innerHTML = "";
    for (let i = 0; i < state.providers.length; i++) {
      const p = state.providers[i];
      const isActive = p.id === state.activeProviderId;
      const isSelected = p.id === currentEditId;
      const row = document.createElement("div");
      row.className = "provider-row" + (isSelected ? " selected" : "");
      row.innerHTML =
        '<div class="p-dot" style="background:' + dotColor(i) + '">' + dotLetter(p.name) + '</div>' +
        '<div class="p-info">' +
          '<div class="p-name">' + escapeHtml(p.name) + (isActive ? ' <span class="current-badge">当前</span>' : '') + '</div>' +
          '<div class="p-url">' + escapeHtml(formatProviderUrl(p.baseURL)) + '</div>' +
        '</div>';
      row.addEventListener("click", () => selectProvider(p.id));
      list.appendChild(row);
    }
  }

  function selectProvider(id) {
    currentEditId = id;
    const p = state.providers.find(pr => pr.id === id);
    if (p) fillEditForm(p);
    renderProviders(); // 高亮选中行
  }

  function fillEditForm(p) {
    showEditForm();
    currentEditId = p.id;
    modelInputOpen = false;
    $("editTitle").textContent = p.name;
    $("editDot").style.background = dotColor(state.providers.indexOf(p));
    $("editName").value = p.name;
    $("editKind").value = p.kind;
    $("editBaseURL").value = p.baseURL || "";
    $("editApiKey").value = "";
    // 获取已有 key 以便编辑（通过 postMessage 请求）
    pendingModels = [...(p.models || [])];
    renderModelChips();
  }

  function showEmptyState() {
    $("emptyState").style.display = "block";
    $("editorForm").style.display = "none";
  }

  function showEditForm() {
    $("emptyState").style.display = "none";
    $("editorForm").style.display = "block";
  }

  // ── Model chips ──

  let modelInputOpen = false;

  function commitModelInput() {
    const input = $("modelNameInput");
    if (!input) return;
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    if (!pendingModels.includes(name)) {
      pendingModels.push(name);
    }
    modelInputOpen = false;
    renderModelChips();
  }

  function cancelModelInput() {
    modelInputOpen = false;
    renderModelChips();
  }

  function openModelInput() {
    modelInputOpen = true;
    renderModelChips();
    const input = $("modelNameInput");
    input?.focus();
  }

  function appendModelAddInline(editor) {
    const row = document.createElement("div");
    row.className = "model-add-inline";
    row.id = "modelAddRow";

    const input = document.createElement("input");
    input.type = "text";
    input.id = "modelNameInput";
    input.placeholder = "输入模型名称，Enter 确认";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitModelInput();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelModelInput();
      }
    });

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "confirm";
    confirmBtn.textContent = "添加";
    confirmBtn.addEventListener("click", commitModelInput);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", cancelModelInput);

    row.appendChild(input);
    row.appendChild(confirmBtn);
    row.appendChild(cancelBtn);
    editor.appendChild(row);
  }

  function renderModelChips() {
    const editor = $("modelsEditor");
    if (!editor) return;
    editor.innerHTML = "";
    for (const m of pendingModels) {
      const tag = document.createElement("div");
      tag.className = "model-tag";
      tag.innerHTML = escapeHtml(m) + ' <span class="x" data-model="' + escapeAttr(m) + '">×</span>';
      tag.querySelector(".x").addEventListener("click", () => {
        pendingModels = pendingModels.filter(mo => mo !== m);
        renderModelChips();
      });
      editor.appendChild(tag);
    }

    if (modelInputOpen) {
      appendModelAddInline(editor);
      return;
    }

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "model-tag-add";
    addBtn.id = "addModelBtn";
    addBtn.textContent = "+ 添加模型";
    addBtn.addEventListener("click", openModelInput);
    editor.appendChild(addBtn);
  }

  // ── Utilities ──

  function escapeHtml(str) {
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function escapeAttr(str) {
    return String(str).replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  // ── Collect form data ──

  function slugifyId(name) {
    let s = "";
    for (const c of name.toLowerCase()) {
      const code = c.charCodeAt(0);
      if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
        s += c;
      } else {
        s += "-";
      }
    }
    while (s.indexOf("--") >= 0) s = s.split("--").join("-");
    while (s.length > 0 && s.charAt(0) === "-") s = s.slice(1);
    while (s.length > 0 && s.charAt(s.length - 1) === "-") s = s.slice(0, -1);
    return s;
  }

  function getFormConfig() {
    let id = currentEditId;
    const name = $("editName").value.trim();
    if (!name) { alert("请输入供应商名称"); return null; }
    // 如果是新建（id 以 new- 开头），生成新的 id
    if (!id || id.startsWith("new-")) {
      const slug = slugifyId(name) || "provider";
      id = slug + "-" + Date.now().toString(36);
    }
    return {
      config: {
        id: id,
        name: name,
        kind: $("editKind").value,
        baseURL: $("editBaseURL").value.trim(),
        models: pendingModels,
      },
      apiKey: $("editApiKey").value,
    };
  }

  // ── Event listeners ──

  function startNewProvider() {
    currentEditId = "new-" + Date.now().toString(36);
    pendingModels = [];
    modelInputOpen = false;
    showEditForm();
    $("editTitle").textContent = "新建供应商";
    $("editDot").style.background = dotColor(state.providers.length);
    $("editName").value = "";
    $("editKind").value = "openai-compatible";
    $("editBaseURL").value = "";
    $("editApiKey").value = "";
    renderModelChips();
    renderProviders();
    $("editName")?.focus();
  }

  $("addBtn")?.addEventListener("click", startNewProvider);

  function save() {
    const data = getFormConfig();
    if (!data) return;
    vscode.postMessage({ type: "saveProvider", payload: data });
  }

  $("saveBtn").addEventListener("click", save);
  $("saveBtn2").addEventListener("click", save);

  function setActive() {
    if (!currentEditId || currentEditId.startsWith("new-")) return;
    const models = pendingModels.length > 0 ? pendingModels : (state.providers.find(p => p.id === currentEditId)?.models || []);
    vscode.postMessage({
      type: "setActive",
      payload: { providerId: currentEditId, model: models[0] || "" },
    });
  }

  $("setActiveBtn").addEventListener("click", setActive);
  $("setActiveBtn2").addEventListener("click", setActive);

  $("deleteBtn").addEventListener("click", () => {
    if (!currentEditId || currentEditId.startsWith("new-")) return;
    if (confirm("确定删除该供应商？")) {
      vscode.postMessage({ type: "removeProvider", payload: { id: currentEditId } });
      currentEditId = null;
    }
  });

  $("keyToggle")?.addEventListener("click", () => {
    const input = $("editApiKey");
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
  });

  $("fetchModelsBtn").addEventListener("click", () => {
    const baseURL = $("editBaseURL").value.trim();
    const apiKey = $("editApiKey").value.trim();
    if (!baseURL) { alert("请先填写 Base URL"); return; }
    if (!apiKey) { alert("请先填写 API Key"); return; }
    $("fetchModelsBtn").textContent = "拉取中…";
    $("fetchModelsBtn").disabled = true;
    vscode.postMessage({ type: "fetchModels", payload: { baseURL, apiKey } });
  });

  // ── Message from extension ──

  window.addEventListener("message", (event) => {
    const { type, payload } = event.data;
    if (type === "state") {
      renderState(payload);
    }
    if (type === "modelsFetched") {
      pendingModels = payload.models;
      modelInputOpen = false;
      renderModelChips();
      $("fetchModelsBtn").textContent = "↻ 自动拉取模型列表";
      $("fetchModelsBtn").disabled = false;
    }
    if (type === "error") {
      alert(payload.message);
      $("fetchModelsBtn").textContent = "↻ 自动拉取模型列表";
      $("fetchModelsBtn").disabled = false;
    }
  });

  // ── Init ──

  vscode.postMessage({ type: "requestState" });
  } catch (err) {
    document.body.innerHTML =
      '<div style="padding:20px;color:var(--vscode-errorForeground,#f48771)">' +
      '<h3>设置面板加载出错</h3><pre style="white-space:pre-wrap;font-size:12px">' +
      (err instanceof Error ? err.stack || err.message : String(err)) +
      '</pre></div>';
  }
})();
</script>
</body>
</html>`;
  }

  dispose(): void {
    SettingsPanel.currentPanel = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}

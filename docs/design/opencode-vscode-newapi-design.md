# OpenCode + VS Code Extension + NewAPI 三层架构设计

> 目标：在 VS Code 中获得与 Claude Code 插件一致的体验（侧边栏聊天、流式输出、工具调用可视化），
> 底层用 OpenCode CLI 作为 Agent 执行引擎，模型请求默认经过自建 NewAPI 网关，同时支持在扩展设置中
> 自由添加/切换其它模型供应商。

---

## 1. 整体架构

```
┌─────────────────────────────┐
│      VS Code 扩展 (UI 层)     │
│  聊天侧栏 + 供应商设置面板      │
└───────────────┬───────────────┘
                │ @opencode-ai/sdk (HTTP, 流式)
                ▼
┌─────────────────────────────┐        ┌──────────────────┐
│   OpenCode Server (Agent 层)  │◄──────►│  Provider 配置     │
│ 本地进程：opencode serve       │  写入   │ 扩展写入，用户可切换 │
│ 负责文件读写 / 终端 / 工具调用   │        └──────────────────┘
└───────────────┬───────────────┘
                │ OpenAI 兼容协议
                ▼
┌─────────────────────────────┐
│       NewAPI 网关 (聚合层)      │
│   默认渠道，聚合 30+ 上游服务商   │
└───────────────┬───────────────┘
                ▼
┌─────────────────────────────┐
│         上游模型服务商           │
│  OpenAI · Claude · DeepSeek …  │
└─────────────────────────────┘
```

三层各自的职责边界很清楚：

| 层 | 职责 | 不负责 |
|---|---|---|
| VS Code 扩展 | 渲染聊天 UI、管理供应商/模型配置、管理会话列表 | 不直接调用模型 API，不做文件编辑 |
| OpenCode Server | 执行 Agent 逻辑（读文件、改代码、跑命令）、把结果流式返回 | 不关心模型请求最终打到哪个服务商 |
| NewAPI 网关 | 聚合多渠道、格式转换（OpenAI/Claude/Gemini 互转）、计费与路由 | 不感知 IDE / Agent 的存在，纯网关 |

---

## 2. 通信方式选型：Server + SDK，而不是 ACP

OpenCode 提供两种编辑器集成方式：

- **ACP 模式**（`opencode acp`，stdio JSON-RPC）：标准化协议，接入快，但模型/供应商切换走协议预定义的
  selector，难以承载"自由添加自定义供应商"这种非标准 UI 需求。
- **Server + SDK 模式**（`opencode serve` + `@opencode-ai/sdk`）：扩展自行拉起本地 HTTP server，用
  TypeScript SDK 建 session、发送 prompt、订阅流式事件，同时可以直接读写 `opencode.json` 里的
  provider 注册表。

**结论：主链路走 Server + SDK 模式**，因为"设置里自由配置供应商"本质上是要控制 OpenCode 的 provider
配置，这条路径下最直接。ACP 可以作为未来扩展到 Zed / Neovim 等其它编辑器时的兜底方案，不影响当前设计。

---

## 3. 扩展工程结构

```
extension/
├── src/
│   ├── extension.ts          # 激活入口，管理 OpenCode 进程生命周期
│   ├── opencodeManager.ts    # spawn opencode serve，持有 SDK client，写 opencode.json
│   ├── providerStore.ts      # 供应商配置的读写（globalState + SecretStorage）
│   ├── chatViewProvider.ts   # WebviewViewProvider，侧边栏聊天面板
│   └── settingsPanel.ts      # 供应商 / 模型管理面板（Webview）
├── webview-ui/                # 前端（聊天气泡 + 供应商设置表单）
└── package.json               # contributes：视图容器图标、命令、配置项
```

激活流程：`activate()` 时启动 `opencode serve --hostname 127.0.0.1 --port <随机端口>`，用
`createOpencodeClient` 连接；侧边栏 Webview 把用户输入转发给扩展主进程，主进程调用 SDK 的
`session.create` / `session.prompt`，再把流式事件（文本增量、工具调用、diff）转发回 Webview 渲染成
聊天气泡——这就是截图里 Claude Code 那种体验。

---

## 4. 供应商配置模型

### 4.1 扩展内部存储结构

存放位置：非敏感字段放 `globalState`，API Key 单独放 `SecretStorage`，绝不落明文磁盘。

```json
{
  "providers": [
    {
      "id": "newapi-default",
      "name": "我的 NewAPI",
      "kind": "openai-compatible",
      "baseURL": "https://your-newapi-domain.com/v1",
      "apiKeyRef": "secret:newapi-default",
      "models": ["gpt-4o", "claude-sonnet-4-6", "deepseek-v3"],
      "isDefault": true
    },
    {
      "id": "custom-1",
      "name": "自定义 OpenAI 兼容渠道",
      "kind": "openai-compatible",
      "baseURL": "https://xxx/v1",
      "apiKeyRef": "secret:custom-1",
      "models": []
    }
  ],
  "activeProviderId": "newapi-default",
  "activeModel": "claude-sonnet-4-6"
}
```

### 4.2 翻译为 OpenCode 的 `opencode.json`

```json
{
  "provider": {
    "newapi-default": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://your-newapi-domain.com/v1",
        "apiKey": "{env:NEWAPI_KEY}"
      },
      "models": {
        "gpt-4o": {},
        "claude-sonnet-4-6": {},
        "deepseek-v3": {}
      }
    }
  }
}
```

apiKey 用环境变量占位，扩展在 spawn `opencode serve` 子进程时把真实 key 通过 `env` 注入，避免写入磁盘
配置文件。供应商变更后需要重启一次 server 子进程（数百毫秒，用户基本无感）；模型切换（同一供应商下）
则不需要重启，直接改当前 session 的 `model` 字段（`provider/model` 格式）。

---

## 5. 设置面板功能点

- **默认供应商**：预置"我的 NewAPI"卡片，只需填 Base URL + Key，点击"拉取模型列表"调用
  `GET /v1/models`（NewAPI 原生兼容）自动填充可选模型。
- **添加供应商**：表单字段——名称 / 类型（OpenAI 兼容 · Anthropic 兼容 · 自定义 npm 包）/ Base URL /
  API Key / 模型列表，保存后出现在供应商下拉里。
- **顶部模型选择器**：仿照 Claude Code 顶栏，做"供应商 → 模型"两级下拉，切换时只改当前 session 的
  model 字段，无需重启整个 server。
- **连通性测试**：保存供应商时发一个最小 token 的测试请求，失败给出明确报错（鉴权失败 / 网络不通 /
  模型不存在）。

---

## 6. 会话与工具能力

OpenCode 自带 read / write / bash / grep 等工具，直接运行在本机文件系统上，文件编辑、终端命令这类
"Agent 干活"的部分不需要扩展重新实现。扩展只需把 SDK 返回的工具调用事件（`tool_use` / `tool_result`）
渲染成可展开的执行记录，即截图中 Claude Code 侧边栏那种交互。

---

## 7. 需要提前考虑的问题

- **许可证**：NewAPI 是 AGPLv3，如果扩展内置一键部署脚本或修改其代码分发，需注意开源义务；单纯把它
  当自建后端调用没有问题。
- **容灾策略**：建议扩展层只做"供应商级"回退（NewAPI 整体不可用时切到下一个已配置供应商），模型级的
  容灾（某个渠道抽风自动换下一个 Key）交给 NewAPI 自身的加权轮询能力，避免两层重复兜底导致行为难以
  预测。
- **国内网络环境**：NewAPI 作为网关统一处理"部分模型商在国内直连受限"的问题，扩展侧不需要感知具体的
  网络限制，只认一个 Base URL。

---

## 8. 后续可扩展方向

- 支持 ACP 模式作为备用协议，复用同一套 OpenCode 后端，扩展到 Zed / Neovim。
- 供应商配置支持导入/导出 JSON，方便团队内共享渠道配置（Key 除外）。
- 在设置面板增加用量看板，直接拉取 NewAPI 的统计接口展示消耗。

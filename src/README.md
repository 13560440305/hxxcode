# HxxCode - VS Code 扩展

在 VS Code 中获得与 Claude Code 一致的侧边栏 AI 编程助手体验。支持自由配置模型供应商（如 DeepSeek、OpenAI 等）。

## 架构

```
VS Code 扩展 (UI 层) ───→  模型供应商（OpenAI 兼容 API）
  聊天侧栏 + 设置面板          DeepSeek / OpenAI / 自定义
```

- **VS Code 扩展**: 渲染聊天 UI、管理供应商/模型配置、管理会话列表、维护对话上下文
- **模型供应商**: 通过扩展设置自由添加，支持任意 OpenAI 兼容协议的服务商

> 也可配合 OpenCode Server 使用（需安装 `opencode` CLI），提供 Agent 工具调用能力。

## 功能

- ✨ **侧边栏聊天** — 与 Claude Code 一致的流式对话体验
- 🔧 **工具调用可视化** — 可展开卡片展示工具执行详情
- 💬 **多会话管理** — 新建/切换/删除对话会话
- 🏢 **供应商管理** — 自由添加/切换模型供应商，支持 OpenAI 兼容协议
- 🔄 **模型即时切换** — 同一供应商下切换模型无需重启，即时生效
- 🎨 **VS Code 原生视觉** — 适配亮色/暗色主题

## 快速开始

### 编译

在项目根目录打开 **Git Bash**，执行：

```bash
cd /d/work/h2x/hxxcode/src && npm run compile
```

或者：

```bash
cd /d/work/h2x/hxxcode/src && npx tsc
```

### 在 VS Code 中运行

1. 打开项目根目录 `D:\work\h2x\hxxcode`
2. 按 `F5` 启动 Extension Development Host
3. 在新窗口的侧边栏活动栏中点击 HxxCode 图标
4. 点击 ⚙️ 按钮打开供应商设置
5. 填写 Base URL + API Key + 模型列表，保存
6. 切回聊天面板，输入消息开始对话

### 前置要求

- Node.js 20+
- VS Code 1.90+
- 一个 OpenAI 兼容的 API（如 DeepSeek、OpenAI、硅基流动等）

### 首次激活常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| 下拉框为空 | 尚未配置供应商 | 点击 ⚙️ 设置供应商 |
| "Server 未能自动启动" | 没有安装 `opencode` CLI | 忽略此警告，直连模式正常工作 |
| 发送消息无响应 | API Key 或地址错误 | 检查供应商配置后重新保存 |

### 目录结构

```
src/
├── extension.ts           # 扩展激活入口，管理生命周期
├── opencodeManager.ts     # SDK 客户端 + 流式 API
├── providerStore.ts       # 供应商配置持久化（globalState + SecretStorage）
├── chatViewProvider.ts    # 聊天侧栏 WebviewViewProvider（核心 UI）
├── settingsPanel.ts       # 供应商/模型设置面板（WebviewPanel）
├── package.json           # 扩展清单（视图、命令、配置项）
├── tsconfig.json          # TypeScript 编译配置
├── media/
│   └── logo.svg           # 活动栏图标
└── lib/@opencode-ai/sdk/  # SDK 本地桩（支持直连 / opencode 两种模式）
```

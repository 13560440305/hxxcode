# HxxCode — VS Code AI 编程助手

> **基于 [opencode-ai/cli](https://github.com/opencode-ai/cli) 的 VS Code 扩展插件**  
> 最大特点：**可自由添加和切换任意模型供应商与模型**，不受限于特定厂商的封闭生态

---

## 简介

HxxCode 是一款 VS Code 扩展，在活动栏侧边栏中提供 AI 编码 Agent 聊天体验。它底层基于 `opencode-ai/cli` 作为 Agent 执行引擎，模型请求通过 OpenAI 兼容协议转发到你配置的任意供应商。

### 核心特性

| 特性 | 说明 |
|------|------|
| 🔓 **供应商自由配置** | 可添加任意 OpenAI 兼容的 API 供应商（DeepSeek、OpenAI、硅基流动、本地 ollama……），随时切换 |
| 🤖 **Agent 能力** | 基于 opencode-ai/cli，支持读文件、写文件、终端命令、grep 搜索等工具调用 |
| 🗨️ **侧边栏聊天** | 流式对话输出，工具调用可视化展示 |
| 🔄 **模型即时切换** | 同一供应商下切换模型即时生效，无需重启 |
| 🔧 **双模式** | 直连模式（无外部依赖）或 Server 模式（通过 opencode CLI 获取完整 Agent 能力） |

---

## 快速开始

### 前置要求

- Node.js 20+
- VS Code 1.90+
- 一个 OpenAI 兼容的 API 端点

### 安装

#### 从 .vsix 安装

下载 `.vsix` 文件后，在 VS Code 中：
1. `Ctrl+Shift+P` → "Extensions: Install from VSIX..."
2. 选择 `.vsix` 文件

或命令行安装：
```bash
code --install-extension opencode-bridge-0.1.0.vsix
```

#### 开发模式运行

```bash
# 进入项目
cd D:\work\h2x\hxxcode\src

# 安装依赖
npm install

# 编译
npm run build

# 在 VS Code 中按 F5 启动 Extension Development Host
```

### 配置供应商

1. 点击活动栏 **HxxCode** 图标
2. 点击侧栏顶部的 ⚙️ 按钮打开供应商设置
3. 添加供应商：填写 **名称 / Base URL / API Key / 模型列表**
4. 保存后即可开始聊天

支持任意 OpenAI 兼容协议的服务：
- **DeepSeek** — `https://api.deepseek.com/v1`
- **OpenAI** — `https://api.openai.com/v1`
- **硅基流动** — `https://api.siliconflow.cn/v1`
- **本地 ollama** — `http://localhost:11434/v1`
- **自建网关** — 你的 NewAPI / one-api 等任意网关地址

---

## 架构

```
┌───────────────────────────────────────┐
│         VS Code 扩展 (UI 层)           │
│   聊天侧栏 + 设置面板 + 会话管理        │
└──────────────┬────────────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌──────────────┐  ┌──────────────────────┐
│  直连模式      │  │  Server 模式          │
│  (默认，无依赖) │  │  opencode CLI Agent   │
└──────┬───────┘  └────────┬─────────────┘
       │                   │
       ▼                   ▼
┌───────────────────────────────────────┐
│      OpenAI 兼容 API (你自定义的供应商)   │
│   DeepSeek / OpenAI / 自定义 / 本地 …    │
└───────────────────────────────────────┘
```

- **直连模式**：扩展直接调用供应商 API，响应快，无需额外依赖
- **Server 模式**：通过 `opencode-ai/cli` 启动本地 Agent Server，支持文件读写、终端命令等工具调用

---

## 命令

| 命令 | 标题 | 说明 |
|------|------|------|
| `opencodeBridge.openSettings` | HxxCode: 打开供应商设置 | 管理模型供应商配置 |
| `opencodeBridge.startServer` | HxxCode: 启动 / 重启 Server | 启动或重启 Agent Server |
| `opencodeBridge.showDiag` | HxxCode: 打开诊断日志 | 查看运行诊断信息 |

---

## 配置项

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `opencodeBridge.autoStart` | boolean | `true` | 打开工作区时自动启动 Server |

---

## 打包

```bash
cd src
npm run build      # esbuild 打包为单文件
npm run package    # 构建 + 输出 .vsix
```

---

## License

MIT

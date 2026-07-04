# hxxcode
OpenCode Visual Studio Code Extension plugin

---

# HxxCode — VS Code AI 编程助手扩展

## 简介

HxxCode 是一款 **VS Code 扩展插件**，在 VS Code 活动栏侧边栏中提供 AI 编程助手体验，支持自由配置模型供应商（如 DeepSeek、OpenAI 等），模型请求经 NewAPI 网关聚合，兼容 OpenAI API 协议。

**插件名**: `opencode-bridge`  
**显示名**: HxxCode  
**版本**: 0.1.0  
**最低 VS Code 版本**: 1.90+

---

## 核心功能

| 功能 | 说明 |
|------|------|
| 🗨️ **侧边栏聊天** | 流式对话体验，与 Claude Code 风格一致 |
| 🔧 **工具调用可视化** | 可展开卡片展示工具执行详情 |
| 💬 **多会话管理** | 新建 / 切换 / 删除对话会话 |
| 🏢 **供应商管理** | 自由添加 / 切换模型供应商，支持 OpenAI 兼容协议 |
| 🔄 **模型即时切换** | 同一供应商下切换模型即时生效，无需重启 |
| 🎨 **VS Code 原生视觉** | 适配亮色 / 暗色主题 |

---

## 架构概览

```
┌──────────────────────────────────────┐
│          VS Code 扩展 (UI 层)         │
│   聊天侧栏 + 设置面板 + 会话管理       │
└──────────────┬───────────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌──────────────┐  ┌─────────────────────┐
│  直连模式     │  │  OpenCode Server     │
│  (默认)       │  │  (需 opencode CLI)   │
└──────┬───────┘  └──────────┬──────────┘
       │                     │
       ▼                     ▼
┌──────────────────────────────────────┐
│      模型供应商 (OpenAI 兼容 API)      │
│   DeepSeek / OpenAI / 自定义 / ...     │
└──────────────────────────────────────┘
```

- **直连模式**：扩展直接调用供应商 API，响应快，无需额外依赖
- **Server 模式**：通过 OpenCode CLI 启动本地 Server，支持 Agent 工具调用能力

---

## 快速开始

### 前置要求

- Node.js 20+
- VS Code 1.90+
- 一个 OpenAI 兼容的 API 端点（如 DeepSeek、OpenAI、硅基流动等）

### 安装与编译

```bash
# 进入项目
cd D:\work\h2x\hxxcode\src

# 安装依赖
npm install

# 编译 TypeScript
npm run compile
```

### 在 VS Code 中运行（开发调试）

1. 用 VS Code 打开 `D:\work\h2x\hxxcode`
2. 按 `F5` 启动 Extension Development Host
3. 在新窗口的活动栏中点击 **HxxCode** 图标
4. 点击 ⚙️ 按钮打开供应商设置
5. 填写 **Base URL** + **API Key** + 模型列表，保存
6. 切回聊天面板，输入消息开始对话

### 配置供应商

```json
{
  "name": "DeepSeek",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-xxxxxxxxxxxxxxxx",
  "models": ["deepseek-chat", "deepseek-coder"]
}
```

---

## 命令列表

| 命令 | 标题 | 说明 |
|------|------|------|
| `opencodeBridge.openSettings` | HxxCode: 打开供应商设置 | 管理模型供应商配置 |
| `opencodeBridge.startServer` | HxxCode: 启动 / 重启 Server | 启动或重启 OpenCode Server |
| `opencodeBridge.showDiag` | HxxCode: 打开诊断日志 | 查看运行诊断信息 |

---

## 配置项

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `opencodeBridge.autoStart` | boolean | `true` | 打开工作区时自动启动 HxxCode Server |

---

## 目录结构

```
hxxcode/
├── README.md                # 项目简介
├── LICENSE                  # 许可协议
├── .vscode/                 # VS Code 工作区配置
│   ├── launch.json          # 调试启动配置
│   ├── tasks.json           # 构建任务
│   └── settings.json        # 工作区设置
├── docs/                    # 文档
│   ├── logo.png             # 项目 Logo
│   ├── design/              # 设计文档
│   │   └── opencode-vscode-newapi-design.md
│   └── hxxcode-readme.md    # 本文档
├── scripts/                 # 工具脚本
│   └── test-opencode-model.mjs
├── third-parts/             # 第三方依赖归档
│   └── opencode-1.17.13.tar.gz
└── src/                     # 扩展源码
    ├── extension.ts         # 扩展激活入口，管理生命周期
    ├── opencodeManager.ts   # SDK 客户端 + 流式 API
    ├── providerStore.ts     # 供应商配置持久化（globalState + SecretStorage）
    ├── chatViewProvider.ts  # 聊天侧栏 WebviewViewProvider（核心 UI）
    ├── settingsPanel.ts     # 供应商/模型设置面板（WebviewPanel）
    ├── log.ts               # 日志与诊断
    ├── storage.ts           # 本地存储管理
    ├── package.json         # 扩展清单（视图、命令、配置项）
    ├── tsconfig.json        # TypeScript 编译配置
    ├── media/               # 静态资源
    │   ├── logo.svg         # 活动栏图标
    │   └── icon.svg         # 扩展图标
    ├── lib/@opencode-ai/    # SDK 本地桩
    │   └── sdk/
    ├── node_modules/        # 依赖包（不纳入版本控制）
    └── out/                 # 编译输出（不纳入版本控制）
```

---

## 常见问题

| 现象 | 原因 | 解决方法 |
|------|------|----------|
| 下拉框为空 | 尚未配置供应商 | 点击 ⚙️ 设置供应商 |
| "Server 未能自动启动" | 未安装 `opencode` CLI | 忽略警告，直连模式正常工作 |
| 发送消息无响应 | API Key 或地址错误 | 检查供应商配置后重新保存 |
| 未找到工作区文件夹 | VS Code 未打开文件夹 | 先打开一个工作区文件夹 |

---

## 技术栈

| 层面 | 技术 |
|------|------|
| 开发语言 | TypeScript 5.5+ |
| 运行环境 | VS Code Extension API 1.90+ |
| UI 框架 | VS Code WebviewViewProvider / WebviewPanel |
| 通信协议 | OpenAI 兼容 API (SSE 流式) |
| 数据持久化 | VS Code globalState + SecretStorage |
| SDK | @opencode-ai/sdk（本地桩） |
| 可选后端 | OpenCode CLI |

---

## License

参见项目根目录 `LICENSE` 文件。

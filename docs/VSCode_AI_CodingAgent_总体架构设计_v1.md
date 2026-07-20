# VSCode AI Coding Agent 插件总体设计（基于 lildax / OpenCode Runtime）

> 目标：构建一个类似 Claude Code 的 VSCode AI Agent 插件，其中 `lildax`
> 仅作为 Agent Runtime，本插件负责输入处理、上下文管理、状态管理、UI 与
> Runtime 协调。

------------------------------------------------------------------------

# 1. 总体架构

``` text
Webview(UI)
      │
      ▼
Extension Host
      │
      ▼
ConversationManager
      │
      ▼
AgentSession(Job)
      │
      ▼
Input Pipeline
      │
      ├── NormalizeStage
      ├── VisionStage
      ├── FileStage
      ├── PromptBuildStage
      ├── RuntimeStage(lildax)
      └── PersistStage
      │
      ▼
EventBus
      │
      ├── UI(Store)
      └── Business
```

------------------------------------------------------------------------

# 2. 分层职责

  层                    职责
  --------------------- -----------------------------
  Webview               聊天 UI、输入、流式显示
  Extension Host        VSCode API、文件系统、终端
  ConversationManager   创建 Session、调度 Pipeline
  AgentSession          一次发送对应一次完整执行
  Pipeline              输入预处理及 Runtime 调用
  Runtime               lildax，仅负责 Agent 执行
  Store                 保存状态
  EventBus              业务事件通信

------------------------------------------------------------------------

# 3. 推荐目录结构

``` text
src/
 ├── conversation/
 │    ├── ConversationManager.ts
 │    ├── AgentSession.ts
 │    └── ConversationStore.ts
 │
 ├── pipeline/
 │    ├── Pipeline.ts
 │    ├── PipelineContext.ts
 │    ├── stages/
 │    │      NormalizeStage.ts
 │    │      VisionStage.ts
 │    │      FileStage.ts
 │    │      PromptBuildStage.ts
 │    │      RuntimeStage.ts
 │    │      PersistStage.ts
 │
 ├── runtime/
 │      LildaxRuntime.ts
 │
 ├── events/
 │      EventBus.ts
 │
 ├── models/
 │      ChatMessage.ts
 │      MessagePart.ts
 │
 ├── ui/
 └── extension.ts
```

------------------------------------------------------------------------

# 4. ChatMessage 模型

``` ts
interface ChatMessage{
    id:string
    role:"user"|"assistant"
    parts:MessagePart[]
}
```

``` ts
type MessagePart =
 | TextPart
 | ImagePart
 | FilePart
```

不要在业务中区分图片聊天、文本聊天。

------------------------------------------------------------------------

# 5. PipelineContext

``` ts
interface PipelineContext{

    conversationId:string

    message:ChatMessage

    prompt:string

    visionTexts:string[]

    fileContents:string[]

    stream:any

    cancelToken:any
}
```

所有 Stage 共享 Context。

------------------------------------------------------------------------

# 6. Stage 设计

## NormalizeStage

负责统一 Message 格式。

## VisionStage

遍历 ImagePart：

-   调 Vision 模型
-   得到 OCR/视觉描述
-   转换成 TextPart

建议：

``` ts
await Promise.all(images.map(runVision))
```

支持多图。

## FileStage

负责：

-   pdf
-   word
-   markdown
-   txt

读取文本。

## PromptBuildStage

统一构造 Prompt，例如：

    图片内容：
    ...

    附件内容：
    ...

    用户要求：
    ...

以后无需修改 Runtime。

## RuntimeStage

职责：

-   调 lildax
-   接收 Stream
-   发布 Token Event

不做 Prompt 拼接。

## PersistStage

负责：

-   保存消息
-   保存历史
-   更新 Store

------------------------------------------------------------------------

# 7. AgentSession 生命周期

``` text
Create
  │
Pipeline Start
  │
Vision
  │
Prompt Build
  │
Runtime
  │
Streaming
  │
Persist
  │
Finish
```

一个 Session 对应一次发送。

------------------------------------------------------------------------

# 8. EventBus

建议定义：

``` text
SendMessage
SessionCreated
VisionStarted
VisionFinished
PromptBuilt
RuntimeStarted
RuntimeToken
RuntimeFinished
SessionFinished
SessionError
```

业务监听 EventBus。

UI 不直接监听 Runtime。

------------------------------------------------------------------------

# 9. Store(liladix)

Store 只保存：

``` text
Conversation
Messages
CurrentSession
StreamingText
Loading
```

不要保存 Workflow 状态。

Workflow 属于 Pipeline。

------------------------------------------------------------------------

# 10. Streaming

Runtime 输出：

``` text
Token
Token
Token
```

RuntimeStage：

``` text
Token
 ↓
EventBus(RuntimeToken)
 ↓
Store.append()
 ↓
UI刷新
```

------------------------------------------------------------------------

# 11. 为什么不用任务队列

错误方式：

``` text
OCR Task
 ↓
Prompt Task
 ↓
LLM Task
```

推荐：

``` text
AgentSession
      │
      ▼
Pipeline
      │
      ├── VisionStage
      ├── PromptStage
      └── RuntimeStage
```

因为它们不是独立任务，而是同一个 Job 的不同阶段。

------------------------------------------------------------------------

# 12. 时序图

``` text
User
 │
 │ Send
 ▼
ConversationManager
 │
 ▼
AgentSession
 │
 ▼
Pipeline
 │
 ├── Vision
 ├── File
 ├── Prompt
 └── Runtime(lildax)
 │
 ▼
EventBus
 │
 ▼
Store
 │
 ▼
Webview
```

------------------------------------------------------------------------

# 13. 后续扩展

新增能力时，仅增加 Stage：

-   MCPStage
-   ToolCallStage
-   GitStage
-   CodeReviewStage
-   MemoryStage
-   SummaryStage

ConversationManager 不需要修改。

------------------------------------------------------------------------

# 14. 设计原则

1.  Runtime 与业务解耦。
2.  图片最终转换为文本。
3.  Pipeline 是流程，不是 FIFO 队列。
4.  Context 在 Stage 间共享。
5.  EventBus 负责业务通信。
6.  Store 负责状态。
7.  一个 Session = 一次完整 AI 请求。
8.  lildax 仅作为 Runtime Worker。
9.  所有输入统一抽象为 MessagePart。
10. 未来新增能力优先新增 Stage，而不是修改已有代码。

会话级「同时只跑一轮」由 `ConversationManager` 单飞保证，**不是** FIFO 任务队列。实现说明见 [docs/design/pipeline-session-refactor.md](design/pipeline-session-refactor.md)。

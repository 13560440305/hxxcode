/**
 * 设计 §9：Store 只保存会话展示态，不保存 Workflow。
 */
export class ConversationStore {
  currentConversationId: string | null = null;
  currentSessionId: string | null = null;
  streamingText = "";
  loading = false;

  resetTurn(): void {
    this.streamingText = "";
    this.loading = false;
    this.currentSessionId = null;
  }

  beginTurn(conversationId: string, sessionId: string): void {
    this.currentConversationId = conversationId;
    this.currentSessionId = sessionId;
    this.streamingText = "";
    this.loading = true;
  }

  appendStreaming(text: string): void {
    this.streamingText += text;
  }

  endTurn(): void {
    this.loading = false;
  }
}

import type { MessagePart } from "./MessagePart";

/** 业务层消息（Pipeline 输入）；与 Webview UI 消息结构分离 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
}

export function textFromParts(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export function imageParts(parts: MessagePart[]) {
  return parts.filter(
    (p): p is Extract<MessagePart, { type: "image" }> => p.type === "image"
  );
}

export function fileParts(parts: MessagePart[]) {
  return parts.filter(
    (p): p is Extract<MessagePart, { type: "file" }> => p.type === "file"
  );
}

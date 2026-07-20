import type { ProviderConfig } from "./providerStore";
import { modelSupportsVision } from "./providerStore";

export type VisionImageInput = {
  mime: string;
  /** data:image/...;base64,... */
  dataUrl: string;
  name?: string;
};

/** 在供应商识图模型列表中挑选（优先用户已选 / 列表顺序） */
export function pickVisionModel(
  provider: ProviderConfig,
  preferred?: string | null
): string | null {
  const models =
    provider.visionModels && provider.visionModels.length > 0
      ? provider.visionModels
      : (provider.models ?? []).filter((m) => modelSupportsVision(provider, m));
  if (!models.length) return null;
  if (preferred) {
    const found = models.find((m) => m.toLowerCase() === preferred.toLowerCase());
    if (found) return found;
  }
  const scored = models
    .map((m) => {
      let score = 1;
      if (/glm-4\.6v/i.test(m)) score = 100;
      else if (/glm-5v/i.test(m)) score = 90;
      else if (/4\.6v|5v|qwen.*vl/i.test(m)) score = 80;
      else if (/gpt-4o|claude|gemini/i.test(m)) score = 70;
      return { m, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.m ?? models[0] ?? null;
}

/**
 * 直连 OpenAI 兼容 /chat/completions 做「只识图、不调工具」。
 * 不走 opencode-ai/cli，避免 Vision 与 Agent 工具循环耦合。
 */
export async function recognizeImagesToText(options: {
  baseURL: string;
  apiKey: string;
  model: string;
  images: VisionImageInput[];
  /** 用户附带的文字提示（可空） */
  userHint?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { baseURL, apiKey, model, images, userHint, signal } = options;
  if (!images.length) return "";

  const root = baseURL.replace(/\/+$/, "");
  const url = `${root}/chat/completions`;

  const instruction = userHint?.trim()
    ? `用户还附带了以下说明，请在识图时一并考虑：\n${userHint.trim()}\n\n请完整、准确地描述图片中的文字、界面元素与关键信息，供后续编程助手使用。只输出识别内容，不要寒暄。`
    : `请完整、准确地描述图片中的文字、界面元素与关键信息，供后续编程助手使用。只输出识别内容，不要寒暄。`;

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: instruction },
  ];
  for (const img of images) {
    content.push({
      type: "image_url",
      image_url: { url: img.dataUrl },
    });
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      stream: false,
      temperature: 0.2,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`图片识别失败 (${res.status}): ${body.slice(0, 400)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  };
  const raw = json?.choices?.[0]?.message?.content;
  let text = "";
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n");
  }
  text = text.trim();
  if (!text) {
    throw new Error("图片识别成功但未返回文字内容，请换用 glm-4.6v / glm-5v-turbo 重试");
  }
  return text;
}

/** 把用户文字与识图结果拼成交给 Agent 的纯文本 */
export function buildAgentPromptFromVision(options: {
  userText: string;
  visionText: string;
}): string {
  const user = options.userText.trim();
  const vision = options.visionText.trim();
  if (user && vision) {
    return (
      `${user}\n\n` +
      `------\n` +
      `【图片识别结果】\n${vision}\n` +
      `------\n` +
      `请结合以上用户说明与图片识别结果继续处理。`
    );
  }
  if (vision) {
    return (
      `请根据以下图片识别结果进行处理：\n\n` +
      `${vision}`
    );
  }
  return user;
}

import * as vscode from "vscode";
import { readJSON, writeJSON, getConfigPath, ensureDirs } from "./storage";
import {
  type AgentBackendCustom,
  type AgentBackendDefinition,
  type AgentBackendSettings,
  defaultAgentBackendSettings,
  listAgentBackends,
  normalizeAgentBackendSettings,
  resolveActiveAgentBackend,
} from "./agentBackend";

export type ProviderKind = "openai-compatible" | "anthropic-compatible" | "custom";

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseURL: string;
  /** 自定义 npm 包名，仅 kind === "custom" 时使用 */
  npm?: string;
  models: string[];
  isDefault?: boolean;
}

interface ProviderState {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  activeModel: string | null;
  /** API Key 按 provider.id 存储 */
  apiKeys: Record<string, string>;
  /** Agent CLI 后端（默认 @opencode-ai/cli） */
  agentBackend: AgentBackendSettings;
}

const STATE_KEY = "opencodeBridge.providerState";
const SECRET_PREFIX = "opencodeBridge.apiKey.";
const CONFIG_FILE = "config.json";

const DEFAULT_STATE: ProviderState = {
  providers: [],
  activeProviderId: null,
  activeModel: null,
  apiKeys: {},
  agentBackend: defaultAgentBackendSettings(),
};

/**
 * 供应商配置持久化。
 * 主存储：~/.hxxcode/config.json
 * 首次使用时会从 VS Code globalState + SecretStorage 迁移旧数据。
 */
export class ProviderStore {
  private state: ProviderState;
  private configPath: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.configPath = getConfigPath();
    this.state = { ...DEFAULT_STATE };
    // 实际初始化由 load() 异步完成
  }

  /** 异步加载数据（必须在 create 后调用） */
  async load(): Promise<void> {
    // 从 ~/.hxxcode/config.json 读取
    const fileState = await readJSON<ProviderState | null>(this.configPath, null);

    if (fileState && fileState.providers && fileState.providers.length > 0) {
      const deduped = dedupeProviders(fileState.providers);
      this.state = {
        ...DEFAULT_STATE,
        ...fileState,
        providers: deduped,
        agentBackend: normalizeAgentBackendSettings(fileState.agentBackend),
      };
      if (deduped.length !== fileState.providers.length) {
        await this.persist();
      } else {
        const before = JSON.stringify(fileState.providers);
        const after = JSON.stringify(deduped);
        if (before !== after) {
          await this.persist();
        }
      }
      return;
    }

    // 尝试从 VS Code globalState 迁移旧数据
    const oldState = this.context.globalState.get<ProviderState>(STATE_KEY);
    if (oldState && oldState.providers && oldState.providers.length > 0) {
      // 迁移 API Keys
      const apiKeys: Record<string, string> = {};
      for (const p of oldState.providers) {
        const key = await this.context.secrets.get(SECRET_PREFIX + p.id);
        if (key) apiKeys[p.id] = key;
      }
      this.state = {
        providers: dedupeProviders(oldState.providers),
        activeProviderId: oldState.activeProviderId,
        activeModel: oldState.activeModel,
        apiKeys,
        agentBackend: defaultAgentBackendSettings(),
      };
      await this.persist();
      // 清理旧数据
      await this.context.globalState.update(STATE_KEY, undefined);
      return;
    }

    // 全新安装，用默认值
    this.state = { ...DEFAULT_STATE };
  }

  /** 首次激活时确保存在一个可用的默认供应商（占位） */
  async ensureDefaultProvider(): Promise<void> {
    await this.load(); // 确保加载
    if (this.state.providers.length > 0) return;
    await this.upsertProvider(
      {
        id: "newapi-default",
        name: "我的 NewAPI",
        kind: "openai-compatible",
        baseURL: "",
        models: [],
        isDefault: true,
      },
      ""
    );
  }

  list(): ProviderConfig[] {
    return dedupeProviders(this.state.providers);
  }

  // ── Agent 后端（CLI 插件）────────────────────────────────────────────────

  getAgentBackendSettings(): AgentBackendSettings {
    return this.state.agentBackend;
  }

  getActiveAgentBackend(): AgentBackendDefinition {
    return resolveActiveAgentBackend(this.state.agentBackend);
  }

  listAgentBackends(): AgentBackendDefinition[] {
    return listAgentBackends(this.state.agentBackend);
  }

  async setActiveAgentBackend(backendId: string): Promise<void> {
    const available = this.listAgentBackends();
    if (!available.some((b) => b.id === backendId)) {
      throw new Error(`未知的 Agent 后端：${backendId}`);
    }
    this.state.agentBackend = {
      ...this.state.agentBackend,
      activeId: backendId,
    };
    await this.persist();
  }

  /** 注册或更新用户自定义 Agent 后端（写入 config.json agentBackend.custom） */
  async upsertCustomAgentBackend(id: string, config: AgentBackendCustom): Promise<void> {
    this.state.agentBackend = {
      ...this.state.agentBackend,
      custom: {
        ...(this.state.agentBackend.custom ?? {}),
        [id]: config,
      },
    };
    await this.persist();
  }

  get(id: string): ProviderConfig | undefined {
    return this.state.providers.find((p) => p.id === id);
  }

  getActive(): { provider: ProviderConfig | undefined; model: string | null } {
    const provider = this.state.activeProviderId
      ? this.get(this.state.activeProviderId)
      : this.state.providers.find((p) => p.isDefault) ?? this.state.providers[0];
    const model = provider
      ? resolveCanonicalModel(provider.models, this.state.activeModel)
      : this.state.activeModel;
    return { provider, model };
  }

  async setActive(providerId: string, model: string): Promise<void> {
    const provider = this.get(providerId);
    this.state.activeProviderId = providerId;
    this.state.activeModel = provider
      ? resolveCanonicalModel(provider.models, model)
      : model;
    await this.persist();
  }

  async upsertProvider(config: ProviderConfig, apiKey: string): Promise<ProviderConfig> {
    const normalized = normalizeProviderConfig(config);

    let idx = this.state.providers.findIndex((p) => p.id === normalized.id);
    if (idx < 0) {
      const key = providerMatchKey(normalized);
      idx = this.state.providers.findIndex((p) => providerMatchKey(p) === key);
    }

    let saved: ProviderConfig;
    if (idx >= 0) {
      const existing = this.state.providers[idx];
      saved = {
        ...existing,
        ...normalized,
        id: existing.id,
        models: dedupeModels(normalized.models),
      };
      this.state.providers[idx] = saved;
    } else {
      let id = normalized.id;
      if (!id || id.startsWith("new-")) {
        id = slugifyProviderId(normalized.name);
        if (this.state.providers.some((p) => p.id === id)) {
          id = `${id}-${Date.now().toString(36)}`;
        }
      }
      saved = { ...normalized, id };
      this.state.providers.push(saved);
    }

    this.state.providers = dedupeProviders(this.state.providers);
    const matchKey = providerMatchKey(saved);
    saved = this.state.providers.find((p) => providerMatchKey(p) === matchKey) ?? saved;

    if (apiKey) {
      this.state.apiKeys[saved.id] = apiKey;
      await this.context.secrets.store(SECRET_PREFIX + saved.id, apiKey);
    }
    if (this.state.activeProviderId === saved.id) {
      const active = resolveCanonicalModel(saved.models, this.state.activeModel);
      this.state.activeModel = active ?? saved.models[0] ?? null;
    } else if (!this.state.activeProviderId) {
      this.state.activeProviderId = saved.id;
      this.state.activeModel = saved.models[0] ?? null;
    }
    await this.persist();
    return saved;
  }

  async removeProvider(id: string): Promise<void> {
    this.state.providers = dedupeProviders(
      this.state.providers.filter((p) => p.id !== id)
    );
    delete this.state.apiKeys[id];
    await this.context.secrets.delete(SECRET_PREFIX + id);
    if (this.state.activeProviderId === id) {
      this.state.activeProviderId = this.state.providers[0]?.id ?? null;
      this.state.activeModel = this.state.providers[0]?.models[0] ?? null;
    }
    await this.persist();
  }

  async getApiKey(id: string): Promise<string | undefined> {
    // 先读内存缓存
    if (this.state.apiKeys[id]) return this.state.apiKeys[id];
    // 再读 SecretStorage
    return this.context.secrets.get(SECRET_PREFIX + id);
  }

  /**
   * 拉取远端 /v1/models，用于设置面板里的"获取模型列表"按钮。
   */
  async fetchModels(baseURL: string, apiKey: string): Promise<string[]> {
    const root = normalizeBaseURL(baseURL.trim());
    const res = await fetch(`${root.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`获取模型列表失败：HTTP ${res.status}`);
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => m.id).sort();
  }

  private async persist(): Promise<void> {
    await ensureDirs();
    this.state.providers = dedupeProviders(this.state.providers);
    // 写 ~/.hxxcode/config.json
    await writeJSON(this.configPath, {
      providers: this.state.providers,
      activeProviderId: this.state.activeProviderId,
      activeModel: this.state.activeModel,
      apiKeys: this.state.apiKeys,
      agentBackend: this.state.agentBackend,
    });
  }
}

const npmForKind = (kind: ProviderKind, custom?: string): string => {
  if (kind === "custom" && custom) return custom;
  if (kind === "anthropic-compatible") return "@ai-sdk/anthropic";
  return "@ai-sdk/openai-compatible";
};

/**
 * 把 ProviderStore 的状态翻译成 opencode.json 里的 provider 段。
 * apiKey 用环境变量占位，真正的值通过 env 注入。
 */
function normalizeBaseURL(baseURL: string): string {
  let trimmed = baseURL.trim().replace(/\/+$/, "");
  // 用户填了完整 chat/completions 路径时，去掉后缀留给 SDK 拼接
  if (trimmed.endsWith("/chat/completions")) {
    trimmed = trimmed.slice(0, -"/chat/completions".length).replace(/\/+$/, "");
  }
  // 路径中已含版本段（/v、/v1、/v4 等）时不再追加 /v1
  if (/\/v\d*(?:\/|$)/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

/** 将 activeModel 解析为供应商 models 列表中的规范名称（大小写不敏感匹配） */
function resolveCanonicalModel(
  models: string[],
  model: string | null | undefined
): string | null {
  if (!model?.trim()) return models[0] ?? null;
  const trimmed = model.trim();
  const found = models.find((m) => m.toLowerCase() === trimmed.toLowerCase());
  return found ?? trimmed;
}

function slugifyProviderId(name: string): string {
  let s = "";
  for (const c of name.toLowerCase()) {
    const code = c.charCodeAt(0);
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      s += c;
    } else {
      s += "-";
    }
  }
  while (s.includes("--")) s = s.replace(/--/g, "-");
  while (s.startsWith("-")) s = s.slice(1);
  while (s.endsWith("-")) s = s.slice(0, -1);
  return s || "provider";
}

function dedupeModels(models: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of models) {
    const trimmed = m.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function normalizeProviderMatchURL(baseURL: string): string {
  let s = (baseURL || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/\/+$/, "");
  s = s.replace(/\/chat\/completions$/, "");
  s = s.replace(/\/v1$/, "");
  return s.replace(/\/+$/, "");
}

function providerMatchKey(config: Pick<ProviderConfig, "name" | "baseURL">): string {
  const name = config.name.trim().toLowerCase();
  const url = normalizeProviderMatchURL(config.baseURL || "");
  return `${name}::${url}`;
}

function normalizeProviderConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    name: config.name.trim(),
    baseURL: normalizeBaseURL(config.baseURL.trim()),
    models: dedupeModels(config.models ?? []),
  };
}

/** 按名称 + Base URL 合并重复供应商，并去重模型列表 */
function dedupeProviders(providers: ProviderConfig[]): ProviderConfig[] {
  const byKey = new Map<string, ProviderConfig>();
  for (const raw of providers) {
    const p = normalizeProviderConfig(raw);
    const key = providerMatchKey(p);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, p);
      continue;
    }
    byKey.set(key, {
      ...existing,
      ...p,
      id: existing.id,
      models: dedupeModels([...existing.models, ...p.models]),
    });
  }
  return Array.from(byKey.values());
}

export function buildOpencodeProviderConfig(
  providers: ProviderConfig[],
  apiKeys: Record<string, string> = {}
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const p of providers) {
    if (!p.baseURL) continue;
    const apiKey = apiKeys[p.id] ?? `{env:${envVarName(p.id)}}`;
    result[p.id] = {
      npm: npmForKind(p.kind, p.npm),
      name: p.name,
      options: {
        baseURL: normalizeBaseURL(p.baseURL),
        apiKey,
      },
      models: Object.fromEntries(
        p.models.map((m) => [
          m,
          {
            name: m,
            modalities: modelSupportsVision(p, m)
              ? { input: ["text", "image"], output: ["text"] }
              : { input: ["text"], output: ["text"] },
          },
        ])
      ),
    };
  }
  return result;
}

export function envVarName(providerId: string): string {
  return `OPENCODE_BRIDGE_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
}

/** 已知仅支持纯文本的 API 域名（官方接口不接受 image_url） */
const TEXT_ONLY_API_HOSTS = [/deepseek\.com/i, /api\.deepseek/i];

/** 模型名暗示支持 Vision 的常见模式 */
const VISION_MODEL_PATTERNS = [
  /gpt-4o/i,
  /gpt-4-turbo/i,
  /gpt-4-vision/i,
  /gpt-5/i,
  /claude-3/i,
  /claude-sonnet-4/i,
  /claude-opus-4/i,
  /gemini-2/i,
  /gemini.*flash/i,
  /gemini.*pro/i,
  /glm-4\.6v/i,
  /glm-4v/i,
  /qwen-vl/i,
  /vision/i,
  /4v\b/i,
  /\.6v\b/i,
];

/** 当前供应商 + 模型是否应向 OpenCode 声明 image 输入能力 */
export function modelSupportsVision(provider: ProviderConfig, model: string): boolean {
  const base = provider.baseURL || "";
  if (TEXT_ONLY_API_HOSTS.some((re) => re.test(base))) {
    return false;
  }
  if (VISION_MODEL_PATTERNS.some((re) => re.test(model))) {
    return true;
  }
  if (/vl|vision|4v|\.6v/i.test(model)) {
    return true;
  }
  return true;
}

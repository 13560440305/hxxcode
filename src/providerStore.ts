import * as vscode from "vscode";
import { readJSON, writeJSON, getConfigPath, ensureDirs } from "./storage";
import { log } from "./log";
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
      // 文件存在且有数据
      this.state = {
        ...DEFAULT_STATE,
        ...fileState,
        agentBackend: normalizeAgentBackendSettings(fileState.agentBackend),
      };
      log("ProviderStore: 从 ~/.hxxcode/config.json 加载", fileState.providers.length, "个供应商");
      log(
        "ProviderStore: Agent 后端",
        resolveActiveAgentBackend(this.state.agentBackend).id
      );
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
        providers: oldState.providers,
        activeProviderId: oldState.activeProviderId,
        activeModel: oldState.activeModel,
        apiKeys,
        agentBackend: defaultAgentBackendSettings(),
      };
      await this.persist();
      log("ProviderStore: 从 VS Code 迁移旧数据完成", oldState.providers.length, "个供应商");
      // 清理旧数据
      await this.context.globalState.update(STATE_KEY, undefined);
      return;
    }

    // 全新安装，用默认值
    this.state = { ...DEFAULT_STATE };
    log("ProviderStore: 全新安装，无已有数据");
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
    return this.state.providers;
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
    log("ProviderStore: 切换 Agent 后端 →", backendId);
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
    log("ProviderStore: 注册自定义 Agent 后端", id);
  }

  get(id: string): ProviderConfig | undefined {
    return this.state.providers.find((p) => p.id === id);
  }

  getActive(): { provider: ProviderConfig | undefined; model: string | null } {
    const provider = this.state.activeProviderId
      ? this.get(this.state.activeProviderId)
      : this.state.providers.find((p) => p.isDefault) ?? this.state.providers[0];
    return { provider, model: this.state.activeModel };
  }

  async setActive(providerId: string, model: string): Promise<void> {
    this.state.activeProviderId = providerId;
    this.state.activeModel = model;
    await this.persist();
  }

  async upsertProvider(config: ProviderConfig, apiKey: string): Promise<void> {
    const idx = this.state.providers.findIndex((p) => p.id === config.id);
    if (idx >= 0) {
      this.state.providers[idx] = config;
    } else {
      this.state.providers.push(config);
    }
    if (apiKey) {
      this.state.apiKeys[config.id] = apiKey;
      // 同时也存 SecretStorage
      await this.context.secrets.store(SECRET_PREFIX + config.id, apiKey);
    }
    if (!this.state.activeProviderId) {
      this.state.activeProviderId = config.id;
      this.state.activeModel = config.models[0] ?? null;
    } else if (
      this.state.activeProviderId === config.id &&
      !this.state.activeModel &&
      config.models.length > 0
    ) {
      this.state.activeModel = config.models[0];
    }
    await this.persist();
  }

  async removeProvider(id: string): Promise<void> {
    this.state.providers = this.state.providers.filter((p) => p.id !== id);
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
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
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
  const trimmed = baseURL.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
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
      models: Object.fromEntries(p.models.map((m) => [m, { name: m }])),
    };
  }
  return result;
}

export function envVarName(providerId: string): string {
  return `OPENCODE_BRIDGE_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
}

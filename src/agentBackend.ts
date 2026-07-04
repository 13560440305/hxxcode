/**
 * Agent 后端（CLI 插件）配置。
 * 默认使用官方 @opencode-ai/cli；可在 ~/.hxxcode/config.json 切换或注册定制版。
 */

import { execSync } from "child_process";

export type AgentProtocol = "opencode-sdk";

/**
 * 检测命令是否在 PATH 上可用。
 * 跨平台：Windows 用 where，macOS/Linux 用 command -v。
 */
export function checkCommandExists(command: string): boolean {
  try {
    if (process.platform === "win32") {
      execSync(`where ${command}`, { stdio: "ignore" });
    } else {
      execSync(`command -v ${command}`, { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 自动检测系统上可用的第一个内置 CLI 后端 ID。
 * 按优先级检测：lildax → opencode → null
 */
export function detectFirstAvailableBackend(): string | null {
  for (const backend of BUILTIN_BACKENDS) {
    if (checkCommandExists(backend.command)) {
      return backend.id;
    }
  }
  return null;
}

/** 内置或用户注册的 Agent 后端定义 */
export interface AgentBackendDefinition {
  id: string;
  name: string;
  /** PATH 上的命令名，或绝对路径 */
  command: string;
  /** npm 包名，用于安装提示 */
  npmPackage?: string;
  protocol: AgentProtocol;
  builtin: boolean;
}

/** ~/.hxxcode/config.json 中的 agentBackend 段 */
export interface AgentBackendSettings {
  /** 当前激活的后端 id，默认 opencode-ai/cli */
  activeId: string;
  /**
   * 用户自定义后端（例如基于 @opencode-ai/cli fork 的定制 CLI）。
   * key 为后端 id，需在 activeId 中引用才会生效。
   */
  custom?: Record<string, AgentBackendCustom>;
}

export interface AgentBackendCustom {
  name: string;
  command: string;
  npmPackage?: string;
  protocol?: AgentProtocol;
}

export const DEFAULT_AGENT_BACKEND_ID = "opencode-ai/cli";

const BUILTIN_BACKENDS: AgentBackendDefinition[] = [
  {
    id: "opencode-ai/cli",
    name: "OpenCode CLI（官方 @opencode-ai/cli）",
    command: "lildax",
    npmPackage: "@opencode-ai/cli",
    protocol: "opencode-sdk",
    builtin: true,
  },
  {
    id: "opencode-ai/cli:opencode",
    name: "OpenCode CLI（opencode 命令别名）",
    command: "opencode",
    npmPackage: "@opencode-ai/cli",
    protocol: "opencode-sdk",
    builtin: true,
  },
];

export function defaultAgentBackendSettings(): AgentBackendSettings {
  return { activeId: DEFAULT_AGENT_BACKEND_ID };
}

export function normalizeAgentBackendSettings(
  raw: Partial<AgentBackendSettings> | undefined
): AgentBackendSettings {
  const defaults = defaultAgentBackendSettings();
  if (!raw) return defaults;
  return {
    activeId: raw.activeId ?? defaults.activeId,
    custom: raw.custom,
  };
}

/** 合并内置预设与用户 custom，得到可选后端列表 */
export function listAgentBackends(
  settings: AgentBackendSettings | undefined
): AgentBackendDefinition[] {
  const normalized = normalizeAgentBackendSettings(settings);
  const customDefs: AgentBackendDefinition[] = Object.entries(
    normalized.custom ?? {}
  ).map(([id, c]) => ({
    id,
    name: c.name,
    command: c.command,
    npmPackage: c.npmPackage,
    protocol: c.protocol ?? "opencode-sdk",
    builtin: false,
  }));
  return [...BUILTIN_BACKENDS, ...customDefs];
}

/** 解析当前应使用的 Agent 后端；未知 id 时回退官方默认 */
export function resolveActiveAgentBackend(
  settings: AgentBackendSettings | undefined
): AgentBackendDefinition {
  const normalized = normalizeAgentBackendSettings(settings);
  const all = listAgentBackends(normalized);
  return all.find((b) => b.id === normalized.activeId) ?? BUILTIN_BACKENDS[0];
}

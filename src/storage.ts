import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ── 目录管理 ──────────────────────────────────────────────────────────────
// ~/.hxxcode/           — 扩展自有数据（会话历史、config.json）
// ~/.config/opencode/   — OpenCode 标准配置目录（opencode.json / opencode.jsonc）

export function getHxxCodeDir(): string {
  return path.join(os.homedir(), ".hxxcode");
}

/** 未打开 VS Code 工作区时，Agent 使用的默认工作目录 */
export function getDefaultWorkspaceDir(): string {
  return path.join(getHxxCodeDir(), "default-workspace");
}

export async function ensureDefaultWorkspaceDir(): Promise<string> {
  const dir = getDefaultWorkspaceDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function getSessionsDir(): string {
  return path.join(getHxxCodeDir(), "sessions");
}

export function getConfigPath(): string {
  return path.join(getHxxCodeDir(), "config.json");
}

export function getOpencodeDir(): string {
  return path.join(os.homedir(), ".config", "opencode");
}

/** OpenCode 2.0 优先读 opencode.jsonc，其次 opencode.json */
export function getOpencodeConfigPath(): string {
  const dir = getOpencodeDir();
  const jsonc = path.join(dir, "opencode.jsonc");
  const json = path.join(dir, "opencode.json");
  if (fsSync.existsSync(jsonc)) return jsonc;
  return json;
}

export function getSessionPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.json`);
}

/** 确保扩展自有数据目录存在 */
export async function ensureDirs(): Promise<void> {
  await fs.mkdir(getHxxCodeDir(), { recursive: true });
  await fs.mkdir(getSessionsDir(), { recursive: true });
}

/** 确保 OpenCode 标准配置目录存在 */
export async function ensureOpencodeDirs(): Promise<void> {
  await fs.mkdir(getOpencodeDir(), { recursive: true });
}

// ── JSON 文件读写 ─────────────────────────────────────────────────────────

/** 去掉 JSONC 行注释与块注释，便于解析 opencode.jsonc */
export function stripJsonComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

export async function readJSON<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const text = filePath.endsWith(".jsonc") ? stripJsonComments(raw) : raw;
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export async function writeJSON(filePath: string, data: unknown): Promise<void> {
  await ensureDirs();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

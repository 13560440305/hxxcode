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

export function getArchiveDir(): string {
  return path.join(getSessionsDir(), "archive");
}

export function getConfigPath(): string {
  return path.join(getHxxCodeDir(), "config.json");
}

export function getSessionIndexPath(): string {
  return path.join(getHxxCodeDir(), "sessions-index.json");
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

/** 会话附件目录：~/.hxxcode/sessions/{sessionId}/attachments/ */
export function getSessionAttachmentsDir(sessionId: string): string {
  return path.join(getSessionsDir(), sessionId, "attachments");
}

export async function ensureSessionAttachmentsDir(sessionId: string): Promise<string> {
  const dir = getSessionAttachmentsDir(sessionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function getArchiveSessionPath(sessionId: string): string {
  return path.join(getArchiveDir(), `${sessionId}.json`);
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

// ── Session 索引（轻量元数据，一个文件替代 N 个文件遍历） ────────────────

export interface SessionIndexEntry {
  id: string;
  title: string;
  createdAt: number;
  messageCount: number;
  lastPreview: string;
  archived: boolean;
}

/** 读 sessions-index.json，返回全部索引条目 */
export async function loadSessionIndex(): Promise<SessionIndexEntry[]> {
  try {
    const raw = await fs.readFile(getSessionIndexPath(), "utf-8");
    return JSON.parse(raw) as SessionIndexEntry[];
  } catch {
    return [];
  }
}

/** 全量覆写 sessions-index.json */
export async function saveSessionIndex(entries: SessionIndexEntry[]): Promise<void> {
  await ensureDirs();
  await fs.writeFile(
    getSessionIndexPath(),
    JSON.stringify(entries, null, 2),
    "utf-8"
  );
}

/** 将 session JSON 文件移到归档目录 */
export async function archiveSessionFile(sessionId: string): Promise<void> {
  const src = getSessionPath(sessionId);
  const dst = getArchiveSessionPath(sessionId);
  await fs.mkdir(getArchiveDir(), { recursive: true });
  try {
    await fs.rename(src, dst);
  } catch {
    // 如果 rename 失败（跨文件系统），回退到复制 + 删除
    try {
      await fs.copyFile(src, dst);
      await fs.unlink(src);
    } catch {
      // 静默失败
    }
  }
}

/** 读单个 session messages（按需加载，不常驻内存） */
export async function loadSessionMessages(
  sessionId: string
): Promise<{ messages: Array<{ role: string; text: string; toolCalls: unknown[]; isStreaming: boolean }> } | null> {
  const tryPath = async (p: string) => {
    try {
      const raw = await fs.readFile(p, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  return (await tryPath(getSessionPath(sessionId))) ?? (await tryPath(getArchiveSessionPath(sessionId)));
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

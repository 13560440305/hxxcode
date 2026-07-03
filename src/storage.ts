import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ── ~/.HxxCode/ 目录管理 ──────────────────────────────────────────────────

export function getHxxCodeDir(): string {
  return path.join(os.homedir(), ".HxxCode");
}

export function getSessionsDir(): string {
  return path.join(getHxxCodeDir(), "sessions");
}

export function getConfigPath(): string {
  return path.join(getHxxCodeDir(), "config.json");
}

export function getOpencodeConfigPath(): string {
  return path.join(getHxxCodeDir(), "opencode.json");
}

export function getSessionPath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.json`);
}

/** 确保 ~/.HxxCode/ 和相关子目录存在 */
export async function ensureDirs(): Promise<void> {
  await fs.mkdir(getHxxCodeDir(), { recursive: true });
  await fs.mkdir(getSessionsDir(), { recursive: true });
}

// ── JSON 文件读写 ─────────────────────────────────────────────────────────

export async function readJSON<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJSON(filePath: string, data: unknown): Promise<void> {
  await ensureDirs();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

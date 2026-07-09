// 诊断日志：默认关闭。开启方式：设置 opencodeBridge.debug = true
// 或命令面板 → HxxCode: 打开诊断日志

import * as vscode from "vscode";

let _channel: vscode.OutputChannel | null = null;
let _debugEnabled = false;

function channel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel("HxxCode 诊断");
  }
  return _channel;
}

export function initLogging(context: vscode.ExtensionContext): void {
  _debugEnabled = vscode.workspace
    .getConfiguration("opencodeBridge")
    .get<boolean>("debug", false);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("opencodeBridge.debug")) {
        _debugEnabled = vscode.workspace
          .getConfiguration("opencodeBridge")
          .get<boolean>("debug", false);
      }
    })
  );
}

export function isDebugEnabled(): boolean {
  return _debugEnabled;
}

export function showDiag(): void {
  channel().show();
}

function formatLine(args: unknown[]): string {
  const ts = new Date().toLocaleTimeString();
  const msg = args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  return `[${ts}] ${msg}`;
}

/** 调试日志，仅在 opencodeBridge.debug 开启时输出 */
export function log(...args: unknown[]): void {
  if (!_debugEnabled) return;
  const line = formatLine(args);
  channel().appendLine(line);
  console.log("[HxxCode]", ...args);
}

/** 错误日志，始终输出 */
export function logError(...args: unknown[]): void {
  const line = formatLine(args);
  channel().appendLine(line);
  console.error("[HxxCode]", ...args);
}

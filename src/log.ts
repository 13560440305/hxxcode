// ── 共享诊断日志 ───────────────────────────────────────────────────────────
// 在 Extension Development Host 中按 Ctrl+Shift+I → Console 查看
// 或在 OUTPUT 面板中选择 "HxxCode 诊断"

import * as vscode from "vscode";

let _channel: vscode.OutputChannel | null = null;

function channel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel("HxxCode 诊断");
  }
  return _channel;
}

export function showDiag(): void {
  channel().show();
}

export function log(...args: unknown[]): void {
  const ts = new Date().toLocaleTimeString();
  const msg = args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a, null, 2);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  const line = `[${ts}] ${msg}`;
  channel().appendLine(line);
  console.log("[HxxCode]", ...args);
}

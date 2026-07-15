// @opencode-ai/sdk — OpenCode 2.0 双模式适配
// lildax 模式：通过 `lildax service start` 启动后台 server
// opencode 模式：通过 `opencode serve` 启动前台 server

import { spawn } from "node:child_process";
import { createServer } from "node:net";

const CLI_CANDIDATES = ["opencode", "lildax"];
const DEFAULT_SERVE_PORT = 4096;
const DEFAULT_STARTUP_TIMEOUT_MS = process.platform === "win32" ? 90_000 : 45_000;
const SERVE_HOST = "127.0.0.1";

/** OpenCode 2.0 预览版 (lildax) */
const API_V2 = { id: "v2", prefix: "/api", healthPath: "/api/health" };
/** 标准 opencode CLI（macOS 常见，与 HxxCode 不兼容） */
const API_STANDARD = { id: "standard", prefix: "", healthPath: "/global/health" };

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

function createLogger(onLog) {
  return (msg) => onLog?.(msg);
}

function preview(text, max = 300) {
  if (!text) return "";
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

// ── CLI 工具 ─────────────────────────────────────────────────────────────

async function detectCli(log) {
  for (const name of CLI_CANDIDATES) {
    try {
      await runCli(name, ["--version"], { log });
      log(`检测到 CLI: ${name}`);
      return name;
    } catch {
      log(`CLI 不可用: ${name}`);
    }
  }
  return null;
}

/** 使用配置指定的 CLI，或自动检测 */
async function resolveCli(log, preferred, npmPackage) {
  if (preferred) {
    // 跳过 --version：Windows 上每次 CLI 调用约 2s+，启动阶段尽量复用已有 service
    log(`使用配置的 Agent CLI: ${preferred}`);
    return preferred;
  }
  return detectCli(log);
}

function runCli(cli, args, options = {}) {
  const { cwd, env, onStderr, log = () => {} } = options;
  const cmd = `${cli} ${args.join(" ")}`;
  const t0 = Date.now();
  log(`→ CLI 开始: ${cmd}${cwd ? ` (cwd=${cwd})` : ""}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(cli, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      cwd,
      shell: process.platform === "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      onStderr?.(text);
    });
    proc.on("error", (err) => {
      log(`✗ CLI 错误 (${Date.now() - t0}ms): ${cmd} — ${err.message}`);
      reject(err);
    });
    proc.on("close", (code) => {
      const ms = Date.now() - t0;
      if (code !== 0) {
        log(
          `✗ CLI 失败 (${ms}ms, exit=${code}): ${cmd}\n  stderr: ${preview(stderr)}\n  stdout: ${preview(stdout)}`
        );
        reject(new Error((stderr || stdout || `exit ${code}`).trim()));
        return;
      }
      log(`✓ CLI 完成 (${ms}ms): ${cmd} → ${preview(stdout || stderr, 120)}`);
      resolve(stdout.trim());
    });
  });
}

function parseServiceUrl(text) {
  const line = text.split(/\r?\n/).find((l) => /^https?:\/\//.test(l.trim()));
  return line?.trim() || `http://${SERVE_HOST}:${DEFAULT_SERVE_PORT}`;
}

/** 检测端口是否可绑定（未被其它进程占用） */
function isPortAvailable(port, host = SERVE_HOST) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/** 向 OS 申请一个空闲端口 */
function findFreePort(host = SERVE_HOST) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** 优先使用 4096；若被占用则自动换端口 */
async function resolveServePort(log) {
  if (await isPortAvailable(DEFAULT_SERVE_PORT)) {
    return DEFAULT_SERVE_PORT;
  }
  const port = await findFreePort();
  log(`端口 ${DEFAULT_SERVE_PORT} 已被占用，改用 ${port} 启动新 serve 进程`);
  return port;
}

/** 端口已被占用时，尝试连接已有 OpenCode serve（避免重复启动失败） */
async function tryReuseExistingServe(port, password, options) {
  const log = options.log ?? (() => {});
  if (await isPortAvailable(port)) {
    return null;
  }

  const serveUrl = `http://${SERVE_HOST}:${port}`;
  log(`端口 ${port} 已有进程监听，探测 API 版本…`);

  const profile = await detectApiProfile(serveUrl, password, options.cwd, log);
  if (profile?.id === "v2") {
    log(`复用已有 OpenCode 2.0 serve: ${serveUrl}`);
    return {
      url: serveUrl,
      password: profile.password,
      apiProfile: profile,
      managedLifecycle: "none",
      proc: null,
    };
  }
  if (profile?.id === "standard") {
    log(`端口 ${port} 上是标准 opencode（非 lildax v2），无法复用`);
    return { incompatible: true, profile };
  }

  log(`端口 ${port} 上的服务不是 OpenCode API，将启动新进程`);
  return null;
}

function resolveServePassword(options) {
  return (
    options.env?.OPENCODE_SERVER_PASSWORD ??
    process.env.OPENCODE_SERVER_PASSWORD ??
    ""
  );
}

function isPortConflictOutput(text) {
  return /failed to start server on port/i.test(text);
}

function buildAuthHeader(password) {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

async function fetchHealthOnce(baseURL, healthPath, password, directory) {
  const url = new URL(`${baseURL}${healthPath}`);
  if (directory) {
    url.searchParams.set("directory", encodeURIComponent(directory));
  }
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: buildAuthHeader(password) } });
  } catch {
    return null;
  }
  const text = await res.text();
  if (!res.ok || text.trimStart().startsWith("<")) {
    return null;
  }
  try {
    const body = JSON.parse(text);
    return body?.healthy ? body : null;
  } catch {
    return null;
  }
}

/** 探测服务端 API 版本：v2 (lildax) 或 standard (opencode) */
async function detectApiProfile(baseURL, password, directory, log = () => {}) {
  for (const pw of [password, ""]) {
    if (await fetchHealthOnce(baseURL, API_V2.healthPath, pw, directory)) {
      if (pw !== password) log("OpenCode v2 API 使用空密码 auth");
      log(`检测到 OpenCode 2.0 API (${API_V2.healthPath})`);
      return { ...API_V2, password: pw };
    }
  }
  for (const pw of [password, ""]) {
    if (await fetchHealthOnce(baseURL, API_STANDARD.healthPath, pw, directory)) {
      log(`检测到标准 opencode API (${API_STANDARD.healthPath})`);
      return { ...API_STANDARD, password: pw };
    }
  }
  return null;
}

function incompatibleCliError(cli) {
  const err = new Error(
    `当前 PATH 上的「${cli}」是标准版 OpenCode CLI（API: /global/health），` +
    `与 HxxCode 所需的 OpenCode 2.0 预览版（lildax，API: /api/*）不兼容。\n\n` +
    `请安装官方 CLI 并确保存在 lildax 命令：\n` +
    `  npm install -g @opencode-ai/cli\n\n` +
    `若 4096 端口被旧 opencode 占用，请先结束残留进程：\n` +
    `  kill $(lsof -t -i :4096)\n\n` +
    `然后在 HxxCode 设置中选择「OpenCode CLI（官方 @opencode-ai/cli）」使用 lildax。`
  );
  err.code = "INCOMPATIBLE_CLI";
  return err;
}

function isIncompatibleCliError(err) {
  return err?.code === "INCOMPATIBLE_CLI";
}

async function assertV2ApiProfile(baseURL, password, directory, cli, log) {
  const profile = await detectApiProfile(baseURL, password, directory, log);
  if (!profile) {
    throw new Error(
      `无法连接 OpenCode 服务 (${baseURL})。请确认 serve 已启动且端口未被其它程序占用。`
    );
  }
  if (profile.id !== "v2") {
    throw incompatibleCliError(cli);
  }
  return profile;
}

// ── 工具：剥离 ANSI 转义序列 ──────────────────────────────────────────
function stripAnsi(text) {
  return text.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[()\[\]{}#%])/g, "").replace(/\x1B[PX^_]?.*?\x1B\\/g, "");
}

// ── 检测 CLI 是否有 service 子命令 ─────────────────────────────────────
async function hasServiceSubcommand(cli, options) {
  // lildax 是 OpenCode 2.0 官方 CLI，固定支持 service 子命令
  if (cli === "lildax") return true;
  try {
    // 查 `--help` 输出中是否有 "service" 命令条目（避免 `service --help`
    // 在 opencode v1.1.x 上 exit 0 但只输出通用帮助的误判）
    const help = stripAnsi(await runCli(cli, ["--help"], options));
    const lines = help.split("\n").map((l) => l.trim());
    const hasService = lines.some(
      (l) =>
        /^service(\s+\S|\s*$)/.test(l) ||
        new RegExp(`\\b${cli}\\s+service\\b`).test(l) ||
        /\bopencode\s+service\b/.test(l)
    );
    if (!hasService) return false;
    // 二次确认：实际执行 service --help
    await runCli(cli, ["service", "--help"], options);
    return true;
  } catch {
    return false;
  }
}

// ── 通过 `cli serve` 启动前台 server（opencode 模式） ──────────────────
async function startServeOnce(cli, port, password, options) {
  const log = options.log ?? (() => {});
  const serveUrl = `http://${SERVE_HOST}:${port}`;
  const serveEnv = { ...process.env, ...options.env };
  if (password && !serveEnv.OPENCODE_SERVER_PASSWORD) {
    serveEnv.OPENCODE_SERVER_PASSWORD = password;
  }

  const proc = spawn(
    cli,
    ["serve", "--port", String(port), "--hostname", SERVE_HOST],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: serveEnv,
      cwd: options.cwd,
      shell: process.platform === "win32",
      windowsHide: true,
    }
  );

  let procExited = false;
  let exitCode = null;
  let stderrBuf = "";
  proc.stderr?.on("data", (data) => {
    const text = data.toString();
    stderrBuf += text;
    options.onStderr?.(text);
  });
  proc.on("exit", (code) => {
    procExited = true;
    exitCode = code;
    log(`serve 进程退出 (exit=${code})`);
  });

  log(`serve URL: ${serveUrl}`);

  let healthOk = false;
  let activePassword = password;
  for (const pw of [password, ""]) {
    if (healthOk) break;
    try {
      await waitForHealth(serveUrl, { password: pw }, options.cwd, 10_000, log, {
        shouldAbort: () => procExited,
      });
      if (pw !== password) {
        activePassword = pw;
        log("使用空密码 auth 成功");
      }
      healthOk = true;
    } catch (err) {
      if (isIncompatibleCliError(err)) {
        proc.kill();
        return { ok: false, error: err, incompatible: true, procExited: true, serveUrl };
      }
      log(`health 检查失败 (password len=${pw.length}): ${err.message}`);
      if (procExited) break;
    }
  }

  if (!healthOk) {
    proc.kill();
    const portConflict = isPortConflictOutput(stderrBuf);
    return {
      ok: false,
      portConflict,
      procExited,
      exitCode,
      serveUrl,
      stderr: stderrBuf,
    };
  }

  let apiProfile;
  try {
    apiProfile = await assertV2ApiProfile(serveUrl, activePassword, options.cwd, cli, log);
  } catch (err) {
    proc.kill();
    return { ok: false, error: err, procExited: true, serveUrl };
  }

  return {
    ok: true,
    url: serveUrl,
    password: apiProfile.password,
    apiProfile,
    managedLifecycle: "serve",
    proc,
  };
}

async function ensureServeProcess(cli, options) {
  const log = options.log ?? (() => {});
  log("── ensureServeProcess (serve 模式) 开始 ──");

  const password = resolveServePassword(options);
  if (password) {
    log(`使用 OPENCODE_SERVER_PASSWORD (len=${password.length})`);
  }

  const reused = await tryReuseExistingServe(DEFAULT_SERVE_PORT, password, options);
  if (reused?.incompatible) {
    throw incompatibleCliError(cli);
  }
  if (reused) {
    log("── ensureServeProcess 完成（复用已有进程）──");
    return reused;
  }

  const MAX_PORT_ATTEMPTS = 3;
  let lastFailure = null;

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port =
      attempt === 0 ? await resolveServePort(log) : await findFreePort();
    if (attempt > 0) {
      log(`serve 端口重试 #${attempt + 1}: ${port}`);
    }

    const result = await startServeOnce(cli, port, password, options);
    if (result.ok) {
      log("── ensureServeProcess 完成 ──");
      return {
        url: result.url,
        password: result.password,
        apiProfile: result.apiProfile,
        managedLifecycle: result.managedLifecycle,
        proc: result.proc,
      };
    }

    lastFailure = result;
    if (result.error || result.incompatible) {
      throw result.error ?? incompatibleCliError(cli);
    }
    if (!result.portConflict || attempt >= MAX_PORT_ATTEMPTS - 1) {
      break;
    }
    log(`端口 ${port} 启动失败，尝试其它端口…`);
  }

  const hint =
    lastFailure?.portConflict
      ? `端口 ${DEFAULT_SERVE_PORT} 可能被其它程序占用。\n` +
        `可先结束残留进程：kill $(lsof -t -i :${DEFAULT_SERVE_PORT})，或设置 OPENCODE_SERVER_PASSWORD 后重试。`
      : `请检查供应商配置是否正确，或运行 \`${cli} serve\` 手动排查。`;

  throw new Error(
    `OpenCode serve 启动后健康检查未通过（进程状态：${lastFailure?.procExited ? "已退出" : "运行中"}）。\n` +
      hint
  );
}

// ── 通过 `cli service status/start/password` 管理后台 service（lildax 模式） ──
async function ensureServiceViaSubcommand(cli, options) {
  const log = options.log ?? (() => {});
  log("── ensureServiceViaSubcommand (service 模式) 开始 ──");

  const status = await runCli(cli, ["service", "status"], options).catch(
    () => "stopped"
  );
  log(`service status: ${preview(status, 80)}`);

  let managedLifecycle = "none";

  if (/running/i.test(status)) {
    if (options.restartService) {
      log("service 已在运行，执行 restart（注入 env / 刷新配置）");
      await runCli(cli, ["service", "restart"], options);
      managedLifecycle = "restarted";
    } else {
      log("service 已在运行，复用现有进程（跳过重启）");
      const url = parseServiceUrl(status);
      const password = (await runCli(cli, ["service", "password"], options))
        .split(/\r?\n/)
        .pop()
        .trim();
      if (!password) {
        throw new Error("无法获取 OpenCode service 密码");
      }
      const profile = await detectApiProfile(url, password, options.cwd, log);
      if (profile?.id === "v2") {
        log("── ensureServiceViaSubcommand 完成（复用）──");
        return { url, password: profile.password, apiProfile: profile, managedLifecycle: "none" };
      }
      log("已有 service 健康检查未通过，尝试 restart…");
      await runCli(cli, ["service", "restart"], options);
      managedLifecycle = "restarted";
    }
  } else {
    log("service 未运行，执行 start");
    await runCli(cli, ["service", "start"], options);
    managedLifecycle = "started";
  }

  const latestStatus = await runCli(cli, ["service", "status"], options).catch(
    () => status
  );
  const url = parseServiceUrl(latestStatus);
  log(`service URL: ${url}, lifecycle=${managedLifecycle}`);

  const password = (await runCli(cli, ["service", "password"], options))
    .split(/\r?\n/)
    .pop()
    .trim();

  if (!password) {
    throw new Error("无法获取 OpenCode service 密码");
  }
  log(`service password 已获取 (len=${password.length})`);

  if (managedLifecycle !== "none") {
    log("等待 service health 就绪…");
    await waitForHealth(url, { password }, options.cwd, 15_000, log);
  }

  log("── ensureServiceViaSubcommand 完成 ──");
  const apiProfile = { ...API_V2, password };
  return { url, password, apiProfile, managedLifecycle };
}

/** 根据 CLI 能力自动选择 service 或 serve 模式 */
async function ensureService(cli, options) {
  const log = options.log ?? (() => {});
  log("── ensureService 开始 ──");

  const hasService = await hasServiceSubcommand(cli, options);
  if (hasService) {
    log("CLI 支持 service 子命令 → 使用 service 模式 (lildax)");
    return ensureServiceViaSubcommand(cli, options);
  } else {
    log("CLI 不支持 service 子命令 → 使用 serve 模式 (opencode)");
    return ensureServeProcess(cli, options);
  }
}

async function waitForHealth(
  baseURL,
  auth,
  directory,
  timeoutMs = 15_000,
  log = () => {},
  opts = {}
) {
  const start = Date.now();
  let attempts = 0;

  while (Date.now() - start < timeoutMs) {
    if (opts.shouldAbort?.()) {
      throw new Error("serve 进程已退出");
    }
    attempts++;

    const profile = await detectApiProfile(baseURL, auth.password, directory);
    if (profile?.id === "v2") {
      log(`health 就绪 (${Date.now() - start}ms, attempts=${attempts}, ${API_V2.healthPath})`);
      opts.detectedProfile = profile;
      return profile;
    }
    if (profile?.id === "standard") {
      throw incompatibleCliError("opencode");
    }

    if (attempts <= 3 || attempts % 5 === 0) {
      log(`health 尝试 #${attempts}: 未收到 v2 API 响应`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("OpenCode service 重启后未能就绪");
}

const TERMINAL_SESSION_EVENTS = new Set([
  "session.next.step.failed",
]);

function isFinalStepEnded(ev) {
  if (ev?.type !== "session.next.step.ended") return false;
  const finish = ev?.data?.finish;
  return finish === "stop" || finish === "end_turn" || finish === "stop-sequence";
}

function isStreamTerminationError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  const msg = String(err.message ?? err);
  return (
    msg === "terminated" ||
    msg.includes("terminated") ||
    msg.includes("aborted") ||
    msg.includes("The operation was aborted")
  );
}

function matchesPromptMessage(ev, messageId) {
  if (!messageId) return true;
  return ev?.data?.messageID === messageId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 /message 列表取「本次 prompt 之后」最新完成的 assistant 文本 */
async function fetchLatestAssistantText(
  api,
  sessionId,
  signal,
  { afterMessageId = null, afterMs = 0 } = {}
) {
  const res = await api(`/session/${sessionId}/message`, { signal });
  if (!res.ok) return null;
  const json = await res.json().catch(() => ({}));
  const messages = json?.data ?? json;
  if (!Array.isArray(messages)) return null;

  let minIndex = 0;
  if (afterMessageId) {
    const idx = messages.findIndex((m) => m?.id === afterMessageId);
    if (idx >= 0) minIndex = idx + 1;
  }

  for (let i = messages.length - 1; i >= minIndex; i--) {
    const msg = messages[i];
    if (msg?.type !== "assistant") continue;
    if (!msg.time?.completed && msg.finish == null) continue;
    const created = Number(msg.time?.created ?? 0);
    // 必须是本次 prompt 之后创建的 assistant，避免把上一轮结果当成新回复
    if (afterMs && created && created < afterMs) continue;
    const texts = (msg.content ?? [])
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text);
    const text = texts.join("\n").trim();
    if (text) {
      return {
        text,
        messageId: msg.id,
        finish: msg.finish ?? "stop",
        created,
      };
    }
  }
  return null;
}

/** SSE 不可用时，轮询消息直到「本次」assistant 完成 */
async function* pollSessionMessagesAsEvents({
  api,
  sessionId,
  signal,
  log,
  messageId,
  afterMs = 0,
  timeoutMs = 90_000,
}) {
  const t0 = Date.now();
  log(
    `开始轮询 /session/${sessionId}/message … afterMessageId=${messageId ?? "?"} afterMs=${afterMs}`
  );
  while (!signal?.aborted) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        "轮询消息超时：Agent 未在限时内产出结果。请重启 HxxCode Server 后新建会话。"
      );
    }
    try {
      const hit = await fetchLatestAssistantText(api, sessionId, signal, {
        afterMessageId: messageId,
        afterMs,
      });
      if (hit) {
        log(
          `轮询命中本次 assistant 文本 len=${hit.text.length} messageID=${hit.messageId ?? "?"}`
        );
        yield {
          type: "session.next.step.started",
          data: { sessionID: sessionId, assistantMessageID: hit.messageId },
        };
        // 只发一次完整文本（delta），避免再发 text.ended 造成重复
        yield {
          type: "session.next.text.delta",
          data: { sessionID: sessionId, delta: hit.text },
        };
        yield {
          type: "session.next.step.ended",
          data: {
            sessionID: sessionId,
            finish: hit.finish || "stop",
            assistantMessageID: hit.messageId,
          },
        };
        return;
      }
    } catch (err) {
      if (isStreamTerminationError(err) || signal?.aborted) return;
      log(`轮询消息出错: ${err.message}`);
    }
    await sleep(1000);
  }
}

/**
 * SSE 与消息轮询并行。
 * 复杂识图时常出现：SSE 在 text.started 后提前断开，Agent 仍在跑 —— 此时必须继续轮询 /message。
 */
async function* mergeSseWithMessagePoll(sseIter, pollOpts) {
  const {
    api,
    sessionId,
    signal,
    log,
    messageId,
    afterMs = 0,
    pollTimeoutMs = 180_000,
  } = pollOpts;
  const iter = sseIter[Symbol.asyncIterator]();
  let stopped = false;
  let sseFinishedClean = false;
  /** 是否已收到带正文的 delta/ended（text.started 不算） */
  let sawSseTextBody = false;
  let pollHit = null;

  const pollLoop = (async () => {
    await sleep(2000);
    while (!stopped && !signal?.aborted) {
      try {
        const hit = await fetchLatestAssistantText(api, sessionId, signal, {
          afterMessageId: messageId,
          afterMs,
        });
        if (hit) {
          pollHit = hit;
          log(
            `并行轮询命中本次结果 len=${hit.text.length} messageID=${hit.messageId ?? "?"}`
          );
          try {
            await iter.return?.();
          } catch {
            // ignore
          }
          return;
        }
      } catch {
        // ignore transient
      }
      await sleep(1500);
    }
  })();

  try {
    while (!stopped && !signal?.aborted) {
      const next = await iter.next();
      if (pollHit) break;
      if (next.done) {
        log(
          `SSE 流结束 (clean=${sseFinishedClean}, sawTextBody=${sawSseTextBody}, pollHit=${!!pollHit})`
        );
        break;
      }
      const t = next.value?.type;
      if (t === "session.next.text.delta") {
        const delta = next.value?.data?.delta ?? next.value?.data?.text;
        if (typeof delta === "string" && delta.length > 0) sawSseTextBody = true;
      }
      if (t === "session.next.text.ended") {
        const text = next.value?.data?.text;
        if (typeof text === "string" && text.trim()) sawSseTextBody = true;
      }
      yield next.value;
      if (t === "session.next.step.failed" || isFinalStepEnded(next.value)) {
        sseFinishedClean = true;
        stopped = true;
        break;
      }
    }
  } finally {
    // 仅在已有正文或干净结束时停掉并行轮询；否则留给后面的续轮询
    if (sseFinishedClean || sawSseTextBody || pollHit) {
      stopped = true;
    }
    await pollLoop.catch(() => {});
  }

  if (signal?.aborted) return;

  if (pollHit && !sawSseTextBody) {
    log(`使用并行轮询结果作为正文 len=${pollHit.text.length}`);
    yield {
      type: "session.next.text.delta",
      data: { sessionID: sessionId, delta: pollHit.text },
    };
    yield {
      type: "session.next.step.ended",
      data: {
        sessionID: sessionId,
        finish: pollHit.finish || "stop",
        assistantMessageID: pollHit.messageId,
      },
    };
    return;
  }

  if (sseFinishedClean || sawSseTextBody) {
    return;
  }

  // SSE 提前断开且没有正文：继续轮询（复杂图片 / 长思考）
  log(
    `SSE 提前结束且无正文，继续轮询 /message（最长 ${Math.round(pollTimeoutMs / 1000)}s）…`
  );
  yield* pollSessionMessagesAsEvents({
    api,
    sessionId,
    signal,
    log,
    messageId,
    afterMs,
    timeoutMs: pollTimeoutMs,
  });
}

async function* parseSessionEventsWithPermissions(
  response,
  signal,
  log,
  idleTimeoutMs,
  promptFilter,
  permissionContext
) {
  const handled = new Set();
  let polling = true;

  const pollPermissions = async () => {
    if (!permissionContext?.onPermission) return;
    while (polling && !signal?.aborted) {
      try {
        const pending = await permissionContext.listPermissions();
        for (const req of pending) {
          const id = req?.id;
          if (!id || handled.has(id)) continue;
          handled.add(id);
          log(
            `权限待确认: action=${req.action} resources=${preview(JSON.stringify(req.resources ?? []), 120)}`
          );
          const reply = await permissionContext.onPermission(req);
          await permissionContext.replyPermission(id, reply);
          log(`权限已回复: ${reply} (requestID=${id})`);
        }
      } catch (err) {
        log(`权限轮询错误: ${err.message}`);
      }
      await sleep(400);
    }
  };

  const pollTask = pollPermissions();
  try {
    yield* parseSessionEvents(response, signal, log, idleTimeoutMs, promptFilter);
  } finally {
    polling = false;
    await pollTask.catch(() => {});
  }
}

async function* parseSessionEvents(
  response,
  signal,
  log = () => {},
  idleTimeoutMs = 120_000,
  promptFilter = null
) {
  const iter = parseSSE(response, signal, log)[Symbol.asyncIterator]();
  let eventCount = 0;
  let yieldedCount = 0;
  /** 绝对截止时间，避免 SSE 心跳不断刷新等待导致永不超时 */
  let deadlineAt = Date.now() + Math.min(idleTimeoutMs, 45_000);
  let waitingAgentStart = false;
  const agentStartTimeoutMs = 30_000;
  const targetMessageId = promptFilter?.messageId ?? null;
  let active = !targetMessageId;
  log(
    targetMessageId
      ? `SSE 事件流已连接，等待 prompt messageID=${targetMessageId}…`
      : "SSE 事件流已连接，等待事件…"
  );

  try {
    while (true) {
      let timer;
      let next;
      const waitStart = Date.now();
      const waitLimitMs = Math.max(500, deadlineAt - Date.now());
      try {
        next = await Promise.race([
          iter.next(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              if (waitingAgentStart) {
                reject(
                  new Error(
                    "模型未响应：agent 在 30s 内未启动。OpenCode 后端可能已卡住，请执行「HxxCode: 启动 / 重启 Server」后新建会话重试。"
                  )
                );
              } else {
                reject(
                  new Error(
                    "等待 OpenCode 响应超时。后端可能已卡住，请执行「HxxCode: 启动 / 重启 Server」后新建会话重试。"
                  )
                );
              }
            }, waitLimitMs);
          }),
        ]).finally(() => clearTimeout(timer));
      } catch (err) {
        if (isStreamTerminationError(err)) {
          log(`SSE 流结束 (cleanup): ${err.message}`);
          return;
        }
        log(`✗ SSE 等待超时/错误 (已收 ${eventCount} 事件, ${Date.now() - waitStart}ms): ${err.message}`);
        throw err;
      }

      if (next.done) {
        log(`SSE 迭代结束 (共 ${eventCount} 事件)`);
        return;
      }

      eventCount++;
      const ev = next.value;
      const evType = ev?.type ?? "unknown";

      if (!active) {
        if (evType === "session.next.prompted" && matchesPromptMessage(ev, targetMessageId)) {
          active = true;
          waitingAgentStart = true;
          deadlineAt = Date.now() + agentStartTimeoutMs;
          log(`SSE 锁定当前 prompt messageID=${targetMessageId} (+${Date.now() - waitStart}ms)`);
        } else {
          log(`← SSE #${eventCount} ${evType} (跳过历史 replay)`);
          continue;
        }
      }

      log(`← SSE #${eventCount} ${evType} (+${Date.now() - waitStart}ms)`);
      if (evType === "session.next.prompted") {
        waitingAgentStart = true;
        deadlineAt = Date.now() + agentStartTimeoutMs;
      }
      if (evType === "session.next.step.started") {
        waitingAgentStart = false;
        // 生成过程中允许更长空闲（但不会因心跳无限延长）
        deadlineAt = Date.now() + idleTimeoutMs;
      }
      if (
        evType === "session.next.text.delta" ||
        evType === "session.next.text.started" ||
        evType === "session.next.reasoning.started" ||
        evType === "session.next.tool.called"
      ) {
        waitingAgentStart = false;
        deadlineAt = Date.now() + idleTimeoutMs;
      }
      if (evType === "session.next.text.ended") {
        const text = ev?.data?.text;
        log(`  text.ended len=${typeof text === "string" ? text.length : 0}`);
      }
      if (evType === "session.next.step.failed") {
        log(`  step.failed: ${preview(JSON.stringify(ev?.data))}`);
      }

      yield ev;
      yieldedCount++;
      if (TERMINAL_SESSION_EVENTS.has(evType)) {
        log(`SSE 收到终止事件 ${evType}，关闭流 (yielded ${yieldedCount} 事件)`);
        return;
      }
      if (isFinalStepEnded(ev)) {
        log(`SSE 收到最终 step.ended (finish=${ev?.data?.finish})，关闭流 (yielded ${yieldedCount} 事件)`);
        return;
      }
      if (evType === "session.next.step.ended") {
        log(`SSE step.ended finish=${ev?.data?.finish ?? "?"}，继续等待后续步骤…`);
        deadlineAt = Date.now() + idleTimeoutMs;
      }
    }
  } finally {
    try {
      await response.body?.cancel?.();
    } catch {
      // ignore
    }
    try {
      await iter.return?.();
    } catch {
      // ignore
    }
  }
}

async function* parseSSE(response, signal, log = () => {}) {
  if (!response.body) throw new Error("响应体为空");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      let done;
      let value;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        if (signal?.aborted || isStreamTerminationError(err)) break;
        throw err;
      }
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data);
          } catch {
            continue;
          }
        } else {
          try {
            yield JSON.parse(trimmed);
          } catch {
            continue;
          }
        }
      }
    }
  } finally {
    try {
      await reader.cancel?.();
    } catch {
      // ignore
    }
    reader.releaseLock();
  }
}

function createHttpClient(baseURL, auth, directory, log = () => {}, onPermission = null, apiPrefix = "/api") {
  const encodedDir = directory ? encodeURIComponent(directory) : undefined;
  const authHeader = buildAuthHeader(auth.password);
  const healthPath = apiPrefix === "/api" ? API_V2.healthPath : API_STANDARD.healthPath;

  const api = async (path, init = {}) => {
    const url = new URL(`${baseURL}${apiPrefix}${path}`);
    if (encodedDir) {
      url.searchParams.set("directory", encodedDir);
      url.searchParams.set("location[directory]", encodedDir);
    }
    const method = init.method ?? "GET";
    const t0 = Date.now();
    log(`→ HTTP ${method} ${path}${init.body ? ` body=${preview(init.body, 120)}` : ""}`);

    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...init.headers,
        },
      });
    } catch (err) {
      log(`✗ HTTP ${method} ${path} 网络错误 (${Date.now() - t0}ms): ${err.message}`);
      throw err;
    }

    const ms = Date.now() - t0;
    if (!res.ok) {
      log(`✗ HTTP ${method} ${path} → ${res.status} (${ms}ms)`);
    } else {
      log(`✓ HTTP ${method} ${path} → ${res.status} (${ms}ms)`);
    }
    return res;
  };

  return {
    global: {
      async health() {
        const res = await fetch(new URL(`${baseURL}${healthPath}`), {
          headers: { Authorization: authHeader },
        });
        if (!res.ok) {
          throw new Error(
            `健康检查失败 (${res.status}): ${await res.text()}`
          );
        }
        const text = await res.text();
        if (text.trimStart().startsWith("<")) {
          throw new Error(
            `健康检查收到 HTML 而非 JSON，请确认使用的是 lildax (OpenCode 2.0) 而非标准 opencode CLI`
          );
        }
        const body = JSON.parse(text);
        return { data: { healthy: body.healthy ?? false } };
      },
    },
    session: {
      async create({ body }) {
        const payload = {};
        if (body.model) {
          const [providerID, ...rest] = body.model.split("/");
          payload.model = { providerID, id: rest.join("/") };
        }
        log(`创建 session: ${JSON.stringify(payload)}`);
        const res = await api("/session", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          throw new Error(
            `创建 session 失败 (${res.status}): ${await res.text()}`
          );
        }
        const json = await res.json();
        const data = json.data ?? json;
        log(`session 已创建: id=${data?.id}`);
        return { data };
      },
      async get(sessionId) {
        log(`查询 session: ${sessionId}`);
        const res = await api(`/session/${sessionId}`);
        if (res.status === 404) {
          log(`session 不存在: ${sessionId}`);
          return { data: null };
        }
        if (!res.ok) {
          throw new Error(
            `获取 session 失败 (${res.status}): ${await res.text()}`
          );
        }
        const json = await res.json();
        return { data: json.data ?? json };
      },
      async listMessages(sessionId) {
        log(`拉取 session 消息: ${sessionId}`);
        const res = await api(`/session/${sessionId}/message`);
        if (!res.ok) {
          throw new Error(
            `拉取消息失败 (${res.status}): ${await res.text()}`
          );
        }
        const json = await res.json();
        const data = json.data ?? json;
        return { data: Array.isArray(data) ? data : [] };
      },
      async switchModel(sessionId, modelRef) {
        const res = await api(`/session/${sessionId}/model`, {
          method: "POST",
          body: JSON.stringify({ model: modelRef }),
        });
        if (!res.ok) {
          throw new Error(
            `切换模型失败 (${res.status}): ${await res.text()}`
          );
        }
      },
      prompt(options) {
        const { id } = options.path;
        const abortController = new AbortController();
        const externalSignal = options.signal;
        if (externalSignal) {
          if (externalSignal.aborted) {
            abortController.abort();
          } else {
            externalSignal.addEventListener(
              "abort",
              () => abortController.abort(),
              { once: true }
            );
          }
        }
        const modelRef = parseModelRef(options.body?.model);
        const fetchSignal = abortController.signal;

        return {
          [Symbol.asyncIterator]() {
            let generator = null;
            let started = false;
            let completed = false;

            const start = async () => {
              if (fetchSignal.aborted) {
                throw new DOMException("The operation was aborted", "AbortError");
              }
              log(`── prompt 流程开始 session=${id} ──`);
              if (modelRef) {
                log(`切换模型: ${JSON.stringify(modelRef)}`);
                const modelRes = await api(`/session/${id}/model`, {
                  method: "POST",
                  body: JSON.stringify({ model: modelRef }),
                  signal: fetchSignal,
                });
                if (!modelRes.ok) {
                  throw new Error(
                    `切换模型失败 (${modelRes.status}): ${await modelRes.text()}`
                  );
                }
              }

              const parts = Array.isArray(options.body?.parts)
                ? options.body.parts
                : [];
              const text =
                parts
                  .filter((p) => p.type === "text" && typeof p.text === "string")
                  .map((p) => p.text)
                  .join("\n\n") ||
                options.body?.text ||
                "";
              // OpenCode 2.0 PromptInput: { text, files?: [{ uri, name?, description? }] }
              // （不是标准 SDK 的 parts[{type:file,url,mime}]）
              const files = parts
                .filter(
                  (p) =>
                    p.type === "file" &&
                    typeof (p.url || p.uri) === "string"
                )
                .map((p) => {
                  const uri = p.url || p.uri;
                  const file = { uri };
                  if (p.filename || p.name) file.name = p.filename || p.name;
                  if (p.mime) file.description = p.mime;
                  return file;
                });
              log(
                `发送 prompt (${text.length} chars, files=${files.length}): ${preview(text, 80)}`
              );

              const promptPayload =
                files.length > 0 ? { text, files } : { text };

              // 必须先提交 prompt 再连 SSE。
              // 部分 OpenCode 版本在 GET /event 时要等首个事件才返回响应头；
              // 若先挂起 SSE、再 POST prompt，会形成死锁（日志停在 → HTTP GET …/event）。
              log(`提交 prompt…`);
              const promptRes = await api(`/session/${id}/prompt`, {
                method: "POST",
                body: JSON.stringify({ prompt: promptPayload }),
                signal: fetchSignal,
              });
              if (!promptRes.ok) {
                throw new Error(
                  `prompt 失败 (${promptRes.status}): ${await promptRes.text()}`
                );
              }
              const promptBody = await promptRes.json().catch(() => ({}));
              const promptData = promptBody?.data ?? promptBody;
              const promptMessageId = promptData?.id ?? null;
              const promptAfterMs = Number(
                promptData?.timeCreated ?? promptData?.time?.created ?? Date.now()
              );
              log(
                `prompt 已提交: messageID=${promptMessageId ?? "?"} seq=${promptData?.admittedSeq ?? "?"} afterMs=${promptAfterMs} ${preview(JSON.stringify(promptBody))}`
              );

              log(`连接 SSE: ${apiPrefix}/session/${id}/event`);
              let eventRes;
              try {
                const sseHeaderTimeout = AbortSignal.timeout(8_000);
                const sseSignal =
                  typeof AbortSignal.any === "function"
                    ? AbortSignal.any([fetchSignal, sseHeaderTimeout])
                    : fetchSignal;
                eventRes = await api(`/session/${id}/event`, {
                  signal: sseSignal,
                  headers: { Accept: "text/event-stream" },
                });
              } catch (err) {
                if (
                  fetchSignal.aborted ||
                  !(
                    err?.name === "TimeoutError" ||
                    /aborted|timeout/i.test(String(err?.message ?? err))
                  )
                ) {
                  throw err;
                }
                log(
                  `SSE 响应头超时（8s），改为轮询 /message 兜底 messageID=${promptMessageId ?? "?"}`
                );
                return pollSessionMessagesAsEvents({
                  api,
                  sessionId: id,
                  signal: fetchSignal,
                  log,
                  messageId: promptMessageId,
                  afterMs: promptAfterMs,
                });
              }
              if (!eventRes.ok) {
                throw new Error(
                  `事件流失败 (${eventRes.status}): ${await eventRes.text()}`
                );
              }
              log(`SSE 已连通，开始读事件…`);

              // 与 SSE 并行：若 Agent 已跑完但事件丢失，用消息接口补齐（仅接受本次 prompt 之后的回复）
              return mergeSseWithMessagePoll(
                parseSessionEventsWithPermissions(
                  eventRes,
                  fetchSignal,
                  log,
                  120_000,
                  {
                    messageId: promptMessageId,
                    admittedSeq: promptData?.admittedSeq,
                  },
                  onPermission
                    ? {
                        listPermissions: async () => {
                          const res = await api(`/session/${id}/permission`, {
                            signal: fetchSignal,
                          });
                          if (!res.ok) return [];
                          const json = await res.json().catch(() => ({}));
                          return json?.data ?? json ?? [];
                        },
                        replyPermission: async (requestId, reply) => {
                          const res = await api(
                            `/session/${id}/permission/${requestId}/reply`,
                            {
                              method: "POST",
                              body: JSON.stringify({ reply }),
                              signal: fetchSignal,
                            }
                          );
                          if (!res.ok) {
                            throw new Error(
                              `权限回复失败 (${res.status}): ${await res.text()}`
                            );
                          }
                        },
                        onPermission,
                      }
                    : null
                ),
                {
                  api,
                  sessionId: id,
                  signal: fetchSignal,
                  log,
                  messageId: promptMessageId,
                  afterMs: promptAfterMs,
                }
              );
            };

            return {
              async next() {
                if (fetchSignal.aborted) {
                  completed = true;
                  return { done: true, value: undefined };
                }
                if (!started) {
                  generator = await start();
                  started = true;
                }
                const result = await generator.next();
                if (result.done) completed = true;
                return result;
              },
              async return() {
                if (!completed) {
                  abortController.abort();
                }
                try {
                  if (generator) await generator.return(undefined);
                } catch {
                  // ignore
                }
                completed = true;
                log(`── prompt 流程结束 session=${id} ──`);
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    },
  };
}

function parseModelRef(model) {
  if (!model || typeof model !== "string") return null;
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

export async function createOpencode(options) {
  const { config, env, onStderr, onLog, onPermission, cli: cliOverride, cliPackage } = options;
  const log = createLogger(onLog);
  const directory = config?.cwd;
  const timeoutMs = options.timeout ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const timeoutSec = timeoutMs / 1000;

  log("══ createOpencode 开始 ══");
  log(`workspace: ${directory ?? "(none)"}`);
  log(`agent cli: ${cliOverride ?? "(auto)"}`);
  log(`env keys: ${env ? (Object.keys(env).filter((k) => k.startsWith("OPENCODE_BRIDGE_")).join(", ") || "(none)") : "(none)"}`);

  const cli = await resolveCli(log, cliOverride, cliPackage);
  if (!cli) {
    throw new Error(
      "未找到 opencode / lildax CLI。\n\n" +
        "HxxCode 需要 OpenCode CLI 来提供 AI 编程助手能力。\n" +
        "请确保已安装并在 PATH 上：npm install -g @opencode-ai/cli\n\n" +
        "也可在 ~/.hxxcode/config.json 的 agentBackend 中指定其它 CLI。"
    );
  }

  const runOpts = {
    cwd: directory,
    env,
    onStderr,
    log,
    restartService: options.restartService ?? false,
  };
  let managedLifecycle = "none";
  /** serve 模式下的子进程引用，用于关闭 */
  let serveProc = null;

  const client = await withTimeout(
    (async () => {
      const service = await ensureService(cli, runOpts);
      managedLifecycle = service.managedLifecycle;
      if (service.proc) serveProc = service.proc;

      const apiPrefix = service.apiProfile?.prefix ?? "/api";
      const httpClient = createHttpClient(
        service.url,
        { password: service.password },
        directory,
        log,
        onPermission ?? null,
        apiPrefix
      );

      log("执行 health 检查…");
      await httpClient.global.health().catch((err) => {
        throw new Error(
          `OpenCode service 已启动但 API 不可用：${err.message}\n` +
            `Service URL: ${service.url}`
        );
      });
      log("health 检查通过");

      return httpClient;
    })(),
    timeoutMs,
    `OpenCode service 启动超时（${timeoutSec}s）`
  ).catch(async (err) => {
    log(`✗ createOpencode 失败: ${err.message}`);
    if (managedLifecycle === "started") {
      await runCli(cli, ["service", "stop"], runOpts).catch(() => {});
    }
    if (serveProc) {
      serveProc.kill();
      serveProc = null;
    }
    throw err;
  });

  log("══ createOpencode 完成 ══");
  return {
    server: {
      async close() {
        // serve 模式：直接 kill 子进程
        if (serveProc) {
          log("关闭 serve 进程…");
          serveProc.kill();
          serveProc = null;
          return;
        }
        // service 模式：通过 CLI 停止
        if (managedLifecycle === "started") {
          log("关闭 service (extension 冷启动)…");
          await runCli(cli, ["service", "stop"], runOpts).catch(() => {});
        }
      },
    },
    client,
  };
}

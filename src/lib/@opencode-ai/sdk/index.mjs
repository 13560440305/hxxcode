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

/** 兼容多种 OpenCode / lildax 权限列表响应形状 */
function extractPermissionList(json) {
  const raw = json?.data ?? json;
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  for (const key of ["permissions", "requests", "items", "pending"]) {
    if (Array.isArray(raw[key])) return raw[key];
  }
  // id → request 的 map
  const vals = Object.values(raw);
  if (
    vals.length > 0 &&
    vals.every(
      (v) =>
        v &&
        typeof v === "object" &&
        (v.id || v.requestID || v.permission || v.action || v.type)
    )
  ) {
    return vals;
  }
  if (raw.id || raw.requestID || raw.permissionID) return [raw];
  return [];
}

/** 本轮是否真正结束（tool-calls 只是中间步，不算完） */
function isAssistantTurnComplete(msg) {
  if (!msg) return false;
  const finish = msg.finish ?? null;
  if (finish === "tool-calls" || finish === "tool_calls") return false;
  if (
    finish === "stop" ||
    finish === "end_turn" ||
    finish === "stop-sequence" ||
    finish === "error" ||
    finish === "length" ||
    finish === "cancelled" ||
    finish === "canceled"
  ) {
    return true;
  }
  // 有 completed 时间且无中间 finish
  if (msg._completed && finish == null) return true;
  if (msg.time?.completed && finish == null) return true;
  return false;
}

/** 判断消息数组是否新→旧（lildax 常见） */
function isMessagesNewestFirst(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return true;
  const a = Number(messages[0]?.time?.created ?? 0);
  const b = Number(messages[messages.length - 1]?.time?.created ?? 0);
  if (a && b) return a >= b;
  return true;
}

/** 统一成 { id, action, resources, sessionID } */
function normalizePermissionRequest(req) {
  if (!req || typeof req !== "object") return null;
  const id = req.id ?? req.requestID ?? req.permissionID ?? null;
  if (!id) return null;
  const action =
    req.action ?? req.permission ?? req.type ?? req.name ?? "unknown";
  let resources = req.resources ?? req.patterns ?? null;
  if (!resources && req.pattern) resources = [req.pattern];
  if (!resources && req.resource) resources = [req.resource];
  if (!Array.isArray(resources)) resources = resources ? [String(resources)] : [];
  return {
    ...req,
    id: String(id),
    action: String(action),
    resources: resources.map(String),
    sessionID: req.sessionID ?? req.sessionId ?? req.session_id,
  };
}

function isPermissionEvent(ev) {
  const t = String(ev?.type ?? "");
  return (
    t === "permission.asked" ||
    t === "permission.updated" ||
    t === "permission.requested" ||
    t === "session.permission.asked" ||
    t === "session.next.permission.asked" ||
    /permission\.(asked|updated|requested)/i.test(t)
  );
}

function permissionFromEvent(ev) {
  const data = ev?.data ?? ev?.properties ?? ev;
  return normalizePermissionRequest(data);
}

/** 兼容 flat / {info,parts} 两种消息列表 */
function normalizeMessageList(json) {
  const raw = json?.data ?? json;
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.messages)
      ? raw.messages
      : Array.isArray(raw?.items)
        ? raw.items
        : [];
  return arr.map((m) => {
    if (!m || typeof m !== "object") return null;
    if (m.info || m.parts) {
      const info = m.info ?? m;
      const parts = Array.isArray(m.parts)
        ? m.parts
        : Array.isArray(m.content)
          ? m.content
          : [];
      const role = info.role ?? info.type ?? m.role ?? m.type;
      const texts = parts
        .filter((p) => p && (p.type === "text" || typeof p.text === "string"))
        .map((p) => p.text)
        .filter((t) => typeof t === "string");
      return {
        id: info.id ?? m.id,
        type: role === "assistant" || role === "Assistant" ? "assistant" : role,
        finish: info.finish ?? m.finish ?? info.time?.finish,
        time: info.time ?? m.time ?? {},
        content: parts,
        _text: texts.join("\n").trim(),
        _completed: !!(
          info.time?.completed ||
          m.time?.completed ||
          info.finish != null ||
          m.finish != null ||
          info.status === "completed" ||
          m.completed === true
        ),
      };
    }
    const role = m.type ?? m.role;
    const content = Array.isArray(m.content)
      ? m.content
      : Array.isArray(m.parts)
        ? m.parts
        : [];
    const texts = content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text);
    return {
      id: m.id,
      type: role === "assistant" || role === "Assistant" ? "assistant" : role,
      finish: m.finish,
      time: m.time ?? {},
      content,
      _text: texts.join("\n").trim(),
      _completed: !!(
        m.time?.completed ||
        m.finish != null ||
        m.status === "completed" ||
        m.completed === true
      ),
    };
  }).filter(Boolean);
}

/** 从 /message 列表取「本次 prompt 之后」最新 assistant（优先已完成；否则返回进行中的正文用于软恢复） */
async function fetchLatestAssistantText(
  api,
  sessionId,
  signal,
  { afterMessageId = null, afterMs = 0, allowIncomplete = false } = {}
) {
  const res = await api(`/session/${sessionId}/message`, { signal });
  if (!res.ok) return null;
  const json = await res.json().catch(() => ({}));
  const messages = normalizeMessageList(json);
  if (!messages.length) return null;

  const newestFirst = isMessagesNewestFirst(messages);
  const promptIdx = afterMessageId
    ? messages.findIndex((m) => m?.id === afterMessageId)
    : -1;

  const isAfterPrompt = (idx, created) => {
    if (afterMs && created && created < afterMs) return false;
    if (promptIdx < 0) return true;
    // 新→旧：prompt 之后的消息下标更小；旧→新：下标更大
    if (newestFirst) return idx < promptIdx;
    return idx > promptIdx;
  };

  let incompleteHit = null;
  // 始终从「最新」往旧扫，避免先命中中间的 tool-calls 就误判结束
  const order = newestFirst
    ? messages.map((m, i) => i)
    : messages.map((m, i) => i).reverse();

  for (const i of order) {
    const msg = messages[i];
    if (msg?.type !== "assistant") continue;
    const created = Number(msg.time?.created ?? 0);
    if (!isAfterPrompt(i, created)) continue;

    const text =
      msg._text ||
      (msg.content ?? [])
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
        .trim();

    if (isAssistantTurnComplete(msg)) {
      return {
        text: text || "",
        messageId: msg.id,
        finish: msg.finish ?? "stop",
        created,
        completed: true,
      };
    }
    if (allowIncomplete && !incompleteHit) {
      incompleteHit = {
        text: text || "",
        messageId: msg.id,
        finish: msg.finish || "stop",
        created,
        completed: false,
      };
    }
  }
  return incompleteHit;
}

/**
 * POST /session/{id}/wait — 等到 agent loop idle（OpenAPI: 204）。
 * 用作完成/取消确认的双保险通道。
 */
async function waitForSessionIdle(api, sessionId, signal, log, timeoutMs = 600_000) {
  const timeoutSignal =
    typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : null;
  const waitSignal =
    timeoutSignal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeoutSignal].filter(Boolean))
      : signal;
  log(`POST /session/${sessionId}/wait（timeout=${Math.round(timeoutMs / 1000)}s）…`);
  const res = await api(`/session/${sessionId}/wait`, {
    method: "POST",
    signal: waitSignal,
  });
  if (res.status === 204 || res.ok) {
    log(`wait 确认 idle: status=${res.status}`);
    return true;
  }
  const body = await res.text().catch(() => "");
  // lildax 上 wait 可能恒 503：明确标不可用，交由 /message 主路径
  if (res.status === 503 || res.status === 404 || res.status === 501) {
    const err = new Error(`wait 不可用 (${res.status}): ${body}`);
    err.code = "WAIT_UNAVAILABLE";
    throw err;
  }
  throw new Error(`wait 失败 (${res.status}): ${body}`);
}

/** 主动查询 session 是否 idle（不依赖 SSE） */
async function querySessionIdle(api, sessionId, signal) {
  const paths = [
    `/session/${sessionId}/status`,
    `/session/status`,
  ];
  for (const path of paths) {
    try {
      const res = await api(path, { signal });
      if (!res.ok) continue;
      const json = await res.json().catch(() => ({}));
      const data = json?.data ?? json;
      if (!data || typeof data !== "object") continue;
      if (data.busy === false) return true;
      if (data.idle === true) return true;
      if (data.status === "idle" || data.type === "idle" || data.state === "idle") {
        return true;
      }
      const one = data[sessionId];
      if (one && typeof one === "object") {
        if (one.busy === false) return true;
        if (one.idle === true) return true;
        if (one.status === "idle" || one.type === "idle" || one.state === "idle") {
          return true;
        }
      }
    } catch {
      // try next
    }
  }
  return false;
}

/**
 * 主完成判定：只向 lildax 主动查询。
 * - 主路径：定时 GET /message（completed/finish）
 * - 双保险：并行 POST /wait（idle）
 * - 辅助：GET status（idle）
 * SSE 仅推送 UI 进度，绝不参与完成判定。
 */
async function* completePromptByPollAndWait({
  api,
  sessionId,
  signal,
  log,
  messageId,
  afterMs = 0,
  pollIntervalMs = 1_000,
  completionTimeoutMs = 600_000,
  sseResponse = null,
  ssePermissionInbox = null,
}) {
  const t0 = Date.now();
  const eventQueue = [];
  let waitResolved = false;
  let waitFailed = null;
  const waitAbort = new AbortController();
  const waitSignal =
    typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, waitAbort.signal].filter(Boolean))
      : signal;

  const waitTask = waitForSessionIdle(
    api,
    sessionId,
    waitSignal,
    log,
    completionTimeoutMs
  )
    .then(() => {
      waitResolved = true;
    })
    .catch((err) => {
      if (
        signal?.aborted ||
        waitAbort.signal.aborted ||
        isStreamTerminationError(err)
      ) {
        return;
      }
      waitFailed = err;
      // lildax 上 wait 常 503（Session wait is not available yet），属预期，不刷错误感日志
      if (err?.code === "WAIT_UNAVAILABLE") {
        log(`wait 不可用，改用 /message 轮询完成判定`);
      } else {
        log(`wait 通道异常（仍以 /message 轮询为准）: ${err?.message ?? err}`);
      }
    });

  // SSE 可选：只往队列塞进度事件，完成判定不读这些标志
  if (sseResponse) {
    void (async () => {
      try {
        for await (const ev of parseSessionEvents(
          sseResponse,
          signal,
          log,
          completionTimeoutMs,
          { messageId, forceActive: true }
        )) {
          if (isPermissionEvent(ev)) {
            const perm = permissionFromEvent(ev);
            if (perm && Array.isArray(ssePermissionInbox)) {
              ssePermissionInbox.push(perm);
            }
          }
          // 完成类事件不进入 UI 队列，避免误触发 finish
          if (
            ev?.type === "session.next.step.ended" ||
            ev?.type === "session.next.step.failed"
          ) {
            continue;
          }
          eventQueue.push(ev);
        }
      } catch (err) {
        if (!signal?.aborted && !isStreamTerminationError(err)) {
          log(`SSE 进度通道结束: ${err?.message ?? err}`);
        }
      }
    })();
  }

  let lastEmittedText = "";

  const flushProgressOnly = function* () {
    while (eventQueue.length) {
      const ev = eventQueue.shift();
      const t = ev?.type;
      if (t === "session.next.text.delta") {
        const delta = ev?.data?.delta ?? ev?.data?.text;
        if (typeof delta === "string" && delta.length > 0) {
          lastEmittedText += delta;
        }
      }
      if (t === "session.next.text.ended") {
        const text = ev?.data?.text;
        if (typeof text === "string" && text.trim() && !lastEmittedText) {
          lastEmittedText = text;
        }
      }
      yield ev;
    }
  };

  const emitFinalFromHit = function* (hit, source) {
    log(
      `完成确认(${source}): len=${(hit?.text ?? "").length} messageID=${hit?.messageId ?? "?"} finish=${hit?.finish ?? "stop"}`
    );
    try {
      waitAbort.abort();
    } catch {
      // ignore
    }
    if (hit?.text && hit.text !== lastEmittedText) {
      let delta = hit.text;
      if (lastEmittedText && hit.text.startsWith(lastEmittedText)) {
        delta = hit.text.slice(lastEmittedText.length);
      } else if (lastEmittedText) {
        delta = "";
      }
      if (delta) {
        yield {
          type: "session.next.text.delta",
          data: { sessionID: sessionId, delta },
        };
        lastEmittedText = hit.text;
      } else if (!lastEmittedText && hit.text) {
        yield {
          type: "session.next.text.delta",
          data: { sessionID: sessionId, delta: hit.text },
        };
        lastEmittedText = hit.text;
      }
    }
    yield {
      type: "session.next.step.ended",
      data: {
        sessionID: sessionId,
        // 给 UI 的终态一律用 stop，避免 tool-calls 等中间 finish 无法触发 StreamEvent.finish
        finish: "stop",
        assistantMessageID: hit?.messageId,
        rawFinish: hit?.finish || "stop",
      },
    };
  };

  log(
    `开始完成判定（主动查询 lildax：/message + /wait + status；SSE 仅进度） poll=${pollIntervalMs}ms timeout=${Math.round(completionTimeoutMs / 1000)}s afterMessageId=${messageId ?? "?"} afterMs=${afterMs}`
  );

  while (!signal?.aborted) {
    // 1) 可选：刷 SSE 进度到 UI（与完成无关）
    yield* flushProgressOnly();

    // 2) 主路径：查询 /message
    try {
      const hit = await fetchLatestAssistantText(api, sessionId, signal, {
        afterMessageId: messageId,
        afterMs,
        allowIncomplete: true,
      });
      if (hit?.text && hit.text !== lastEmittedText) {
        let delta = hit.text;
        if (lastEmittedText && hit.text.startsWith(lastEmittedText)) {
          delta = hit.text.slice(lastEmittedText.length);
        } else if (lastEmittedText) {
          delta = "";
        }
        if (delta) {
          yield {
            type: "session.next.text.delta",
            data: { sessionID: sessionId, delta },
          };
          lastEmittedText = hit.text;
        }
      }
      if (hit?.completed) {
        yield* emitFinalFromHit(hit, "GET /message completed");
        await waitTask.catch(() => {});
        return;
      }
    } catch (err) {
      if (signal?.aborted || isStreamTerminationError(err)) return;
      log(`轮询 /message 出错: ${err?.message ?? err}`);
    }

    // 3) 双保险：wait 已返回 idle
    if (waitResolved) {
      const finalHit = await fetchLatestAssistantText(api, sessionId, signal, {
        afterMessageId: messageId,
        afterMs,
        allowIncomplete: true,
      }).catch(() => null);
      yield* emitFinalFromHit(
        finalHit || {
          text: lastEmittedText,
          finish: "stop",
          completed: true,
        },
        "POST /wait idle"
      );
      return;
    }

    // 4) 辅助：status idle 仅在 message 已最终完成时采信（wait 503 时禁止靠 status 软成功）
    try {
      const idle = await querySessionIdle(api, sessionId, signal);
      if (idle) {
        const finalHit = await fetchLatestAssistantText(api, sessionId, signal, {
          afterMessageId: messageId,
          afterMs,
          allowIncomplete: true,
        }).catch(() => null);
        if (finalHit?.completed) {
          yield* emitFinalFromHit(
            finalHit,
            "GET status idle + message completed"
          );
          await waitTask.catch(() => {});
          return;
        }
      }
    } catch (err) {
      if (!signal?.aborted) {
        log(`查询 status 出错: ${err?.message ?? err}`);
      }
    }

    if (Date.now() - t0 > completionTimeoutMs) {
      // 设计 §7.2：轮询超时且 wait 未确认 → failed。
      // wait 不可用（503）时仍须以 /message 最终 finish 为准；超时一律 failed。
      if (!waitResolved) {
        const hint =
          waitFailed?.code === "WAIT_UNAVAILABLE"
            ? "（wait 通道不可用，依赖 /message 未在限时内看到最终 finish）"
            : "";
        throw new Error(
          `轮询消息超时且 wait 未确认 idle${hint}：Agent 未在限时内完成。请重启 HxxCode Server 后新建会话重试。`
        );
      }
      const finalHit = await fetchLatestAssistantText(api, sessionId, signal, {
        afterMessageId: messageId,
        afterMs,
        allowIncomplete: true,
      }).catch(() => null);
      yield* emitFinalFromHit(
        finalHit || {
          text: lastEmittedText,
          finish: "stop",
          completed: true,
        },
        "timeout-after-wait"
      );
      await waitTask.catch(() => {});
      return;
    }

    await sleep(pollIntervalMs);
  }

  await waitTask.catch(() => {});
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
  /** 超时前若已有流式正文，不要硬失败，软结束本轮 */
  allowPartialOnTimeout = false,
  alreadyHadText = false,
}) {
  const t0 = Date.now();
  log(
    `开始轮询 /session/${sessionId}/message … afterMessageId=${messageId ?? "?"} afterMs=${afterMs}`
  );
  while (!signal?.aborted) {
    if (Date.now() - t0 > timeoutMs) {
      if (allowPartialOnTimeout && alreadyHadText) {
        log("轮询超时，但 SSE 已有部分正文，软结束本轮（不报硬错误）");
        const partial = await fetchLatestAssistantText(api, sessionId, signal, {
          afterMessageId: messageId,
          afterMs,
          allowIncomplete: true,
        }).catch(() => null);
        if (partial && !alreadyHadText) {
          yield {
            type: "session.next.text.delta",
            data: { sessionID: sessionId, delta: partial.text },
          };
        }
        yield {
          type: "session.next.step.ended",
          data: {
            sessionID: sessionId,
            finish: "stop",
            softTimeout: true,
          },
        };
        return;
      }
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
          `轮询命中本次 assistant 文本 len=${hit.text.length} messageID=${hit.messageId ?? "?"} completed=${hit.completed !== false}`
        );
        // 若 SSE 已推过正文，不要再把完整文本发一遍（会重复）；只发 finish
        if (!alreadyHadText) {
          yield {
            type: "session.next.step.started",
            data: { sessionID: sessionId, assistantMessageID: hit.messageId },
          };
          yield {
            type: "session.next.text.delta",
            data: { sessionID: sessionId, delta: hit.text },
          };
        }
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
 * 消费 SSE；断流后：重连 SSE + 轮询 /message，直到最终完成或软超时。
 */
async function* mergeSseWithMessagePoll(sseIter, pollOpts) {
  const {
    api,
    sessionId,
    signal,
    log,
    messageId,
    afterMs = 0,
    pollTimeoutMs = 300_000,
  } = pollOpts;
  const iter = sseIter[Symbol.asyncIterator]();
  let sseFinishedClean = false;
  let sawSseTextBody = false;
  let sawToolCall = false;
  let sawPrompted = false;

  const track = (ev) => {
    const t = ev?.type;
    if (t === "session.next.prompted") sawPrompted = true;
    if (t === "session.next.text.delta") {
      const delta = ev?.data?.delta ?? ev?.data?.text;
      if (typeof delta === "string" && delta.length > 0) sawSseTextBody = true;
    }
    if (t === "session.next.text.ended") {
      const text = ev?.data?.text;
      if (typeof text === "string" && text.trim()) sawSseTextBody = true;
    }
    if (t === "session.next.tool.called") sawToolCall = true;
  };

  try {
    while (!signal?.aborted) {
      const next = await iter.next();
      if (next.done) {
        log(
          `SSE 流结束 (clean=${sseFinishedClean}, sawTextBody=${sawSseTextBody}, sawTool=${sawToolCall}, prompted=${sawPrompted})`
        );
        break;
      }
      track(next.value);
      yield next.value;
      const t = next.value?.type;
      if (t === "session.next.step.failed" || isFinalStepEnded(next.value)) {
        sseFinishedClean = true;
        break;
      }
    }
  } finally {
    try {
      await iter.return?.();
    } catch {
      // ignore
    }
  }

  if (signal?.aborted || sseFinishedClean) return;

  const deadline = Date.now() + pollTimeoutMs;
  log(
    `SSE 提前结束 (text=${sawSseTextBody}, tool=${sawToolCall}, prompted=${sawPrompted})，进入重连+轮询兜底（最长 ${Math.round(pollTimeoutMs / 1000)}s）…`
  );

  let reconnectAttempt = 0;
  while (!signal?.aborted && Date.now() < deadline) {
    // 1) 先看消息是否已完成
    try {
      const hit = await fetchLatestAssistantText(api, sessionId, signal, {
        afterMessageId: messageId,
        afterMs,
      });
      if (hit) {
        log(`兜底轮询命中最终结果 len=${hit.text.length}`);
        if (!sawSseTextBody) {
          yield {
            type: "session.next.text.delta",
            data: { sessionID: sessionId, delta: hit.text },
          };
          sawSseTextBody = true;
        }
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
      if (signal?.aborted || isStreamTerminationError(err)) return;
      log(`兜底查消息失败: ${err.message}`);
    }

    // 2) 重连 SSE，继续收后续 tool / text（forceActive：不再等 prompted）
    reconnectAttempt++;
    const remainMs = Math.max(5_000, deadline - Date.now());
    log(`重连 SSE #${reconnectAttempt}（本段最长 ${Math.round(remainMs / 1000)}s）…`);
    try {
      const sseHeaderTimeout = AbortSignal.timeout(8_000);
      const sseSignal =
        typeof AbortSignal.any === "function"
          ? AbortSignal.any([signal, sseHeaderTimeout])
          : signal;
      const eventRes = await api(`/session/${sessionId}/event`, {
        signal: sseSignal,
        headers: { Accept: "text/event-stream" },
      });
      if (eventRes.ok) {
        let gotFinal = false;
        for await (const ev of parseSessionEvents(
          eventRes,
          signal,
          log,
          Math.min(remainMs, 120_000),
          {
            messageId,
            forceActive: true,
          }
        )) {
          track(ev);
          yield ev;
          if (ev?.type === "session.next.step.failed" || isFinalStepEnded(ev)) {
            gotFinal = true;
            break;
          }
        }
        if (gotFinal) return;
        log(`重连 SSE #${reconnectAttempt} 结束，尚未最终完成，继续…`);
      } else {
        log(`重连 SSE 失败: HTTP ${eventRes.status}`);
      }
    } catch (err) {
      if (signal?.aborted) return;
      if (!isStreamTerminationError(err) && !/aborted|timeout|TimeoutError/i.test(String(err?.message ?? err))) {
        log(`重连 SSE 异常: ${err.message}`);
      }
    }

    await sleep(1500);
  }

  // 超时：已有正文则软结束，避免整轮标红失败
  if (sawSseTextBody || sawToolCall) {
    log("兜底超时，已有部分 Agent 输出，软结束");
    yield {
      type: "session.next.text.delta",
      data: {
        sessionID: sessionId,
        delta:
          "\n\n*（Agent 未在限时内完整结束。若还需继续改代码，请再发一条消息，或重启 Server 后重试。）*",
      },
    };
    yield {
      type: "session.next.step.ended",
      data: { sessionID: sessionId, finish: "stop", softTimeout: true },
    };
    return;
  }

  yield* pollSessionMessagesAsEvents({
    api,
    sessionId,
    signal,
    log,
    messageId,
    afterMs,
    timeoutMs: 30_000,
    allowPartialOnTimeout: true,
    alreadyHadText: false,
  });
}

/**
 * 在整个 prompt 生命周期（SSE + /message 兜底）内持续处理权限。
 * 旧逻辑只把权限轮询绑在 SSE 上：SSE 一断权限轮询就停，Agent 若仍在等
 * external_directory 等授权会永久卡住，UI 一直闪烁。
 *
 * 取消时必须能打断 onPermission（否则 await 永不返回，prompt 也无法结束）。
 */
async function* withPermissionPolling(inner, permissionContext, signal, log) {
  if (!permissionContext?.onPermission) {
    yield* inner;
    return;
  }

  const handled = new Set();
  let polling = true;

  const aborted = () =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve("reject");
        return;
      }
      signal?.addEventListener("abort", () => resolve("reject"), { once: true });
    });

  const pollPermissions = async () => {
    while (polling && !signal?.aborted) {
      let pendingCount = 0;
      try {
        const pending = await permissionContext.listPermissions();
        const list = (Array.isArray(pending) ? pending : extractPermissionList(pending))
          .map(normalizePermissionRequest)
          .filter(Boolean);
        // 合并 SSE 推入的权限（若有）
        if (Array.isArray(permissionContext.sseInbox)) {
          while (permissionContext.sseInbox.length) {
            const n = normalizePermissionRequest(permissionContext.sseInbox.shift());
            if (n) list.push(n);
          }
        }
        pendingCount = list.length;
        // 仍出现在 pending 里的，说明上次 reply 没生效，允许重试
        for (const req of list) {
          const id = req?.id;
          if (!id || handled.has(id)) continue;
          handled.add(id);
          log(
            `权限待确认: action=${req.action} resources=${preview(JSON.stringify(req.resources ?? []), 120)} id=${id}`
          );
          try {
            const reply = await Promise.race([
              permissionContext.onPermission(req),
              aborted(),
            ]);
            if (signal?.aborted || !polling) {
              try {
                await permissionContext.replyPermission(id, "reject");
                log(`取消中，已拒绝权限: requestID=${id}`);
              } catch {
                // ignore
              }
              return;
            }
            await permissionContext.replyPermission(id, reply);
            // 关键：确认 pending 里已经消失；否则当作失败重试（避免假 200）
            await sleep(250);
            const still = (
              await permissionContext.listPermissions().catch(() => [])
            )
              .map(normalizePermissionRequest)
              .filter(Boolean)
              .some((p) => p.id === id);
            if (still) {
              handled.delete(id);
              log(
                `权限回复后仍在 pending，将换一种格式重试: reply=${reply} requestID=${id}`
              );
              // 立刻用别名再打一次
              try {
                await permissionContext.replyPermission(id, reply, {
                  forceAlias: true,
                });
                await sleep(250);
                const still2 = (
                  await permissionContext.listPermissions().catch(() => [])
                )
                  .map(normalizePermissionRequest)
                  .filter(Boolean)
                  .some((p) => p.id === id);
                if (still2) {
                  handled.delete(id);
                  log(`权限仍未清除，下一轮轮询会再问用户: ${id}`);
                } else {
                  log(`权限已确认清除(别名): ${reply} id=${id}`);
                }
              } catch (err) {
                handled.delete(id);
                log(`权限别名回复失败: ${err?.message ?? err}`);
              }
            } else {
              log(`权限已回复并确认清除: ${reply} (requestID=${id})`);
            }
          } catch (err) {
            const msg = String(err?.message ?? err);
            if (/404|PermissionNotFound/i.test(msg)) {
              log(`权限请求已失效，跳过: ${id}`);
            } else {
              handled.delete(id);
              log(`权限回复失败，将重试: ${msg}`);
            }
          }
        }
      } catch (err) {
        if (!signal?.aborted) {
          log(`权限轮询错误: ${err.message}`);
        }
      }
      // 无 pending 时放慢轮询，减少诊断刷屏
      await sleep(pendingCount > 0 ? 400 : 1600);
    }
  };

  const pollTask = pollPermissions();
  try {
    yield* inner;
  } finally {
    polling = false;
    // 最多再等一小段，避免 onPermission 死锁拖死整个 prompt
    await Promise.race([pollTask.catch(() => {}), sleep(1_500)]);
  }
}

/** @deprecated 权限轮询已提升到 withPermissionPolling；保留空壳以免旧调用路径崩溃 */
async function* parseSessionEventsWithPermissions(
  response,
  signal,
  log,
  idleTimeoutMs,
  promptFilter,
  _permissionContext
) {
  yield* parseSessionEvents(response, signal, log, idleTimeoutMs, promptFilter);
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
  let active = !targetMessageId || !!promptFilter?.forceActive;
  log(
    targetMessageId
      ? `SSE 事件流已连接，等待 prompt messageID=${targetMessageId}${active ? "（已激活）" : ""}…`
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
    // 轮询 /message 时不要逐条打日志，否则诊断通道会被刷爆、看起来像卡住
    const quietPoll =
      method === "GET" &&
      typeof path === "string" &&
      /\/session\/[^/]+\/message$/.test(path);
    if (!quietPoll) {
      log(`→ HTTP ${method} ${path}${init.body ? ` body=${preview(init.body, 120)}` : ""}`);
    }

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
    } else if (!quietPoll) {
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
        const normalized = normalizeMessageList(json);
        return {
          data: normalized.map((m) => ({
            id: m.id,
            type: m.type,
            finish: m.finish,
            content: m.content,
            time: m.time,
          })),
        };
      },
      /**
       * 等待 session agent loop idle（POST /wait）。
       * @returns {{ idle: true }}
       */
      async wait(sessionId, options = {}) {
        const timeoutMs = Math.max(1_000, options.timeoutMs ?? 600_000);
        const signal = options.signal;
        await waitForSessionIdle(api, sessionId, signal, log, timeoutMs);
        return { idle: true };
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

              // 可选连接 SSE 仅作进度；完成判定一律走 poll + wait，不把 SSE 断开当结束。
              log(`可选连接 SSE（仅进度）: ${apiPrefix}/session/${id}/event`);
              let eventRes = null;
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
                if (!eventRes.ok) {
                  log(
                    `SSE 不可用 (${eventRes.status})，仅用 message 轮询 + wait`
                  );
                  eventRes = null;
                } else {
                  log(`SSE 已连通（进度通道）`);
                }
              } catch (err) {
                if (fetchSignal.aborted) throw err;
                if (
                  err?.name === "TimeoutError" ||
                  /aborted|timeout/i.test(String(err?.message ?? err))
                ) {
                  log(
                    `SSE 响应头超时（8s），仅用 message 轮询 + wait messageID=${promptMessageId ?? "?"}`
                  );
                  eventRes = null;
                } else {
                  log(`SSE 连接失败，降级为轮询+wait: ${err?.message ?? err}`);
                  eventRes = null;
                }
              }

              const ssePermissionInbox = [];
              const permissionCtx = onPermission
                ? {
                    sseInbox: ssePermissionInbox,
                    listPermissions: async () => {
                      // 仅用会话级；全局 GET /permission 在 lildax 上 404，勿每轮空打
                      const sessionRes = await api(`/session/${id}/permission`, {
                        signal: fetchSignal,
                      }).catch(() => null);
                      if (!sessionRes?.ok) return [];
                      const json = await sessionRes.json().catch(() => ({}));
                      const list = extractPermissionList(json)
                        .map(normalizePermissionRequest)
                        .filter(Boolean);
                      if (list.length) {
                        log(
                          `会话权限 pending=${list.length}: ${preview(JSON.stringify(list.map((p) => ({ id: p.id, action: p.action, resources: p.resources }))), 200)}`
                        );
                      } else {
                        // 调试：偶发非空 body 却解析不出列表时打预览
                        const rawPreview = preview(JSON.stringify(json), 160);
                        if (rawPreview && rawPreview !== "[]" && rawPreview !== "{}" && !/"data"\s*:\s*\[\s*\]/.test(rawPreview)) {
                          log(`权限列表原始响应: ${rawPreview}`);
                        }
                      }
                      return list;
                    },
                    replyPermission: async (requestId, reply, opts = {}) => {
                      // once/always/reject 与部分版本 allow/always_allow/deny 并存
                      const primary = String(reply || "reject");
                      const aliases = {
                        once: opts.forceAlias
                          ? ["allow", "once"]
                          : ["once", "allow"],
                        always: opts.forceAlias
                          ? ["always_allow", "always"]
                          : ["always", "always_allow"],
                        reject: opts.forceAlias
                          ? ["deny", "reject"]
                          : ["reject", "deny"],
                        allow: ["allow", "once"],
                        always_allow: ["always_allow", "always"],
                        deny: ["deny", "reject"],
                      };
                      const replyValues = aliases[primary] || [primary];

                      const attempts = [];
                      for (const r of replyValues) {
                        attempts.push({
                          path: `/session/${id}/permission/${requestId}/reply`,
                          body: { reply: r },
                          label: `session.permission.reply:${r}`,
                        });
                        attempts.push({
                          path: `/session/${id}/permissions/${requestId}`,
                          body: { response: r, reply: r },
                          label: `session.permissions:${r}`,
                        });
                      }
                      // 全局路径放最后，且必须事后用 list 校验（已知会假 200）
                      for (const r of replyValues) {
                        attempts.push({
                          path: `/permission/${requestId}/reply`,
                          body: { reply: r },
                          label: `permission.reply:${r}`,
                          requireClear: true,
                        });
                      }

                      let lastErr = null;
                      for (const a of attempts) {
                        try {
                          log(`尝试权限回复 ${a.label} → ${a.path}`);
                          const res = await api(a.path, {
                            method: "POST",
                            body: JSON.stringify(a.body),
                            signal: fetchSignal,
                          });
                          const text = await res.text().catch(() => "");
                          if (!res.ok) {
                            lastErr = new Error(
                              `权限回复失败 (${res.status}): ${text}`
                            );
                            if (res.status === 404) continue;
                            continue;
                          }
                          if (a.requireClear) {
                            await sleep(200);
                            const check = await api(`/session/${id}/permission`, {
                              signal: fetchSignal,
                            }).catch(() => null);
                            let still = false;
                            if (check?.ok) {
                              const json = await check.json().catch(() => ({}));
                              still = extractPermissionList(json)
                                .map(normalizePermissionRequest)
                                .filter(Boolean)
                                .some((p) => p.id === requestId);
                            }
                            if (still) {
                              log(
                                `全局 reply 返回成功但 pending 仍在，继续尝试下一路径`
                              );
                              continue;
                            }
                          }
                          log(`权限回复成功: ${a.label}`);
                          return;
                        } catch (err) {
                          lastErr = err;
                        }
                      }
                      throw lastErr || new Error("权限回复失败");
                    },
                    onPermission,
                  }
                : null;

              return withPermissionPolling(
                completePromptByPollAndWait({
                  api,
                  sessionId: id,
                  signal: fetchSignal,
                  log,
                  messageId: promptMessageId,
                  afterMs: promptAfterMs,
                  pollIntervalMs: options.completionPollIntervalMs ?? 1_000,
                  completionTimeoutMs: options.completionTimeoutMs ?? 600_000,
                  sseResponse: eventRes,
                  ssePermissionInbox,
                }),
                permissionCtx,
                fetchSignal,
                log
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

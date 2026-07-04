import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function run(cli, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cli, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d));
    proc.stderr?.on("data", (d) => (stderr += d));
    proc.on("close", (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout || `exit ${code}`))
    );
  });
}

const hxxConfig = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".hxxcode/config.json"), "utf8")
);
const key = hxxConfig.apiKeys["newapi-default"];
const configPath = path.join(os.homedir(), ".config/opencode/opencode.jsonc");
const existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
existing.provider["newapi-default"] = {
  npm: "@ai-sdk/openai-compatible",
  name: "DeepSeek",
  options: {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: key,
  },
  models: {
    "deepseek-v4-pro": { name: "deepseek-v4-pro" },
  },
};
fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));

await run("lildax", ["service", "restart"]);
await new Promise((r) => setTimeout(r, 3000));

const pass = (await run("lildax", ["service", "password"])).split(/\r?\n/).pop();
const auth = Buffer.from(`opencode:${pass}`).toString("base64");
const dir = encodeURIComponent("d:/work/h2x/hxxcode");

const cr = await fetch(`http://127.0.0.1:4096/api/session?directory=${dir}`, {
  method: "POST",
  headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: { providerID: "newapi-default", id: "deepseek-v4-pro" } }),
});
const sid = (await cr.json()).data.id;
await fetch(`http://127.0.0.1:4096/api/session/${sid}/prompt?directory=${dir}`, {
  method: "POST",
  headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: { text: "reply with exactly: OK" } }),
});

const t0 = Date.now();
const res = await fetch(`http://127.0.0.1:4096/api/session/${sid}/event?directory=${dir}`, {
  headers: { Authorization: `Basic ${auth}`, Accept: "text/event-stream" },
});
const reader = res.body.getReader();
const dec = new TextDecoder();
const types = [];
while (Date.now() - t0 < 30000) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const line of dec.decode(value).split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const ev = JSON.parse(line.slice(5));
      types.push(ev.type);
      if (ev.type.includes("step.failed")) {
        console.log("FAILED:", JSON.stringify(ev.data));
        process.exit(1);
      }
      if (ev.type.includes("text.ended")) {
        console.log("TEXT:", ev.data?.text);
      }
      if (ev.type.includes("step.ended")) {
        console.log("SUCCESS:", types.join(" -> "));
        process.exit(0);
      }
    } catch {}
  }
}
console.log("TIMEOUT:", types.join(" -> "));

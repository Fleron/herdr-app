import { createHash } from "crypto";
import { codexCommand } from "./codex.js";

const MINUTE = 60_000;
const AUTH_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
const PROVIDERS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE"];
const ENV_KEYS = ["CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "USER", ...AUTH_KEYS, ...PROVIDERS];
const ENV_SH = 'printf "%s\\0" ' + ENV_KEYS.map(k => `"\${${k}${AUTH_KEYS.includes(k) ? ":+set" : "-"}}"`).join(" ");
const ENV_PS = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(${ENV_KEYS.map(k => AUTH_KEYS.includes(k) ? `[bool]$env:${k}` : `$env:${k === "USER" ? "USERNAME" : k}`).join(", ")}) | ConvertTo-Json -Compress`;

function failure(kind, message) {
  return Object.assign(new Error(message), { kind });
}

function json(text, kind = "response") {
  try { return JSON.parse(text); }
  catch { throw failure(kind, kind === "credentials" ? "Claude sign-in data could not be read." : "The provider returned invalid usage data."); }
}

function timestamp(value) {
  if (value == null) return null;
  const time = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(time) || time < 0) throw failure("response", "The provider returned an invalid reset time.");
  return time;
}

function usageWindow(label, used, resets, minutes) {
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) throw failure("response", "The provider returned an invalid usage percentage.");
  return { label: String(label).replace(/[\r\n]/g, " "), used, resetsAt: timestamp(resets), minutes };
}

function duration(minutes, fallback) {
  if (minutes == null) return fallback;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) throw failure("response", "The provider returned an invalid usage window.");
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function claudeWindows(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw failure("response", "Claude returned invalid usage data.");
  if (Array.isArray(body.limits) && body.limits.length) {
    return body.limits.flatMap(limit => {
      if (!limit || typeof limit !== "object") throw failure("response", "Claude returned an invalid usage window.");
      if (limit.percent == null) return [];
      const label = limit.kind === "session" ? "5h" : limit.kind === "weekly_all" ? "7d" : limit.scope?.model?.display_name || limit.display_name || limit.kind;
      if (!label) throw failure("response", "Claude returned an unnamed usage window.");
      return [usageWindow(label, limit.percent, limit.resets_at, limit.kind === "session" ? 300 : limit.kind?.startsWith("weekly") ? 10080 : null)];
    });
  }
  const entries = Object.entries(body).filter(([key]) => key === "five_hour" || /^seven_day(?:_|$)/.test(key) && key !== "seven_day_breakdown");
  if (!entries.length && !Array.isArray(body.limits)) throw failure("response", "Claude returned no recognized usage data.");
  return entries.filter(([, value]) => value?.utilization != null).map(([key, value]) => {
    const label = key === "five_hour" ? "5h" : key === "seven_day" ? "7d" : `7d ${key.slice(10).replace(/_/g, " ")}`;
    return usageWindow(label, value.utilization, value.resets_at, key === "five_hour" ? 300 : 10080);
  });
}

export function codexWindows(body) {
  if (!body || typeof body !== "object" || !("rateLimits" in body || "rateLimitsByLimitId" in body)) throw failure("response", "Codex returned no recognized usage data.");
  const buckets = body.rateLimitsByLimitId ?? { codex: body.rateLimits };
  if (!buckets || typeof buckets !== "object" || Array.isArray(buckets)) throw failure("response", "Codex returned invalid usage buckets.");
  return Object.entries(buckets).flatMap(([id, bucket]) => {
    if (bucket == null) return [];
    if (typeof bucket !== "object" || !("primary" in bucket || "secondary" in bucket)) throw failure("response", "Codex returned an invalid usage bucket.");
    return [["primary", "Primary"], ["secondary", "Secondary"]].flatMap(([key, fallback]) => {
      const value = bucket[key];
      if (value == null) return [];
      const label = duration(value.windowDurationMins, fallback);
      return [usageWindow(id === "codex" ? label : `${bucket.limitName || id} ${label}`, value.usedPercent, value.resetsAt, value.windowDurationMins)];
    });
  });
}

async function claudeContext(io) {
  const [command, args] = io.platform === "windows"
    ? ["powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ENV_PS]]
    : ["sh", ["-c", ENV_SH, "herdr-usage-env"]];
  let result;
  try { result = await io.exec(command, args, { timeout: 5000 }); }
  catch { throw failure("credentials", "Could not inspect the local Claude sign-in."); }
  if (result.code !== 0) throw failure("credentials", "Could not inspect the local Claude sign-in.");
  const fields = io.platform === "windows" ? json(result.stdout, "credentials") : result.stdout.split("\0").slice(0, ENV_KEYS.length);
  if (!Array.isArray(fields) || fields.length !== ENV_KEYS.length) throw failure("credentials", "Could not inspect the local Claude profile.");
  const [profile, , user] = fields;
  const root = profile || `${io.home}/.claude`;
  if (profile && !/^\/|^[a-z]:[\\/]|^\\\\/i.test(profile)) throw failure("credentials", "Claude usage requires an absolute CLAUDE_CONFIG_DIR.");
  const text = await io.readTextFile(`${root}/settings.json`);
  const settings = text == null ? {} : json(text, "credentials");
  const env = Object.fromEntries(ENV_KEYS.map((k, i) => [k, fields[i]]));
  for (const k of ENV_KEYS) if (Object.prototype.hasOwnProperty.call(settings.env || {}, k)) env[k] = settings.env[k];
  const api = String(env.ANTHROPIC_BASE_URL || "").trim().replace(/\/+$/, "");
  const enabled = value => !["", "0", "false", "no", "off"].includes(String(value ?? "").trim().toLowerCase());
  if (PROVIDERS.some(k => enabled(env[k])) || api && api !== "https://api.anthropic.com" && !api.startsWith("https://api.anthropic.com/")) throw failure("external", "Claude uses another provider; local subscription usage is unavailable.");
  if (env.ANTHROPIC_API_KEY) throw failure("billing", "Claude uses API billing; subscription usage is unavailable.");
  if (env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN || settings.apiKeyHelper) throw failure("external", "Claude's sign-in is supplied externally; local subscription usage is unavailable.");
  return { root, profile, user };
}

async function claude(io, identify) {
  const context = await claudeContext(io);
  let credentials;
  if (io.platform === "macos") {
    const suffix = context.profile ? `-${createHash("sha256").update(context.profile.normalize("NFC")).digest("hex").slice(0, 8)}` : "";
    for (const account of [context.user || null]) {
      const args = ["find-generic-password", "-s", `Claude Code-credentials${suffix}`, ...(account ? ["-a", account] : []), "-w"];
      let result;
      try { result = await io.exec("security", args, { timeout: 10_000 }); }
      catch { throw failure("credentials", "Claude's Keychain sign-in could not be read."); }
      if (result.code === 44) continue;
      if (result.code !== 0) throw failure("credentials", "Claude's Keychain sign-in could not be read.");
      const value = json(result.stdout, "credentials");
      if (value?.claudeAiOauth?.accessToken) { credentials = value; break; }
    }
  }
  if (!credentials) {
    const text = await io.readTextFile(`${context.root}/.credentials.json`);
    credentials = text == null ? null : json(text, "credentials");
  }
  const auth = credentials?.claudeAiOauth;
  if (typeof auth?.accessToken !== "string" || !auth.accessToken) throw failure("signedout", "Sign in with Claude Code to see subscription usage.");
  identify(createHash("sha256").update(`${context.root}\0${auth.accessToken}`).digest("hex"));
  if (typeof auth.expiresAt === "number" && auth.expiresAt <= io.now()) throw failure("signedout", "Claude's sign-in expired. Open Claude Code to renew it.");
  let response;
  try {
    response = await io.fetch("https://api.anthropic.com/api/oauth/usage", { headers: { Authorization: `Bearer ${auth.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" } });
  } catch { throw failure("network", "Could not connect to Claude's usage service."); }
  if (response.status === 401 || response.status === 403) throw failure("signedout", "Claude rejected its current sign-in. Open Claude Code to renew it.");
  if (response.status === 429) throw failure("limited", "Claude's usage service is rate limited. Refresh will retry later.");
  if (!response.ok) throw failure("server", `Claude's usage service returned HTTP ${response.status}.`);
  return claudeWindows(json(await response.text()));
}

async function codex(io) {
  const [command, args] = codexCommand(io.platform);
  let result;
  try { result = await io.exec(command, args, { timeout: 45_000 }); }
  catch { throw failure("process", "Codex's usage query could not start or did not finish."); }
  if (result.code === 127) throw failure("missing", "Install the Codex CLI to see subscription usage.");
  const replies = result.stdout.split(/\r?\n/).filter(Boolean).map(line => json(line));
  const accountReply = replies.find(r => r.id === "usage-account");
  const account = accountReply?.result?.account;
  if (accountReply && !accountReply.error && account === null) throw failure("signedout", "Sign in with Codex to see subscription usage.");
  if (account?.type === "apiKey") throw failure("billing", "Codex uses API billing; subscription usage is unavailable.");
  if (result.code === 124) throw failure("timeout", "Codex's usage query timed out or ended before replying.");
  if (result.code !== 0 || !accountReply || accountReply.error) throw failure("process", "Codex could not read its current account.");
  const reply = replies.find(r => r.id === "usage-limits");
  if (!reply || reply.error) throw failure("server", "Codex could not read current subscription usage.");
  return codexWindows(reply.result);
}

export function createUsage(io) {
  io = { now: () => Date.now(), ...io };
  const providers = ["Claude", "Codex"].map(name => ({ name, windows: [], status: "loading", message: "Loading local subscription usage…", checkedAt: null, nextAt: 0, lastAttempt: -Infinity, busy: false, identity: null, failures: 0 }));
  async function refresh(state, force = false) {
    const now = io.now();
    if (state.busy || now - state.lastAttempt < 10_000 || !force && now < state.nextAt) return;
    state.busy = true;
    state.lastAttempt = now;
    let identity = null;
    try {
      const windows = state.name === "Claude" ? await claude(io, value => {
        identity = value;
        if (state.identity !== value) { state.windows = []; state.checkedAt = null; }
        state.identity = value;
      }) : await codex(io);
      state.windows = windows;
      state.checkedAt = io.now();
      state.status = windows.length ? "ready" : "empty";
      state.message = windows.length ? "" : "The provider reports no subscription usage windows.";
      state.failures = 0;
      state.nextAt = Math.min(state.checkedAt + 10 * MINUTE, ...windows.map(w => w.resetsAt).filter(t => t > state.checkedAt));
    } catch (error) {
      const kind = error.kind || "credentials";
      if (state.name === "Codex" || !identity || identity !== state.identity || ["signedout", "external", "billing"].includes(kind)) { state.windows = []; state.checkedAt = null; }
      state.status = state.windows.length ? "stale" : kind;
      state.message = error.kind ? error.message : "Claude's sign-in data could not be read.";
      state.failures++;
      const delay = kind === "limited" ? 30 * MINUTE : kind === "signedout" ? Math.min(360, 10 * 2 ** Math.min(state.failures - 1, 6)) * MINUTE : 5 * MINUTE;
      state.nextAt = io.now() + delay;
    } finally { state.busy = false; }
  }
  return { providers, refresh };
}

export function usageText(state, now, compact = false) {
  const values = compact ? [...state.windows].sort((a, b) => b.used - a.used).slice(0, 1) : state.windows;
  const labels = { loading: "…", signedout: "Sign in", billing: "API billing", external: "External sign-in", missing: "Not installed", empty: "Not reported", limited: "Rate limited", timeout: "Timed out", network: "Offline", credentials: "Sign-in error", response: "Invalid data", server: "Unavailable", process: "Query failed" };
  if (!values.length) return `${state.name} ${labels[state.status] || "Unavailable"}`;
  return `${state.name} ${values.map(w => `${w.label} ${w.resetsAt != null && w.resetsAt <= now ? "—" : `${Math.floor(Math.max(0, 100 - w.used))}%`}`).join(" · ")}${state.status === "stale" ? " (stale)" : ""}`;
}

export function usageDetail(state, now) {
  return [
    `${state.name} · local CLI account · remaining usage`,
    ...state.windows.map(w => `${w.label}: ${w.resetsAt != null && w.resetsAt <= now ? "reset passed; awaiting current usage" : `${Math.floor(Math.max(0, 100 - w.used))}% remaining`}${w.resetsAt == null ? "" : ` · resets ${new Date(w.resetsAt).toLocaleString()}`}`),
    state.message,
    state.checkedAt == null ? "" : `Last checked ${new Date(state.checkedAt).toLocaleString()}`,
  ].filter(Boolean).join("\n");
}

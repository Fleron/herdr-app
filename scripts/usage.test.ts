import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createUsage, usageText, usageDetail, claudeWindows, codexWindows } from "../defaults/mods/workspace-status/usage.js";

const CLI = `
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
const mode = process.env.HERDR_USAGE_TEST_MODE;
await writeFile(process.env.HERDR_USAGE_TEST_PID, String(process.pid));
if (process.argv[2] === 'child') { setInterval(() => {}, 1000); await new Promise(() => {}); }
if (mode === 'launcher') {
  const child = Bun.spawn([process.execPath, import.meta.path, 'child'], { env: {...process.env, HERDR_USAGE_TEST_MODE:'hang'}, stdin:'ignore', stdout:'inherit', stderr:'inherit' });
  await writeFile(process.env.HERDR_USAGE_TEST_CHILD, String(child.pid));
  process.exit(1);
}
let phase = 'init';
const send = value => console.log(JSON.stringify(value));
for await (const line of createInterface({input:process.stdin})) {
  const m = JSON.parse(line);
  if (m.method === 'initialize' && phase === 'init') {
    send({id:m.id, result:{userAgent:'fixture'}}); phase='initialized';
  } else if (m.method === 'initialized' && phase === 'initialized') {
    phase='account';
  } else if (m.method === 'account/read' && phase === 'account') {
    send({id:m.id, result:{account:mode === 'signedout' ? null : {type:mode === 'apiKey' ? 'apiKey' : 'chatgpt', email:'fixture@example.invalid'}}}); phase='limits';
  } else if (m.method === 'account/rateLimits/read' && phase === 'limits') {
    if (mode === 'hang') { setInterval(() => {}, 1000); continue; }
    if (mode === 'crash') process.exit(3);
    send({method:'fixture/notification', params:{id:'usage-limits'}});
    if (mode === 'error') send({error:{code:-32000, message:'PRIVATE ERROR BODY'}, id:m.id});
    else if (mode === 'malformed') send({id:m.id, result:{}});
    else send({id:m.id, result:{rateLimits:{primary:{usedPercent:25, windowDurationMins:300, resetsAt:Math.floor(Date.now()/1000)+3600}, secondary:{usedPercent:40, windowDurationMins:10080, resetsAt:Math.floor(Date.now()/1000)+86400}}}});
    phase='done';
  } else process.exit(9);
}
process.exit(0);
`;

async function fixture(platform = process.platform === "win32" ? "windows" : "linux") {
  const root = await mkdtemp(join(tmpdir(), "herdr-usage-test-"));
  const config = join(root, ".claude");
  const bin = join(root, "bin");
  await mkdir(config);
  await mkdir(bin);
  await writeFile(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token-A" } }));
  await writeFile(join(root, "fake-cli.js"), CLI);
  if (process.platform === "win32") {
    await writeFile(join(bin, "codex.cmd"), '@"%HERDR_USAGE_TEST_BUN%" "%HERDR_USAGE_TEST_FAKE%" %*\r\n');
  } else {
    await writeFile(join(bin, "codex"), '#!/bin/sh\nexec "$HERDR_USAGE_TEST_BUN" "$HERDR_USAGE_TEST_FAKE" "$@"\n');
    await chmod(join(bin, "codex"), 0o700);
  }
  let now = Date.now(), status = 200, mode = "success";
  let body: unknown = { five_hour: { utilization: 25, resets_at: new Date(now + 3600_000).toISOString() }, seven_day: { utilization: 40, resets_at: new Date(now + 86400_000).toISOString() } };
  const requests: { url: string; authorization: string | null }[] = [];
  const commands: { command: string; args: string[] }[] = [];
  let environment: unknown[] = ["", "", "fixture-user", "", "", "", "", "", "", "", ""];
  let keychain: ((args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) | null = null;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push({ url: request.url, authorization: request.headers.get("authorization") });
    return Response.json(body, { status });
  } });
  const io = {
    home: root,
    platform,
    now: () => now,
    async readTextFile(path: string) { try { return await readFile(path, "utf8"); } catch (e: any) { if (e.code === "ENOENT") return null; throw e; } },
    fetch: (_url: string, options: RequestInit) => fetch(server.url, options),
    async exec(command: string, args: string[]) {
      commands.push({ command, args });
      if (args.includes("herdr-usage-env") || command === "powershell" && args.at(-1)!.includes("CLAUDE_CONFIG_DIR")) {
        return { code: 0, stdout: io.platform === "windows" ? JSON.stringify(environment) : environment.join("\0") + "\0", stderr: "" };
      }
      if (command === "security") return keychain ? keychain(args) : { code: 44, stdout: "", stderr: "" };
      const child = Bun.spawn([command, ...args], { env: { ...process.env, PATH: bin + (process.platform === "win32" ? ";" : ":") + process.env.PATH,
        HERDR_USAGE_TEST_BUN: process.execPath, HERDR_USAGE_TEST_FAKE: join(root, "fake-cli.js"), HERDR_USAGE_TEST_MODE: mode,
        HERDR_USAGE_TEST_PID: join(root, "pid"), HERDR_USAGE_TEST_CHILD: join(root, "child-pid") }, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    },
  };
  const usage = createUsage(io);
  return {
    root, config, io, usage, requests, commands,
    claude: usage.providers[0], codex: usage.providers[1],
    advance(ms: number) { now += ms; },
    response(value: unknown, code = 200) { body = value; status = code; },
    env(value: unknown[]) { environment = value; },
    keychain(fn: NonNullable<typeof keychain>) { keychain = fn; },
    mode(value: string) { mode = value; },
    async credentials(token: string, expiresAt?: number) { await writeFile(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } })); },
    async close() { server.stop(true); await rm(root, { recursive: true, force: true }); },
  };
}

test("reads current Claude credentials, displays remaining windows, and keeps secrets out of state", async () => {
  const f = await fixture();
  try {
    await f.usage.refresh(f.claude);
    expect(f.claude.status).toBe("ready");
    expect(f.requests[0].authorization).toBe("Bearer fixture-token-A");
    expect(usageText(f.claude, f.io.now())).toBe("Claude 5h 75% · 7d 60%");
    expect(usageDetail(f.claude, f.io.now())).toContain("resets");
    expect(JSON.stringify(f.usage.providers)).not.toContain("fixture-token-A");
    expect(JSON.stringify(f.commands)).not.toContain("fixture-token-A");
  } finally { await f.close(); }
});

test("keeps stale Claude readings only for the same verified sign-in", async () => {
  const f = await fixture();
  try {
    await f.usage.refresh(f.claude);
    f.advance(600_000);
    f.response({ error: "PRIVATE ERROR BODY" }, 503);
    await f.usage.refresh(f.claude);
    expect(f.claude.status).toBe("stale");
    expect(usageText(f.claude, f.io.now())).toContain("75%");
    expect(f.claude.message).not.toContain("PRIVATE");
    f.advance(600_000);
    await f.credentials("fixture-token-B");
    await f.usage.refresh(f.claude);
    expect(f.claude.windows).toEqual([]);
    expect(f.claude.status).toBe("server");
  } finally { await f.close(); }
});

test("logout and expired credentials clear previous account readings without a request", async () => {
  const f = await fixture();
  try {
    await f.usage.refresh(f.claude);
    f.advance(600_000);
    await rm(join(f.config, ".credentials.json"));
    await f.usage.refresh(f.claude);
    expect(f.claude.status).toBe("signedout");
    expect(f.claude.windows).toEqual([]);
    await f.credentials("expired-fixture", f.io.now() - 1);
    f.advance(600_000);
    await f.usage.refresh(f.claude);
    expect(f.claude.status).toBe("signedout");
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

test("respects the explicit Claude profile and never selects the default Keychain account", async () => {
  const f = await fixture("macos");
  try {
    const profile = join(f.root, "profile-e\u0301");
    await mkdir(profile);
    f.env([profile, "", "fixture-user", "", "", "", "", "", "", "", ""]);
    const service = "Claude Code-credentials-" + createHash("sha256").update(profile.normalize("NFC")).digest("hex").slice(0, 8);
    f.keychain(async args => {
      expect(args).toEqual(["find-generic-password", "-s", service, "-a", "fixture-user", "-w"]);
      return { code: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: "profile-fixture" } }), stderr: "" };
    });
    await f.usage.refresh(f.claude);
    expect(f.claude.status).toBe("ready");
    expect(f.requests[0].authorization).toBe("Bearer profile-fixture");
  } finally { await f.close(); }
});

test("Keychain denial does not fall back to a potentially old credentials file", async () => {
  const f = await fixture("macos");
  try {
    f.keychain(async () => ({ code: 51, stdout: "", stderr: "PRIVATE ERROR BODY" }));
    await f.usage.refresh(f.claude);
    expect(f.claude.status).toBe("credentials");
    expect(f.requests).toHaveLength(0);
    expect(f.claude.message).not.toContain("PRIVATE");
  } finally { await f.close(); }
});

test("external Claude authentication does not report a leftover subscription sign-in", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.config, "settings.json"), JSON.stringify({ apiKeyHelper: "unused-helper" }));
    await f.usage.refresh(f.claude);
    expect(f.claude.status).toBe("external");
    expect(f.requests).toHaveLength(0);
    expect(f.commands.every(c => c.command !== "security")).toBe(true);
  } finally { await f.close(); }
});

test("Claude settings override shell routing, including explicit empty credentials and disabled provider flags", async () => {
  const f = await fixture();
  try {
    f.env(["", "https://api.anthropic.com", "fixture-user", "", "", "", "0", "false", "off", "no", ""]);
    await f.usage.refresh(f.claude);
    expect(f.claude.status).toBe("ready");
    expect(f.requests).toHaveLength(1);
    f.advance(600_000);
    await writeFile(join(f.config, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.invalid" } }));
    await f.usage.refresh(f.claude);
    expect(f.claude.status).toBe("external");
    expect(f.requests).toHaveLength(1);
    f.advance(600_000);
    f.env(["", "https://gateway.example.invalid", "fixture-user", "set", "", "", "1", "true", "yes", "on", "1"]);
    await writeFile(join(f.config, "settings.json"), JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: "", ANTHROPIC_API_KEY: "", CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "false",
      CLAUDE_CODE_USE_FOUNDRY: "off", CLAUDE_CODE_USE_ANTHROPIC_AWS: "no", CLAUDE_CODE_USE_MANTLE: "",
    } }));
    await f.usage.refresh(f.claude);
    expect(f.claude.status).toBe("ready");
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
});

test("polling is single-flight, respects backoff, and throttles manual refresh", async () => {
  const f = await fixture();
  try {
    const first = f.usage.refresh(f.claude);
    await Promise.all([first, f.usage.refresh(f.claude), f.usage.refresh(f.claude, true)]);
    expect(f.requests).toHaveLength(1);
    f.advance(10_000);
    await f.usage.refresh(f.claude);
    expect(f.requests).toHaveLength(1);
    f.response({}, 429);
    await f.usage.refresh(f.claude, true);
    expect(f.requests).toHaveLength(2);
    f.advance(600_000);
    await f.usage.refresh(f.claude);
    expect(f.requests).toHaveLength(2);
    f.advance(1_200_000);
    await f.usage.refresh(f.claude);
    expect(f.requests).toHaveLength(3);
  } finally { await f.close(); }
});

test("passed resets never manufacture a full allowance and are refreshed when due", async () => {
  const f = await fixture();
  try {
    f.response({ five_hour: { utilization: 80, resets_at: new Date(f.io.now() + 20_000).toISOString() } });
    await f.usage.refresh(f.claude);
    f.advance(21_000);
    expect(usageText(f.claude, f.io.now())).toBe("Claude 5h —");
    expect(usageDetail(f.claude, f.io.now())).toContain("awaiting current usage");
    await f.usage.refresh(f.claude);
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
});

test("parses all provider windows, including named limits and nonstandard durations", () => {
  const limits = Array.from({ length: 70 }, (_, i) => ({ kind: "weekly_scoped", scope: { model: { display_name: `Model ${i}` } }, percent: i, resets_at: null }));
  expect(claudeWindows({ limits })).toHaveLength(70);
  expect(claudeWindows({ seven_day_sonnet: { utilization: 12, resets_at: null } })[0].label).toBe("7d sonnet");
  const windows = codexWindows({ rateLimitsByLimitId: { codex: { primary: null, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: null } }, other: { limitName: "Other models", primary: { usedPercent: 50, windowDurationMins: 15, resetsAt: 1 } } } });
  expect(windows.map(w => w.label)).toEqual(["7d", "Other models 15m"]);
  expect(windows[0].used).toBe(0);
  expect(() => claudeWindows({ five_hour: { utilization: "25" } })).toThrow();
  expect(() => codexWindows({})).toThrow();
  expect(claudeWindows({ five_hour: null, seven_day: null })).toEqual([]);
  expect(claudeWindows({ five_hour: { utilization: null }, seven_day: { utilization: 0 } }).map(w => w.label)).toEqual(["7d"]);
  expect(claudeWindows({ limits: [{ kind: "session", percent: null }, { kind: "weekly_all", percent: 0 }] }).map(w => w.label)).toEqual(["7d"]);
});

test("the real Codex adapter handshakes, ignores nested notification IDs, and reaps its process", async () => {
  const f = await fixture();
  try {
    await f.usage.refresh(f.codex);
    expect(f.codex.status).toBe("ready");
    expect(usageText(f.codex, f.io.now())).toBe("Codex 5h 75% · 7d 60%");
    const pid = Number(await readFile(join(f.root, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await f.close(); }
}, 45_000);

for (const [mode, expected] of [["signedout", "signedout"], ["apiKey", "billing"], ["error", "server"], ["malformed", "response"], ["crash", "process"]]) {
  test(`Codex distinguishes ${mode} and discards unverified prior readings`, async () => {
    const f = await fixture();
    try {
      await f.usage.refresh(f.codex);
      f.advance(600_000);
      f.mode(mode);
      await f.usage.refresh(f.codex);
      expect(f.codex.status).toBe(expected);
      expect(f.codex.windows).toEqual([]);
      expect(f.codex.message).not.toContain("PRIVATE");
    } finally { await f.close(); }
  }, 75_000);
}

test("a launcher exiting early cannot leave its Codex child running", async () => {
  const f = await fixture();
  try {
    f.mode("launcher");
    await f.usage.refresh(f.codex);
    const pid = Number(await readFile(join(f.root, "child-pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(f.codex.windows).toEqual([]);
  } finally { await f.close(); }
}, 40_000);

test("Codex queries have a finite deadline and leave no hanging server", async () => {
  const f = await fixture();
  try {
    f.mode("hang");
    const started = performance.now();
    await f.usage.refresh(f.codex);
    expect(performance.now() - started).toBeLessThan(45_000);
    expect(f.codex.status).toBe("timeout");
    const pid = Number(await readFile(join(f.root, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await f.close(); }
}, 50_000);

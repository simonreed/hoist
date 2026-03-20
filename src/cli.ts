#!/usr/bin/env bun

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  renameSync,
  openSync,
  chmodSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Embedded cloudflared binary. Populated by vendor/cloudflared at build time.
// In dev/test mode this is the stub created by scripts/setup.sh — real content
// is detected at runtime via magic bytes and skipped if not a real binary.
import embeddedCf from "../vendor/cloudflared" with { type: "file" };

// ── Paths ─────────────────────────────────────────────────────────────────────
// HOIST_DIR overrides ~/.hoist for isolated test runs
// CLOUDFLARED_BIN overrides the cloudflared binary path (used in tests)
// HOIST_TEST_MODE=1 skips the watch view after starting a tunnel

const APP_DIR = process.env.HOIST_DIR ?? join(homedir(), ".hoist");
const STATE_FILE = join(APP_DIR, "state.json");
const PID_FILE = join(APP_DIR, "cloudflared.pid");
const LOG_FILE = join(APP_DIR, "cloudflared.log");
const CONFIG_FILE = join(APP_DIR, "config.yml");
const TEST_MODE = process.env.HOIST_TEST_MODE === "1";

// Set at startup by resolveCloudflared() — do not use before entry point runs
let CLOUDFLARED = "cloudflared";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Mapping {
  subdomain: string;
  port: number;
}

interface State {
  domain: string;
  tunnelName: string;
  tunnelId: string;
  mappings: Mapping[];
}

type LogEvent =
  | { type: "req"; time: string; method: string; host: string; path: string }
  | { type: "res"; time: string; status: number };

// ── Cloudflared binary resolution ─────────────────────────────────────────────

// Returns true if buf starts with a known native executable magic number.
// Used to distinguish the real cloudflared binary from the dev stub.
function isNativeBinary(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const b0 = buf[0]!, b1 = buf[1]!, b2 = buf[2]!, b3 = buf[3]!;
  // ELF (Linux)
  if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) return true;
  // Use >>> 0 to force unsigned 32-bit comparison (JS bitwise ops return signed int32)
  const magic = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  // Mach-O 64-bit: 0xFEEDFACF (big-endian) or 0xCFFAEDFE (little-endian / arm64)
  if (magic === 0xfeedfacf || magic === 0xcffaedfe) return true;
  // Mach-O universal/fat binary
  if (magic === 0xcafebabe || magic === 0xcafebabf) return true;
  return false;
}

// Resolves the cloudflared binary to use, in priority order:
//   1. CLOUDFLARED_BIN env var  (tests / manual override)
//   2. Already-extracted binary at $APP_DIR/cloudflared
//   3. Embedded real binary     (compiled standalone executable)
//   4. System cloudflared in PATH
function resolveCloudflared(): string {
  if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN;

  const extracted = join(APP_DIR, "cloudflared");
  if (existsSync(extracted)) return extracted;

  // Check whether the embedded file is a real binary (not the dev stub)
  try {
    const data = readFileSync(embeddedCf);
    if (isNativeBinary(data)) {
      mkdirSync(APP_DIR, { recursive: true });
      writeFileSync(extracted, data);
      chmodSync(extracted, 0o755);
      console.error(`hoist: extracted cloudflared to ${extracted}`);
      return extracted;
    }
  } catch {
    // embedded file unreadable — fall through
  }

  // Fall back to system cloudflared
  const which = spawnSync("which", ["cloudflared"], { encoding: "utf8" });
  if (which.status === 0) return "cloudflared";

  console.error(
    "cloudflared not found.\n" +
    "  Option 1: Download the standalone hoist binary (includes cloudflared)\n" +
    "  Option 2: brew install cloudflared"
  );
  process.exit(1);
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadState(): State | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
}

function saveState(state: State): void {
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function requireState(): State {
  const state = loadState();
  if (!state) {
    console.error("No tunnel configured. Run: hoist init <domain> <tunnel-name>");
    process.exit(1);
  }
  return state;
}

// ── Cloudflared config ────────────────────────────────────────────────────────

export function buildConfigYaml(state: State): string {
  const credentialsFile = join(APP_DIR, `${state.tunnelId}.json`);
  if (state.mappings.length === 0) {
    return `tunnel: ${state.tunnelId}
credentials-file: ${credentialsFile}

ingress:
  - service: http_status:404
`;
  }
  const ingressLines = state.mappings
    .map(({ subdomain, port }) =>
      `  - hostname: ${subdomain}.${state.domain}\n    service: http://localhost:${port}`
    )
    .join("\n");
  return `tunnel: ${state.tunnelId}
credentials-file: ${credentialsFile}

ingress:
${ingressLines}
  - service: http_status:404
`;
}

function writeConfig(state: State): void {
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, buildConfigYaml(state));
}

// ── DNS ───────────────────────────────────────────────────────────────────────

function ensureDns(state: State, subdomain: string): void {
  const hostname = `${subdomain}.${state.domain}`;
  process.stdout.write(`  DNS ${hostname} ... `);

  const result = spawnSync(
    CLOUDFLARED,
    ["tunnel", "route", "dns", "--overwrite-dns", state.tunnelName, hostname],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    console.log("failed");
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }

  // cloudflared returns 0 even when the record exists and points to a different tunnel.
  // Detect this by checking for a tunnelID in the output that doesn't match ours.
  const output = result.stdout + result.stderr;
  const tunnelMatch = output.match(/tunnelID=([a-f0-9-]+)/i);
  if (tunnelMatch && tunnelMatch[1] !== state.tunnelId) {
    console.log("conflict");
    console.error(
      `\n  ${hostname} already routes to a different tunnel (${tunnelMatch[1].slice(0, 8)}...).` +
      `\n  Run this to adopt that tunnel:\n` +
      `\n    hoist adopt ${tunnelMatch[1]}\n`
    );
    process.exit(1);
  }

  console.log("ok");
}

// ── Process management ────────────────────────────────────────────────────────

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  return isNaN(pid) ? null : pid;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopTunnel(): boolean {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  return false;
}

function startTunnel(state: State): number {
  stopTunnel();
  if (!TEST_MODE) spawnSync("sleep", ["0.5"]);

  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(
    CLOUDFLARED,
    ["tunnel", "--config", CONFIG_FILE, "--loglevel", "debug", "run", state.tunnelName],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    }
  );

  child.unref();
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(child.pid));
  return child.pid!;
}

function tunnelStatus(): { running: boolean; pid: number | null } {
  const pid = readPid();
  if (!pid) return { running: false, pid: null };
  if (isRunning(pid)) return { running: true, pid };
  unlinkSync(PID_FILE);
  return { running: false, pid: null };
}

// ── Tunnel lookup ─────────────────────────────────────────────────────────────

interface TunnelInfo {
  id: string;
  name: string;
}

// ── Log parsing ───────────────────────────────────────────────────────────────

// Parses a cloudflared debug log line into a request or response event.
// Request:  "DBG GET https://host/path HTTP/1.1 ... path=/foo"
// Response: "DBG 200 OK ... originService=http://localhost:PORT"
export function parseLogLine(line: string): LogEvent | null {
  const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(\w+)\s+(.+)$/);
  if (!tsMatch) return null;

  const [, ts, , rest] = tsMatch;
  const time = ts.slice(11, 19);

  const reqMatch = rest.match(
    /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+https?:\/\/([^/\s]+)(\/[^\s]*)?/
  );
  if (reqMatch) {
    return {
      type: "req",
      time,
      method: reqMatch[1]!,
      host: reqMatch[2]!,
      path: reqMatch[3] ?? "/",
    };
  }

  const resMatch = rest.match(/^(\d{3})\s+\S+/);
  if (resMatch) {
    return { type: "res", time, status: parseInt(resMatch[1]!, 10) };
  }

  return null;
}

// ── Display ───────────────────────────────────────────────────────────────────

function statusColor(status: number): string {
  if (status < 300) return "\x1b[32m";
  if (status < 400) return "\x1b[33m";
  return "\x1b[31m";
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function renderHeader(state: State): void {
  const { running, pid } = tunnelStatus();
  const cols = process.stdout.columns ?? 72;
  const line = "─".repeat(cols);

  console.clear();
  console.log(`${BOLD}tunnel${RESET}  ${state.tunnelName}  ${DIM}(${state.tunnelId.slice(0, 8)}...)${RESET}`);
  console.log(line);
  for (const { subdomain, port } of state.mappings) {
    const url = `https://${subdomain}.${state.domain}`;
    console.log(`  ${BOLD}${url}${RESET}  ${DIM}-> localhost:${port}${RESET}`);
  }
  const statusLabel = running
    ? `\x1b[32monline${RESET}  ${DIM}pid ${pid}${RESET}`
    : `\x1b[31mstopped${RESET}`;
  console.log(`\n  ${statusLabel}`);
  console.log(line);
  console.log(`${DIM}  time      method  path                             status  host${RESET}`);
  console.log(line);
}

// ── Commands ──────────────────────────────────────────────────────────────────

// Creates a new tunnel, writes credentials to APP_DIR/<tunnelId>.json,
// and returns the tunnel ID.
function createTunnel(tunnelName: string): string {
  const tmpCredFile = join(APP_DIR, "creds-tmp.json");
  mkdirSync(APP_DIR, { recursive: true });

  const result = spawnSync(
    CLOUDFLARED,
    ["tunnel", "create", tunnelName, "--credentials-file", tmpCredFile],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    console.error(`Failed to create tunnel "${tunnelName}".`);
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }

  const creds = JSON.parse(readFileSync(tmpCredFile, "utf8")) as {
    TunnelID?: string;
    tunnelID?: string;
    id?: string;
  };
  const tunnelId = (creds.TunnelID ?? creds.tunnelID ?? creds.id)!;

  // Rename to <tunnelId>.json so buildConfigYaml can find it
  renameSync(tmpCredFile, join(APP_DIR, `${tunnelId}.json`));
  return tunnelId;
}

function cmdInit(args: string[]): void {
  const [domain, tunnelName = "hoist"] = args;
  if (!domain) {
    console.error("Usage: hoist init <domain> [tunnel-name]");
    process.exit(1);
  }

  // Step 1: Cloudflare login (skip if already logged in)
  console.log("Step 1/3: Cloudflare login");
  const certPath = join(homedir(), ".cloudflared", "cert.pem");
  if (existsSync(certPath)) {
    console.log("  Already logged in");
  } else {
    const loginResult = spawnSync(
      CLOUDFLARED,
      ["tunnel", "login"],
      { stdio: "inherit" }
    );
    if (loginResult.status !== 0) {
      console.error("Login failed.");
      process.exit(1);
    }
  }

  // Step 2: Find or create the tunnel
  console.log(`\nStep 2/3: Setting up tunnel "${tunnelName}"`);
  let tunnelId: string;

  const listResult = spawnSync(
    CLOUDFLARED,
    ["tunnel", "list", "--output", "json"],
    { encoding: "utf8" }
  );

  if (listResult.status === 0) {
    const tunnels = JSON.parse(listResult.stdout) as TunnelInfo[];
    const existing = tunnels.find((t) => t.name === tunnelName);
    if (existing) {
      tunnelId = existing.id;
      console.log(`  Using existing tunnel: ${tunnelId.slice(0, 8)}...`);
    } else {
      console.log(`  Creating tunnel "${tunnelName}"...`);
      tunnelId = createTunnel(tunnelName);
      console.log(`  Created: ${tunnelId.slice(0, 8)}...`);
    }
  } else {
    console.log(`  Creating tunnel "${tunnelName}"...`);
    tunnelId = createTunnel(tunnelName);
    console.log(`  Created: ${tunnelId.slice(0, 8)}...`);
  }

  // Step 3: Save config
  console.log("\nStep 3/3: Saving configuration");
  const state: State = { domain, tunnelName, tunnelId, mappings: [] };
  saveState(state);
  writeConfig(state);

  console.log(`\nReady!`);
  console.log(`  Tunnel: ${tunnelName} (${tunnelId.slice(0, 8)}...)`);
  console.log(`  Domain: ${domain}`);
  console.log("\nNext: hoist <subdomain> <port>");
}

function cmdShare(args: (string | undefined)[]): void {
  const [subdomain, portRaw] = args;
  const port = Number(portRaw);

  if (!subdomain || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Usage: hoist <subdomain> <port>");
    process.exit(1);
  }

  const state = requireState();

  ensureDns(state, subdomain);

  const existing = state.mappings.find((m) => m.subdomain === subdomain);
  if (existing) {
    existing.port = port;
  } else {
    state.mappings.push({ subdomain, port });
    state.mappings.sort((a, b) => a.subdomain.localeCompare(b.subdomain));
  }

  saveState(state);
  writeConfig(state);
  startTunnel(state);

  if (TEST_MODE) return;

  spawnSync("sleep", ["2"]);
  cmdWatch({ filterHost: `${subdomain}.${state.domain}`, stopOnExit: true });
}

function cmdRm(args: string[]): void {
  const [subdomain] = args;
  if (!subdomain) {
    console.error("Usage: hoist rm <subdomain>");
    process.exit(1);
  }

  const state = requireState();
  const before = state.mappings.length;
  state.mappings = state.mappings.filter((m) => m.subdomain !== subdomain);

  if (state.mappings.length === before) {
    console.error(`No mapping for "${subdomain}"`);
    process.exit(1);
  }

  saveState(state);
  writeConfig(state);

  if (state.mappings.length > 0) {
    startTunnel(state);
    console.log(`Removed ${subdomain}.${state.domain}`);
  } else {
    stopTunnel();
    console.log(`Removed ${subdomain}.${state.domain} — no active mappings, tunnel stopped`);
  }
}

function cmdLs(): void {
  const state = requireState();
  const { running, pid } = tunnelStatus();

  if (state.mappings.length === 0) {
    console.log("No active mappings.");
  } else {
    const maxLen = Math.max(
      ...state.mappings.map((m) => m.subdomain.length + state.domain.length + 1)
    );
    for (const { subdomain, port } of state.mappings) {
      const hostname = `${subdomain}.${state.domain}`;
      console.log(`${hostname.padEnd(maxLen + 2)} -> localhost:${port}`);
    }
  }

  console.log("");
  console.log(running ? `tunnel  running (pid ${pid})` : "tunnel  stopped");
}

function cmdStatus(): void {
  const state = requireState();
  const { running, pid } = tunnelStatus();

  console.log(`domain   ${state.domain}`);
  console.log(`tunnel   ${state.tunnelName} (${state.tunnelId.slice(0, 8)}...)`);
  console.log(`process  ${running ? `running (pid ${pid})` : "stopped"}`);
  console.log(`config   ${CONFIG_FILE}`);
  console.log(`state    ${STATE_FILE}`);
}

function cmdStop(): void {
  const stopped = stopTunnel();
  console.log(stopped ? "Tunnel stopped." : "Tunnel was not running.");
}

function cmdRun(): void {
  const state = requireState();
  writeConfig(state);
  console.log(`Starting tunnel: ${state.tunnelName}`);
  console.log("Press Ctrl-C to stop.\n");

  const result = spawnSync(
    CLOUDFLARED,
    ["tunnel", "--config", CONFIG_FILE, "run", state.tunnelName],
    { stdio: "inherit" }
  );

  process.exit(result.status ?? 0);
}

function cmdWatch({ filterHost = null as string | null, stopOnExit = false } = {}): void {
  const state = requireState();

  if (!existsSync(LOG_FILE)) {
    console.error("No log file yet. Run: hoist <subdomain> <port>");
    process.exit(1);
  }

  renderHeader(state);

  let pending: (LogEvent & { type: "req" }) | null = null;

  const tail = spawn("tail", ["-f", "-n", "200", LOG_FILE], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const rl = createInterface({ input: tail.stdout! });

  rl.on("line", (line: string) => {
    const event = parseLogLine(line);
    if (!event) return;

    if (event.type === "req") {
      if (filterHost && event.host !== filterHost) return;
      pending = event;
    } else if (event.type === "res" && pending) {
      const color = statusColor(event.status);
      const method = pending.method.padEnd(7);
      const path =
        pending.path.length > 40
          ? pending.path.slice(0, 37) + "..."
          : pending.path.padEnd(40);
      const statusStr = `${color}${BOLD}${event.status}${RESET}`;
      const host = `${DIM}${pending.host}${RESET}`;
      console.log(`  ${DIM}${event.time}${RESET}  ${method} ${path}  ${statusStr}  ${host}`);
      pending = null;
    }
  });

  process.on("SIGINT", () => {
    tail.kill();
    if (stopOnExit) {
      stopTunnel();
      console.log("\nTunnel stopped.");
    } else {
      console.log("\n");
    }
    process.exit(0);
  });
}

function cmdLogs(): void {
  if (!existsSync(LOG_FILE)) {
    console.error("No log file yet. Run: hoist <subdomain> <port>");
    process.exit(1);
  }

  let pending: (LogEvent & { type: "req" }) | null = null;

  const tail = spawn("tail", ["-f", "-n", "500", LOG_FILE], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const rl = createInterface({ input: tail.stdout! });

  rl.on("line", (line: string) => {
    const event = parseLogLine(line);
    if (!event) return;

    if (event.type === "req") {
      pending = event;
    } else if (event.type === "res" && pending) {
      const color = statusColor(event.status);
      const method = pending.method.padEnd(6);
      const statusStr = `${color}${BOLD}${event.status}${RESET}`;
      const host = `${DIM}${pending.host}${RESET}`;
      console.log(`${event.time}  ${method} ${pending.path}  ${statusStr}  ${host}`);
      pending = null;
    }
  });

  process.on("SIGINT", () => {
    tail.kill();
    process.exit(0);
  });
}

// Adopts an existing Cloudflare tunnel by ID or name, replacing the current
// hoist tunnel. Use when DNS already points to a different tunnel.
function cmdAdopt(args: string[]): void {
  const [tunnelRef] = args;
  if (!tunnelRef) {
    console.error("Usage: hoist adopt <tunnel-id-or-name>");
    process.exit(1);
  }

  const currentState = loadState();
  if (!currentState) {
    console.error("No domain configured. Run: hoist init <domain>");
    process.exit(1);
  }

  console.log(`Looking up tunnel "${tunnelRef}"...`);

  const listResult = spawnSync(
    CLOUDFLARED,
    ["tunnel", "list", "--output", "json"],
    { encoding: "utf8" }
  );

  if (listResult.status !== 0) {
    console.error("Failed to list tunnels.");
    console.error(listResult.stderr || listResult.stdout);
    process.exit(1);
  }

  const tunnels = JSON.parse(listResult.stdout) as TunnelInfo[];
  const tunnel = tunnels.find(
    (t) => t.id === tunnelRef || t.id.startsWith(tunnelRef) || t.name === tunnelRef
  );

  if (!tunnel) {
    console.error(`Tunnel "${tunnelRef}" not found.`);
    console.error(`Your tunnels: ${tunnels.map((t) => `${t.name} (${t.id.slice(0, 8)}...)`).join(", ")}`);
    process.exit(1);
  }

  // Copy credentials from ~/.cloudflared if present
  const srcCreds = join(homedir(), ".cloudflared", `${tunnel.id}.json`);
  const dstCreds = join(APP_DIR, `${tunnel.id}.json`);
  if (existsSync(srcCreds) && !existsSync(dstCreds)) {
    mkdirSync(APP_DIR, { recursive: true });
    copyFileSync(srcCreds, dstCreds);
  }

  if (!existsSync(dstCreds)) {
    console.error(`Credentials not found at ${dstCreds}`);
    console.error(`Copy them manually: cp ~/.cloudflared/${tunnel.id}.json ${dstCreds}`);
    process.exit(1);
  }

  const state: State = {
    domain: currentState.domain,
    tunnelName: tunnel.name,
    tunnelId: tunnel.id,
    mappings: currentState.mappings,
  };

  saveState(state);
  writeConfig(state);

  if (currentState.mappings.length > 0) {
    startTunnel(state);
    console.log(`Adopted tunnel: ${tunnel.name} (${tunnel.id.slice(0, 8)}...)`);
    console.log(`Restarted with ${currentState.mappings.length} existing mapping(s).`);
  } else {
    console.log(`Adopted tunnel: ${tunnel.name} (${tunnel.id.slice(0, 8)}...)`);
    console.log(`Run: hoist <subdomain> <port>`);
  }
}

function printHelp(): void {
  console.log(`hoist <subdomain> <port>   expose localhost:<port> at https://<subdomain>.<domain>
hoist rm <subdomain>       remove a mapping
hoist ls                   list active mappings and tunnel status
hoist status               show tunnel configuration
hoist stop                 stop the tunnel process
hoist run                  run tunnel in foreground (for debugging)
hoist watch                live request view with tunnel header (like ngrok)
hoist logs                 plain request log tail
hoist init <domain>        one-time setup: login + create tunnel + configure
hoist adopt <tunnel-id>    switch to an existing tunnel (use when DNS conflict on init)`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  CLOUDFLARED = resolveCloudflared();

  const [first, ...rest] = process.argv.slice(2);

  const COMMANDS = new Set([
    "init", "adopt", "add", "rm", "ls", "logs", "watch", "status", "stop", "run", "help",
  ]);

  if (!first) {
    printHelp();
  } else if (!COMMANDS.has(first)) {
    cmdShare([first, rest[0]]);
  } else {
    switch (first) {
      case "init":   cmdInit(rest);  break;
      case "adopt":  cmdAdopt(rest); break;
      case "add":    cmdShare(rest); break;
      case "rm":     cmdRm(rest);    break;
      case "ls":     cmdLs();        break;
      case "status": cmdStatus();    break;
      case "watch":  cmdWatch();     break;
      case "logs":   cmdLogs();      break;
      case "stop":   cmdStop();      break;
      case "run":    cmdRun();       break;
      default:       printHelp();
    }
  }
}

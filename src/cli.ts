#!/usr/bin/env bun

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  openSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

// ── Paths ─────────────────────────────────────────────────────────────────────
// HOIST_DIR overrides ~/.hoist for isolated test runs
// CLOUDFLARED_BIN overrides the cloudflared binary path (use mock in tests)
// HOIST_TEST_MODE=1 skips the watch view after starting a tunnel

const APP_DIR = process.env.HOIST_DIR ?? join(homedir(), ".hoist");
const STATE_FILE = join(APP_DIR, "state.json");
const PID_FILE = join(APP_DIR, "cloudflared.pid");
const LOG_FILE = join(APP_DIR, "cloudflared.log");
const CONFIG_FILE = join(APP_DIR, "config.yml");
const CLOUDFLARED = process.env.CLOUDFLARED_BIN ?? "cloudflared";
const TEST_MODE = process.env.HOIST_TEST_MODE === "1";

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

function buildConfigYaml(state: State): string {
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

function requireCloudflared(): void {
  if (process.env.CLOUDFLARED_BIN) return; // test mode — mock provided directly
  const result = spawnSync("which", ["cloudflared"], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error("cloudflared not found. Install: brew install cloudflared");
    process.exit(1);
  }
}

function ensureDns(state: State, subdomain: string): void {
  const hostname = `${subdomain}.${state.domain}`;
  process.stdout.write(`  DNS ${hostname} ... `);

  const result = spawnSync(
    CLOUDFLARED,
    ["tunnel", "route", "dns", state.tunnelName, hostname],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    // cloudflared returns non-zero for "already exists" (our own record) — treat as non-fatal
    // BUT "already exists with a different value" means a conflicting record — treat as fatal
    const output = (result.stdout + result.stderr).toLowerCase();
    const isOwnRecord =
      (output.includes("already") || output.includes("exists")) &&
      !output.includes("different");
    if (isOwnRecord) {
      console.log("exists");
    } else {
      console.log("failed");
      console.error(result.stderr || result.stdout);
      process.exit(1);
    }
  } else {
    console.log("ok");
  }
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
  requireCloudflared();

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

function resolveTunnelId(tunnelName: string): string {
  const result = spawnSync(
    CLOUDFLARED,
    ["tunnel", "list", "--output", "json"],
    { encoding: "utf8" }
  );

  if ((result.error as NodeJS.ErrnoException)?.code === "ENOENT") {
    console.error("cloudflared not found. Install: brew install cloudflared");
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error("Failed to list tunnels. Have you run: cloudflared tunnel login?");
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }

  let tunnels: TunnelInfo[];
  try {
    tunnels = JSON.parse(result.stdout) as TunnelInfo[];
  } catch {
    console.error("Could not parse cloudflared tunnel list output.");
    process.exit(1);
  }

  const tunnel = tunnels.find((t) => t.name === tunnelName || t.id === tunnelName);
  if (!tunnel) {
    const names = tunnels.map((t) => t.name).join(", ");
    console.error(`Tunnel "${tunnelName}" not found. Available: ${names}`);
    process.exit(1);
  }

  return tunnel.id;
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
      method: reqMatch[1],
      host: reqMatch[2],
      path: reqMatch[3] ?? "/",
    };
  }

  const resMatch = rest.match(/^(\d{3})\s+\S+/);
  if (resMatch) {
    return { type: "res", time, status: parseInt(resMatch[1], 10) };
  }

  return null;
}

// ── Config YAML builder (exported for unit tests) ─────────────────────────────

export { buildConfigYaml };

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

function cmdInit(args: string[]): void {
  const [domain, tunnelName] = args;
  if (!domain || !tunnelName) {
    console.error("Usage: hoist init <domain> <tunnel-name>");
    process.exit(1);
  }

  requireCloudflared();
  process.stdout.write(`Looking up tunnel "${tunnelName}" ... `);
  const tunnelId = resolveTunnelId(tunnelName);
  console.log(`found (${tunnelId.slice(0, 8)}...)`);

  const state: State = { domain, tunnelName, tunnelId, mappings: [] };
  saveState(state);
  writeConfig(state);

  console.log(`\nReady. Tunnel: ${tunnelName} on ${domain}`);
  console.log("Next: hoist <subdomain> <port>");
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

function printHelp(): void {
  console.log(`hoist <subdomain> <port>   expose localhost:<port> at https://<subdomain>.<domain>
hoist rm <subdomain>       remove a mapping
hoist ls                   list active mappings and tunnel status
hoist status               show tunnel configuration
hoist stop                 stop the tunnel process
hoist run                  run tunnel in foreground (for debugging)
hoist watch                live request view with tunnel header (like ngrok)
hoist logs                 plain request log tail
hoist init <domain> <name> one-time setup with your Cloudflare tunnel`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [first, ...rest] = process.argv.slice(2);

  const COMMANDS = new Set([
    "init", "add", "rm", "ls", "logs", "watch", "status", "stop", "run", "help",
  ]);

  if (!first) {
    printHelp();
  } else if (!COMMANDS.has(first)) {
    cmdShare([first, rest[0]]);
  } else {
    switch (first) {
      case "init":   cmdInit(rest);  break;
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

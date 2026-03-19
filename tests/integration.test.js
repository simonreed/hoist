// Integration tests — real filesystem, mock cloudflared
// Run: bun test tests/integration.test.js

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

// ── Test environment setup ────────────────────────────────────────────────────

const MOCK_CF = join(import.meta.dir, "fixtures/cloudflared-mock");
const CLI = join(import.meta.dir, "../src/cli.ts");
const BUN = process.execPath; // path to the bun binary running this test

function tempDir() {
  const dir = join(tmpdir(), `hoist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(args, { hoistDir, mode = "success", env = {} } = {}) {
  return spawnSync(
    BUN,
    [CLI, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOIST_DIR: hoistDir,              // override ~/.hoist for isolation
        CLOUDFLARED_BIN: MOCK_CF,         // use mock cloudflared
        MOCK_CF_MODE: mode,
        ...env,
      },
    }
  );
}

// Each test gets an isolated HOIST_DIR so state never bleeds between tests
let hoistDir;

beforeEach(() => {
  hoistDir = tempDir();
});

afterEach(() => {
  rmSync(hoistDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeState(hoistDir, state) {
  mkdirSync(hoistDir, { recursive: true });
  writeFileSync(join(hoistDir, "state.json"), JSON.stringify(state, null, 2));
}

function readState(hoistDir) {
  return JSON.parse(readFileSync(join(hoistDir, "state.json"), "utf8"));
}

const baseState = {
  domain: "simonreed.co",
  tunnelName: "hoist-dev",
  tunnelId: "mock-tunnel-id",
  mappings: [],
};

// ── No state ──────────────────────────────────────────────────────────────────

describe("hoist with no state", () => {
  test("hoist passflow 5555 exits 1 with helpful message", () => {
    const result = runCli(["passflow", "5555"], { hoistDir });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("hoist init");
  });

  test("hoist ls exits 1 with helpful message", () => {
    const result = runCli(["ls"], { hoistDir });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("hoist init");
  });

  test("hoist rm exits 1 with helpful message", () => {
    const result = runCli(["rm", "passflow"], { hoistDir });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("hoist init");
  });

  test("hoist stop exits 0 with 'not running' message", () => {
    const result = runCli(["stop"], { hoistDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not running");
  });

  test("hoist (no args) prints help and exits 0", () => {
    const result = runCli([], { hoistDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("hoist <subdomain> <port>");
  });
});

// ── init ──────────────────────────────────────────────────────────────────────

describe("hoist init", () => {
  test("creates state.json with correct structure", () => {
    const result = runCli(["init", "simonreed.co", "hoist-dev"], { hoistDir });
    expect(result.status).toBe(0);
    const state = readState(hoistDir);
    expect(state.domain).toBe("simonreed.co");
    expect(state.tunnelName).toBe("hoist-dev");
    expect(state.tunnelId).toBe("mock-tunnel-id");
    expect(state.mappings).toEqual([]);
  });

  test("writes config.yml with 404 catch-all", () => {
    runCli(["init", "simonreed.co", "hoist-dev"], { hoistDir });
    const config = readFileSync(join(hoistDir, "config.yml"), "utf8");
    expect(config).toContain("tunnel: mock-tunnel-id");
    expect(config).toContain("service: http_status:404");
    expect(config).not.toContain("hostname:");
  });

  test("fails with missing args", () => {
    const result = runCli(["init"], { hoistDir });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });

  test("fails when tunnel not found", () => {
    const result = runCli(["init", "simonreed.co", "nonexistent-tunnel"], {
      hoistDir,
      mode: "no-tunnels",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not found");
  });
});

// ── hoist <subdomain> <port> ──────────────────────────────────────────────────

describe("hoist <subdomain> <port>", () => {
  beforeEach(() => {
    writeState(hoistDir, baseState);
  });

  test("adds mapping to state.json", () => {
    // We need to prevent the watch view from blocking — set a flag to skip it in test mode
    const result = runCli(["passflow", "5555"], { hoistDir, env: { HOIST_TEST_MODE: "1" } });
    expect(result.status).toBe(0);
    const state = readState(hoistDir);
    expect(state.mappings).toContainEqual({ subdomain: "passflow", port: 5555 });
  });

  test("updates existing mapping with new port", () => {
    writeState(hoistDir, {
      ...baseState,
      mappings: [{ subdomain: "passflow", port: 5555 }],
    });
    runCli(["passflow", "4444"], { hoistDir, env: { HOIST_TEST_MODE: "1" } });
    const state = readState(hoistDir);
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0].port).toBe(4444);
  });

  test("multiple subdomains accumulate in state", () => {
    runCli(["passflow", "5555"], { hoistDir, env: { HOIST_TEST_MODE: "1" } });
    runCli(["assay", "3000"], { hoistDir, env: { HOIST_TEST_MODE: "1" } });
    const state = readState(hoistDir);
    expect(state.mappings).toHaveLength(2);
    expect(state.mappings.map((m) => m.subdomain).sort()).toEqual(["assay", "passflow"]);
  });

  test("mappings stay sorted alphabetically", () => {
    runCli(["zebra", "9999"], { hoistDir, env: { HOIST_TEST_MODE: "1" } });
    runCli(["alpha", "1111"], { hoistDir, env: { HOIST_TEST_MODE: "1" } });
    runCli(["middle", "5555"], { hoistDir, env: { HOIST_TEST_MODE: "1" } });
    const state = readState(hoistDir);
    const names = state.mappings.map((m) => m.subdomain);
    expect(names).toEqual([...names].sort());
  });

  test("invalid port exits 1", () => {
    const result = runCli(["passflow", "notaport"], { hoistDir });
    expect(result.status).toBe(1);
  });

  test("port 0 exits 1", () => {
    const result = runCli(["passflow", "0"], { hoistDir });
    expect(result.status).toBe(1);
  });

  test("port 65536 exits 1", () => {
    const result = runCli(["passflow", "65536"], { hoistDir });
    expect(result.status).toBe(1);
  });

  test("DNS conflict exits 1 with clear error", () => {
    const result = runCli(["passflow", "5555"], {
      hoistDir,
      mode: "dns-conflict",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("failed");
  });

  test("DNS exists (idempotent) continues successfully", () => {
    const result = runCli(["passflow", "5555"], {
      hoistDir,
      mode: "dns-exists",
      env: { HOIST_TEST_MODE: "1" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("exists");
  });

  test("writes config.yml with mapping", () => {
    runCli(["passflow", "5555"], { hoistDir, env: { HOIST_TEST_MODE: "1" } });
    const config = readFileSync(join(hoistDir, "config.yml"), "utf8");
    expect(config).toContain("hostname: passflow.simonreed.co");
    expect(config).toContain("service: http://localhost:5555");
  });
});

// ── hoist rm ──────────────────────────────────────────────────────────────────

describe("hoist rm", () => {
  test("removes mapping from state", () => {
    writeState(hoistDir, {
      ...baseState,
      mappings: [
        { subdomain: "passflow", port: 5555 },
        { subdomain: "assay", port: 3000 },
      ],
    });
    runCli(["rm", "assay"], { hoistDir });
    const state = readState(hoistDir);
    expect(state.mappings).toHaveLength(1);
    expect(state.mappings[0].subdomain).toBe("passflow");
  });

  test("exits 1 when subdomain not found", () => {
    writeState(hoistDir, { ...baseState, mappings: [] });
    const result = runCli(["rm", "nonexistent"], { hoistDir });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No mapping for");
  });

  test("exits 1 with no arg", () => {
    writeState(hoistDir, baseState);
    const result = runCli(["rm"], { hoistDir });
    expect(result.status).toBe(1);
  });

  test("removing last mapping produces 'tunnel stopped' message", () => {
    writeState(hoistDir, {
      ...baseState,
      mappings: [{ subdomain: "passflow", port: 5555 }],
    });
    const result = runCli(["rm", "passflow"], { hoistDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stopped");
  });

  test("config.yml updated after rm", () => {
    writeState(hoistDir, {
      ...baseState,
      mappings: [
        { subdomain: "passflow", port: 5555 },
        { subdomain: "assay", port: 3000 },
      ],
    });
    runCli(["rm", "assay"], { hoistDir });
    const config = readFileSync(join(hoistDir, "config.yml"), "utf8");
    expect(config).not.toContain("assay.simonreed.co");
    expect(config).toContain("passflow.simonreed.co");
  });
});

// ── hoist ls ──────────────────────────────────────────────────────────────────

describe("hoist ls", () => {
  test("shows all mappings", () => {
    writeState(hoistDir, {
      ...baseState,
      mappings: [
        { subdomain: "passflow", port: 5555 },
        { subdomain: "assay", port: 3000 },
      ],
    });
    const result = runCli(["ls"], { hoistDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("passflow.simonreed.co");
    expect(result.stdout).toContain("5555");
    expect(result.stdout).toContain("assay.simonreed.co");
    expect(result.stdout).toContain("3000");
  });

  test("empty state shows 'No active mappings'", () => {
    writeState(hoistDir, { ...baseState, mappings: [] });
    const result = runCli(["ls"], { hoistDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No active mappings");
  });

  test("shows tunnel stopped when no pid file", () => {
    writeState(hoistDir, baseState);
    const result = runCli(["ls"], { hoistDir });
    expect(result.stdout).toContain("stopped");
  });
});

// ── hoist status ──────────────────────────────────────────────────────────────

describe("hoist status", () => {
  test("shows domain and tunnel name", () => {
    writeState(hoistDir, baseState);
    const result = runCli(["status"], { hoistDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("simonreed.co");
    expect(result.stdout).toContain("hoist-dev");
  });
});

// ── stale PID recovery ────────────────────────────────────────────────────────

describe("stale PID recovery", () => {
  test("stale pid file is cleaned up on hoist passflow", () => {
    writeState(hoistDir, baseState);
    // Write a PID that doesn't exist
    writeFileSync(join(hoistDir, "cloudflared.pid"), "999999999");

    const result = runCli(["passflow", "5555"], {
      hoistDir,
      env: { HOIST_TEST_MODE: "1" },
    });
    expect(result.status).toBe(0);
    // New pid file should exist with a real PID
    const newPid = parseInt(readFileSync(join(hoistDir, "cloudflared.pid"), "utf8").trim());
    expect(newPid).not.toBe(999999999);
  });

  test("ls shows stopped with stale pid", () => {
    writeState(hoistDir, { ...baseState, mappings: [{ subdomain: "passflow", port: 5555 }] });
    writeFileSync(join(hoistDir, "cloudflared.pid"), "999999999");
    const result = runCli(["ls"], { hoistDir });
    expect(result.stdout).toContain("stopped");
  });
});

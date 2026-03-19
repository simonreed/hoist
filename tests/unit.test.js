// Unit tests — pure logic, zero external dependencies
// Run: bun test tests/unit.test.js

import { describe, test, expect } from "bun:test";
import { parseLogLine, buildConfigYaml } from "../src/cli.ts";

// ── parseLogLine ──────────────────────────────────────────────────────────────

describe("parseLogLine", () => {
  test("parses GET request line", () => {
    const line =
      "2026-03-19T10:16:24Z DBG GET https://passflow.simonreed.co/api/users HTTP/1.1 " +
      "connIndex=2 content-length=0 event=1 headers={} host=passflow.simonreed.co " +
      "ingressRule=0 originService=http://localhost:5555 path=/api/users";
    const event = parseLogLine(line);
    expect(event).toEqual({
      type: "req",
      time: "10:16:24",
      method: "GET",
      host: "passflow.simonreed.co",
      path: "/api/users",
    });
  });

  test("parses POST request line", () => {
    const line =
      "2026-03-19T10:16:25Z DBG POST https://passflow.simonreed.co/api/sessions HTTP/1.1 " +
      "connIndex=0 event=1 host=passflow.simonreed.co path=/api/sessions";
    const event = parseLogLine(line);
    expect(event?.method).toBe("POST");
    expect(event?.path).toBe("/api/sessions");
  });

  test("parses 200 response line", () => {
    const line =
      "2026-03-19T10:16:24Z DBG 200 OK connIndex=2 content-length=-1 event=1 " +
      "ingressRule=0 originService=http://localhost:5555";
    const event = parseLogLine(line);
    expect(event).toEqual({ type: "res", time: "10:16:24", status: 200 });
  });

  test("parses 404 response", () => {
    const line = "2026-03-19T10:16:24Z DBG 404 Not Found connIndex=0 event=1 originService=http://localhost:3000";
    expect(parseLogLine(line)?.status).toBe(404);
  });

  test("parses 502 response", () => {
    const line = "2026-03-19T10:16:24Z DBG 502 Bad Gateway connIndex=0 event=1";
    expect(parseLogLine(line)?.status).toBe(502);
  });

  test("returns null for non-request/response lines", () => {
    const line = "2026-03-19T10:16:20Z INF Registered tunnel connection connIndex=0 location=lhr01";
    expect(parseLogLine(line)).toBeNull();
  });

  test("returns null for empty line", () => {
    expect(parseLogLine("")).toBeNull();
  });

  test("returns null for garbage", () => {
    expect(parseLogLine("not a log line at all")).toBeNull();
  });

  test("parses root path correctly", () => {
    const line =
      "2026-03-19T10:16:24Z DBG GET https://assay.simonreed.co/ HTTP/1.1 " +
      "connIndex=0 event=1 path=/";
    const event = parseLogLine(line);
    expect(event?.path).toBe("/");
  });

  test("parses path with query string — takes full path segment", () => {
    const line =
      "2026-03-19T10:16:24Z DBG GET https://passflow.simonreed.co/search?q=foo HTTP/1.1 " +
      "connIndex=0 event=1 path=/search";
    const event = parseLogLine(line);
    // The regex captures up to whitespace — query string is part of the URL segment
    expect(event?.path).toBe("/search?q=foo");
  });

  test("extracts correct time component", () => {
    const line = "2026-03-19T23:59:59Z DBG 200 OK connIndex=0 event=1";
    expect(parseLogLine(line)?.time).toBe("23:59:59");
  });

  // Contract test: verify against real cloudflared debug output format
  // This is the canonical sample from cloudflared 2026.3.0
  test("CONTRACT: matches real cloudflared 2026.3.0 request log format", () => {
    const realLine =
      "2026-03-19T10:16:24Z DBG GET https://passflow.simonreed.co/api/users HTTP/1.1 " +
      'connIndex=2 content-length=0 event=1 headers={"Accept":["*/*"],"User-Agent":["curl/8.7.1"]} ' +
      "host=passflow.simonreed.co ingressRule=0 originService=http://localhost:5555 path=/api/users";
    const event = parseLogLine(realLine);
    expect(event?.type).toBe("req");
    expect(event?.method).toBe("GET");
    expect(event?.host).toBe("passflow.simonreed.co");
    expect(event?.path).toBe("/api/users");
  });

  test("CONTRACT: matches real cloudflared 2026.3.0 response log format", () => {
    const realLine =
      "2026-03-19T10:16:24Z DBG 200 OK connIndex=2 content-length=-1 event=1 " +
      "ingressRule=0 originService=http://localhost:5555";
    const event = parseLogLine(realLine);
    expect(event?.type).toBe("res");
    expect(event?.status).toBe(200);
  });
});

// ── buildConfigYaml ───────────────────────────────────────────────────────────

describe("buildConfigYaml", () => {
  const baseState = {
    domain: "simonreed.co",
    tunnelName: "hoist-dev",
    tunnelId: "mock-tunnel-id",
    mappings: [],
  };

  test("empty mappings produces 404 catch-all only", () => {
    const yaml = buildConfigYaml(baseState);
    expect(yaml).toContain("ingress:");
    expect(yaml).toContain("service: http_status:404");
    expect(yaml).not.toContain("hostname:");
  });

  test("single mapping produces correct ingress entry", () => {
    const state = { ...baseState, mappings: [{ subdomain: "passflow", port: 5555 }] };
    const yaml = buildConfigYaml(state);
    expect(yaml).toContain("hostname: passflow.simonreed.co");
    expect(yaml).toContain("service: http://localhost:5555");
    expect(yaml).toContain("service: http_status:404");
  });

  test("multiple mappings all appear in order", () => {
    const state = {
      ...baseState,
      mappings: [
        { subdomain: "assay", port: 3000 },
        { subdomain: "passflow", port: 5555 },
      ],
    };
    const yaml = buildConfigYaml(state);
    const assayIdx = yaml.indexOf("assay.simonreed.co");
    const passflowIdx = yaml.indexOf("passflow.simonreed.co");
    const catchAllIdx = yaml.indexOf("http_status:404");
    expect(assayIdx).toBeGreaterThan(0);
    expect(passflowIdx).toBeGreaterThan(assayIdx);
    expect(catchAllIdx).toBeGreaterThan(passflowIdx);
  });

  test("catch-all is always the last ingress rule", () => {
    const state = {
      ...baseState,
      mappings: [
        { subdomain: "passflow", port: 5555 },
        { subdomain: "assay", port: 3000 },
        { subdomain: "membercanoe", port: 3009 },
      ],
    };
    const yaml = buildConfigYaml(state);
    const lines = yaml.trim().split("\n");
    expect(lines[lines.length - 1]).toBe("  - service: http_status:404");
  });

  test("tunnel id appears in credentials-file path", () => {
    const yaml = buildConfigYaml(baseState);
    expect(yaml).toContain("mock-tunnel-id");
  });
});

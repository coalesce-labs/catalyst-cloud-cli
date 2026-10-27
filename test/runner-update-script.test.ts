import { execFile } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESIRED_RELEASE_SCRIPT, UPDATE_DRAIN_SCRIPT } from "../src/runner-update";

const runNode = promisify(execFile);
const secret = "wire-secret-that-must-stay-in-the-container";

async function atWire(script: string, variables: Record<string, string> = {}) {
  const requests: Array<{ method: string; path: string; authorization: string | undefined; accept: string | undefined; contentType: string | undefined; report: string | undefined; body: string }> = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({ method: request.method ?? "", path: request.url ?? "", authorization: request.headers.authorization,
      accept: request.headers.accept, contentType: request.headers["content-type"], report: request.headers["x-catalyst-update-report"] as string | undefined, body });
    response.writeHead(variables.RESPONSE_STATUS ? Number(variables.RESPONSE_STATUS) : 200, { "content-type": "application/json", "retry-after": "5" });
    response.end(variables.RESPONSE_BODY ?? JSON.stringify({ ok: true, revision: 0, drain: null, liveGenerations: 0 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const dir = mkdtempSync(join(tmpdir(), "runner-update-wire-"));
  const credential = join(dir, "credential.json");
  writeFileSync(credential, JSON.stringify({ version: 1, secret, enrollment: { tenant: "tenant-a", hostId: "host_abc" } }));
  try {
    const { stdout } = await runNode(process.execPath, ["-e", script], { env: { ...process.env, CATALYST_HOST_CREDENTIAL_FILE: credential,
      CATALYST_MIRROR_URL: `http://127.0.0.1:${address.port}`, ...variables } });
    return { output: JSON.parse(stdout) as Record<string, unknown>, stdout, requests };
  } finally {
    server.close();
  }
}

describe("the in-container host scripts keep the credential inside Docker", () => {
  it("sends a same-run deferral report on the desired-release read", async () => {
    const report = JSON.stringify({ v: 1, outcome: "deferred_busy", applied: 102, offered: 106, detail: "phases_running:2,deferred_for_ms:900000" });
    const result = await atWire(DESIRED_RELEASE_SCRIPT, { CATALYST_UPDATE_REPORT: report });
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ method: "GET", path: "/api/v1/hosts/desired-release", report });
    expect(result.output).toMatchObject({ kind: "answered", status: 200, hostId: "host_abc" });
    expect(result.stdout).not.toContain(secret);
  });

  it("does not send a report over 512 characters", async () => {
    const result = await atWire(DESIRED_RELEASE_SCRIPT, { CATALYST_UPDATE_REPORT: "x".repeat(513) });
    expect(result.requests[0]?.report).toBeUndefined();
  });

  it("GET sends the host bearer and no body or content type", async () => {
    const result = await atWire(UPDATE_DRAIN_SCRIPT);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ method: "GET", path: "/api/v1/hosts/update-drain", accept: "application/json", body: "" });
    expect(result.requests[0]?.authorization).toBe(`Bearer ctc_host_${Buffer.from("tenant-a").toString("base64url")}.host_abc.${secret}`);
    expect(result.requests[0]?.contentType).toBeUndefined();
    expect(result.stdout).not.toContain(secret);
  });

  it.each([
    { action: "request", requestId: "d6b01f48-9f7e-4d13-8c4d-e99b8efcb360", expectedRevision: 0, generation: 106 },
    { action: "release", requestId: "d6b01f48-9f7e-4d13-8c4d-e99b8efcb360", expectedRevision: 1 },
  ])("POST sends the $action body byte for byte", async (body) => {
    const encoded = JSON.stringify(body);
    const result = await atWire(UPDATE_DRAIN_SCRIPT, { CATALYST_UPDATE_DRAIN_BODY: encoded });
    expect(result.requests[0]).toMatchObject({ method: "POST", path: "/api/v1/hosts/update-drain", contentType: "application/json", body: encoded });
    expect(result.stdout).not.toContain(secret);
  });

  it("preserves a service-unavailable answer", async () => {
    const body = { ok: false, refusal: "update_drain_unavailable" };
    const result = await atWire(UPDATE_DRAIN_SCRIPT, { RESPONSE_STATUS: "503", RESPONSE_BODY: JSON.stringify(body) });
    expect(result.output).toMatchObject({ kind: "answered", status: 503, body });
  });

  it("a missing credential file sends no request", async () => {
    const result = await atWire(UPDATE_DRAIN_SCRIPT, { CATALYST_HOST_CREDENTIAL_FILE: "/does/not/exist" });
    expect(result.output).toEqual({ kind: "no_credential" });
    expect(result.requests).toEqual([]);
  });

  it("a body over 512 bytes sends no request", async () => {
    const result = await atWire(UPDATE_DRAIN_SCRIPT, { CATALYST_UPDATE_DRAIN_BODY: "x".repeat(513) });
    expect(result.output).toMatchObject({ kind: "unreachable", detail: "body_too_large" });
    expect(result.requests).toEqual([]);
  });
});

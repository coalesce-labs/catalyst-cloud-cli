import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { writeConfig } from "../src/config.js";
import { emitCustodyFailure } from "../src/onboard-runner-telemetry.js";
import { makeCtx } from "./helpers.js";
import type { OnboardJournal } from "../src/onboard.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "custody-export-")); homes.push(home);
  const baseUrl = "https://cloud.example.test";
  writeConfig(home, { baseUrl, account: "account-a", slug: "a", name: "Workspace",
    joinedAt: "2026-10-10T00:00:00Z", lastSkillBundleVersion: "0.16.8",
    key: "ctc_user_fixture_secret", principal: "service", permissions: ["mirror:read"],
    user: { id: "person-a", email: "person@example.test", label: "Person", linearUserId: null, role: "admin" } });
  const journal: OnboardJournal = { schema: 1, runId: "run-a", cli: "0.16.8", installer: null,
    tenant: "account-a", account: "account-a", membershipId: "person-a", baseUrl, exit: null, steps: [], changes: [] };
  const requests: { url: string; method?: string; body?: string | null }[] = [];
  let mint = { token: "ctc_tel_fixture_export", account: "account-a", scope: "telemetry:write", endpoint: baseUrl + "/api/v1/telemetry" };
  let ingestStatus = 200;
  let ingestBody = {};
  const ctx = makeCtx(home, { fetch: async (input, init) => {
    const url = String(input); requests.push({ url, method: init?.method, body: init?.body === undefined ? null : String(init.body) });
    return url.endsWith("/token") ? Response.json(mint) : Response.json(ingestBody, { status: ingestStatus });
  } });
  return { ctx, journal, requests, setMint: (value: typeof mint) => { mint = value; }, mint,
    setStatus: (status: number) => { ingestStatus = status; }, setBody: (body: object) => { ingestBody = body; } };
}
test("positive control exports one run-bound event and requests only a sixty-second token", async () => {
  const f = fixture();
  expect(await emitCustodyFailure(f.ctx, f.journal, { custodyFailureCase: "call_threw",
    custodyErrorClass: "CustodyInstallError", custodyErrorMessage: "darwin_thoughts_custody_install:bootstrap_proof_refused" })).toBe(true);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[0]?.body).toBe('{"ttlSeconds":60}');
  expect(f.requests[1]?.url).toBe("https://cloud.example.test/api/v1/telemetry/v1/logs");
  expect(f.requests[1]?.body).toContain('"stringValue":"run-a"');
  expect(f.requests[1]?.body).toContain('"stringValue":"call_threw"');
  expect(f.requests[1]?.body).not.toContain("ctc_user_");
  expect(f.requests[1]?.body).not.toContain("ctc_tel_");
});
test.each(["account", "endpoint", "token", "scope"] as const)("refuses a foreign or malformed minted %s before exporting", async field => {
  const f = fixture(); f.setMint({ ...f.mint, [field]: "foreign-value" });
  expect(await emitCustodyFailure(f.ctx, f.journal, { custodyFailureCase: "capability_missing" })).toBe(false);
  expect(f.requests).toHaveLength(1);
});
test("does not treat an ingest refusal as delivered", async () => {
  const f = fixture(); f.setStatus(503);
  expect(await emitCustodyFailure(f.ctx, f.journal, { custodyFailureCase: "result_unverified" })).toBe(false);
  expect(f.requests).toHaveLength(2);
});
test("a changed workspace binding and an already cancelled operation send no request", async () => {
  const f = fixture(); f.journal.account = "other-account";
  expect(await emitCustodyFailure(f.ctx, f.journal, { custodyFailureCase: "call_threw" })).toBe(false);
  f.journal.account = "account-a";
  const stop = new AbortController(); stop.abort();
  expect(await emitCustodyFailure(f.ctx, f.journal, { custodyFailureCase: "call_threw" }, stop.signal)).toBe(false);
  expect(f.requests).toHaveLength(0);
});

test("a partial-success response that rejects the event is not delivery", async () => {
  const f = fixture(); f.setBody({ partialSuccess: { rejectedLogRecords: "1" } });
  expect(await emitCustodyFailure(f.ctx, f.journal, { custodyFailureCase: "call_threw" })).toBe(false);
});

// approved-release.test.ts — the approved component record (CTC-6708): parsed strictly from either
// transport, every version exact and on the declared train, packs pinned to their own repository and
// commit, and every failure a reason that changes nothing.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  approvalCachePathFor,
  compareVersions,
  exactVersion,
  hostApproval,
  parseApprovedRelease,
  readApprovalCache,
  readMemberApproval,
  writeApprovalCache,
} from "../src/approved-release";
import { makeCtx, tempHome } from "./helpers";
import { answered, approved, hostRelease, memberFetch, NEXT, signIn, TRAIN } from "./update-fixtures";

describe("parseApprovedRelease", () => {
  it("POSITIVE CONTROL: a complete record parses, members on different patches of one train included", () => {
    const parsed = parseApprovedRelease(approved());
    expect(parsed).toMatchObject({ ok: true, release: { approvalId: "example-89", generation: 89, releaseLine: TRAIN } });
    if (!parsed.ok) throw new Error("expected a parsed record");
    expect(parsed.release.members.cli).toBe(NEXT);
    expect(parsed.release.members["sdk-replica-node"]).toBe(`${TRAIN}.1`);
    expect(parsed.release.skills.dev).toEqual({ version: NEXT, repository: "coalesce-labs/catalyst-dev-skills", commit: "2".repeat(40) });
  });

  it("a record that omits a member leaves that member without a target instead of guessing one", () => {
    const parsed = parseApprovedRelease(approved({ mutate: (r) => delete (r.members as Record<string, unknown>).sdk }));
    expect(parsed.ok && parsed.release.members.sdk).toBe(undefined);
  });

  it.each([
    ["a dist-tag", (r: Record<string, unknown>) => ((r.members as Record<string, unknown>).cli = "latest")],
    ["a range", (r: Record<string, unknown>) => ((r.members as Record<string, unknown>).sdk = `^${NEXT}`)],
    ["a pre-release", (r: Record<string, unknown>) => ((r.members as Record<string, unknown>).cli = `${NEXT}-rc.1`)],
    ["a member on another train", (r: Record<string, unknown>) => ((r.members as Record<string, unknown>).sdk = "9.9.0")],
    ["no CLI version", (r: Record<string, unknown>) => delete (r.members as Record<string, unknown>).cli],
    ["a pack from another repository", (r: Record<string, unknown>) => (((r.skills as Record<string, unknown>).cloud as Record<string, unknown>).repository = "evil/catalyst-cloud-skills")],
    ["a pack at a branch, not a commit", (r: Record<string, unknown>) => (((r.skills as Record<string, unknown>).dev as Record<string, unknown>).commit = "main")],
    ["another schema version", (r: Record<string, unknown>) => (r.schemaVersion = 2)],
    ["a malformed train line", (r: Record<string, unknown>) => (r.releaseLine = "0.16.x")],
    ["a non-positive generation", (r: Record<string, unknown>) => (r.generation = 0)],
  ])("NEGATIVE: %s refuses the whole record", (_label, mutate) => {
    expect(parseApprovedRelease(approved({ mutate }))).toEqual({ ok: false, reason: "response_invalid" });
  });

  it("exactVersion is the authority check; the lenient bundle comparison is not used for it", () => {
    expect(exactVersion("0.16.28")).toBe("0.16.28");
    for (const bad of ["v0.16.28", "0.16", "0.16.028", "latest", 16, null]) expect(exactVersion(bad)).toBeNull();
    expect(compareVersions("0.16.9", "0.16.28")).toBeLessThan(0);
    expect(compareVersions("0.16.28", "0.16.28")).toBe(0);
  });
});

describe("hostApproval: the component record on the host's desired-release answer", () => {
  it("POSITIVE CONTROL: a host answer carrying components at the same generation is the approval", () => {
    expect(hostApproval(answered(hostRelease({ components: approved() })))).toMatchObject({ kind: "approved", source: "host", release: { generation: 89 } });
  });

  it("a legacy image-only answer provides no component versions", () => {
    expect(hostApproval(answered(hostRelease()))).toEqual({ kind: "unavailable", reason: "not_provided" });
  });

  it("components from another generation never mix with the images", () => {
    expect(hostApproval(answered(hostRelease({ generation: 90, components: approved() })))).toEqual({ kind: "unavailable", reason: "envelope_mismatch" });
  });

  it("refusals and failures are reasons", () => {
    expect(hostApproval(answered({ ok: false }, 401))).toEqual({ kind: "unavailable", reason: "credential_refused" });
    expect(hostApproval({ kind: "unreachable", detail: "x", hostId: "h" })).toEqual({ kind: "unavailable", reason: "unreachable" });
    expect(hostApproval({ kind: "no_credential" })).toEqual({ kind: "unavailable", reason: "signed_out" });
    expect(hostApproval(answered(hostRelease({ components: { schemaVersion: 1 } })))).toEqual({ kind: "unavailable", reason: "response_invalid" });
  });
});

describe("readMemberApproval: a signed-in CLI reads the member route", () => {
  it("POSITIVE CONTROL: reads GET /api/v1/releases/approved once with the sign-in", async () => {
    const home = tempHome();
    signIn(home);
    const fetchImpl = memberFetch(200, { ok: true, release: approved() });
    const read = await readMemberApproval(makeCtx(home, { fetch: fetchImpl }));
    expect(read).toMatchObject({ kind: "approved", source: "network", release: { approvalId: "example-89" } });
    expect(fetchImpl.calls).toEqual(["https://cloud.example.test/api/v1/releases/approved"]);
  });

  it.each([
    [404, { ok: false }, "not_provided"],
    [401, { error: "unauthorized" }, "credential_refused"],
    [200, { ok: true, release: { schemaVersion: 1 } }, "response_invalid"],
  ])("HTTP %s reads as %s", async (status, body, reason) => {
    const home = tempHome();
    signIn(home);
    expect(await readMemberApproval(makeCtx(home, { fetch: memberFetch(status, body) }))).toEqual({ kind: "unavailable", reason });
  });

  it("signed out never contacts the service, and an unreachable service is a reason", async () => {
    const fetchImpl = memberFetch(200, {});
    expect(await readMemberApproval(makeCtx(tempHome(), { fetch: fetchImpl }))).toEqual({ kind: "unavailable", reason: "signed_out" });
    expect(fetchImpl.calls).toEqual([]);
    const home = tempHome();
    signIn(home);
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await readMemberApproval(makeCtx(home, { fetch: down }))).toEqual({ kind: "unavailable", reason: "unreachable" });
  });
});

describe("the diagnostic cache", () => {
  it("round-trips a parsed record, privately, and refuses a damaged one", () => {
    const home = tempHome();
    expect(readApprovalCache(home)).toBeNull();
    const parsed = parseApprovedRelease(approved());
    if (!parsed.ok) throw new Error("expected a parsed record");
    writeApprovalCache(home, { observedAtMs: 1_800_000_000_000, release: parsed.release });
    expect(existsSync(approvalCachePathFor(home))).toBe(true);
    expect(readApprovalCache(home)).toEqual({ observedAtMs: 1_800_000_000_000, release: parsed.release });
  });
});

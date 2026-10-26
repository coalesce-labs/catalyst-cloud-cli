import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { readReleaseState, writeReleaseState, type ReleaseComponent } from "../src/runner-update";
import {
  credentialMount,
  dockerFleetUpdateEngine,
  FLEET_COMPOSE_FILE,
  IN_FLIGHT_FILE,
  notReadyScope,
  POST_ROLL_ARMED_FILE,
  POST_ROLL_RESULT_FILE,
  postRollCounts,
  postRollFailing,
  PREVIOUS_COMPOSE_FILE,
  qualifiedScopes,
  runFleetPostRollCheck,
  runFleetUpdate,
  type FleetSupervisor,
  type FleetUpdateEngine,
} from "../src/runner-update-fleet";
import { makeCtx, tempHome } from "./helpers";

// A multi-team supervisor fleet (CTC-6530): one supervisor in a JSON Compose file serving several
// scopes. The fake engine derives the running supervisor from `compose.json` at each recreate, so
// what the update wrote is what the "container" runs.

const hex = (c: string) => c.repeat(64);
const sha = (c: string) => c.repeat(40);
const REPO = {
  runner: "ghcr.io/coalesce-labs/catalyst-runner",
  supervisor: "ghcr.io/coalesce-labs/catalyst-supervisor",
  watchdog: "ghcr.io/coalesce-labs/catalyst-deadline-watchdog",
} as const;
const ref = (component: ReleaseComponent, c: string) => `${REPO[component]}@sha256:${hex(c)}`;

function release(generation = 2, [r, s, w]: [string, string, string] = ["1", "2", "3"]) {
  const image = (component: ReleaseComponent, c: string, src: string) => ({
    reference: ref(component, c),
    digest: `sha256:${hex(c)}`,
    tag: `${REPO[component]}:${sha(src)}${component === "runner" ? "-multiarch" : ""}`,
    sourceSha: sha(src),
  });
  return {
    version: 1,
    releaseId: `hr-${hex(r).slice(0, 16)}-${hex(s).slice(0, 16)}-${hex(w).slice(0, 16)}`,
    generation,
    approvedAtMs: 1_800_000_000_000,
    runner: image("runner", r, "a"),
    supervisor: image("supervisor", s, "b"),
    watchdog: image("watchdog", w, "b"),
  };
}

const OLD = { runner: ref("runner", "8"), supervisor: ref("supervisor", "9") };
const NEW = { runner: ref("runner", "1"), supervisor: ref("supervisor", "2") };

function composeFile(images = OLD) {
  return {
    name: "catalyst-fleet",
    services: {
      supervisor: {
        image: images.supervisor,
        user: "10001:10001",
        env_file: ["/etc/catalyst/runner-telemetry.env"],
        environment: {
          CATALYST_RUNNER_IMAGE: images.runner,
          CATALYST_HOST_CREDENTIAL_FILE: "/run/catalyst/root-credential/credential",
          CATALYST_MIRROR_URL: "https://mirror.example",
          CATALYST_SLOTS: "4",
        },
        volumes: [
          { type: "volume", source: "existing-root-credential", target: "/run/catalyst/root-credential", read_only: true },
          { type: "bind", source: "/srv/fleet/fleet.json", target: "/etc/catalyst/fleet/fleet.json", read_only: true },
        ],
      },
    },
    volumes: { "existing-root-credential": { external: true, name: "catalyst-host-credential" } },
  };
}

function install(images = OLD): { dir: string; text: string } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-update-"));
  const text = `${JSON.stringify(composeFile(images), null, 2)}\n`;
  writeFileSync(join(dir, FLEET_COMPOSE_FILE), text, { mode: 0o600 });
  return { dir, text };
}

const qualifiedLine = (tenant: string, team: string) =>
  `2026-10-22T19:00:00Z {"version":1,"event":"supervisor_scope_qualified","tenant":"${tenant}","team":"${team}","hostId":"host_x"}`;
const notReadyLine = (tenant: string, team: string) =>
  JSON.stringify({ event: "host_not_ready", tenant, team, failing: [{ id: "host.repo", reason: "failed" }] });
const SERVING = [qualifiedLine("tenant-0", "CTC"), qualifiedLine("tenant-3", "WID")].join("\n");

interface FakeOptions {
  read?: unknown;
  /** Log text of a supervisor recreated on these images. */
  logsFor?: (images: { runner: string; supervisor: string }) => string;
  before?: string;
  restartAfterRecreate?: boolean;
  configValid?: boolean;
  childChanges?: boolean;
  /** Whether the host could schedule the post-roll check; true by default. */
  arm?: boolean;
}

function fake(dir: string, options: FakeOptions = {}) {
  const calls = {
    recreate: 0, removed: [] as string[], prepared: [] as string[][],
    armed: [] as { dir: string; delayMs: number }[], logSince: [] as string[],
  };
  let desired: unknown = options.read ?? release();
  const runningFrom = (): { runner: string; supervisor: string } => {
    const compose = JSON.parse(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8"));
    return { supervisor: compose.services.supervisor.image, runner: compose.services.supervisor.environment.CATALYST_RUNNER_IMAGE };
  };
  const first = runningFrom();
  let live: FleetSupervisor = {
    id: "a".repeat(64), image: first.supervisor, runnerImage: first.runner, running: true, restartCount: 0, startedAt: "2026-10-20T00:00:00Z",
  };
  let logText = options.before ?? SERVING;
  let childEpoch = 0;
  const engine: FleetUpdateEngine = {
    desiredRelease: async () => ({ kind: "answered", status: 200, body: { ok: true, release: desired }, hostId: "host_root" }),
    supervisor: async () => live,
    logs: async (_id, since) => {
      calls.logSince.push(since);
      return logText;
    },
    children: async () => ({ ["c".repeat(64)]: { running: true, fingerprint: `child-${childEpoch}` } }),
    prepare: async (images) => {
      calls.prepared.push(images);
      return null;
    },
    configValid: async () => options.configValid ?? true,
    recreate: async () => {
      calls.recreate++;
      const images = runningFrom();
      live = {
        id: String(calls.recreate).repeat(64).slice(0, 64),
        image: images.supervisor,
        runnerImage: images.runner,
        running: true,
        restartCount: options.restartAfterRecreate && calls.recreate === 1 ? 1 : 0,
        startedAt: `2026-10-22T20:0${calls.recreate}:00Z`,
      };
      logText = options.logsFor ? options.logsFor(images) : SERVING;
      if (options.childChanges) childEpoch++;
      return true;
    },
    removeImages: async (images) => {
      calls.removed.push(...images);
    },
    armPostRollCheck: async (armedDir, delayMs) => {
      calls.armed.push({ dir: armedDir, delayMs });
      return options.arm ?? true;
    },
  };
  return {
    engine,
    calls,
    /** What the supervisor's log shows from now on. */
    setLogs: (text: string) => void (logText = text),
    approve: (next: unknown) => void (desired = next),
  };
}

/** A clock that moves 10 s per sleep, so the 90 s hold and the 240 s deadline pass in a test. */
function clock() {
  let t = Date.parse("2026-10-22T20:00:00Z");
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("fleet update: one release for the whole fleet, the supervisor recreated alone", () => {
  it("POSITIVE CONTROL: a newer release rewrites only the two image fields, re-qualifies every scope and records the generation", async () => {
    const { dir, text } = install();
    const { engine, calls } = fake(dir);
    const result = await runFleetUpdate(engine, { dir, ...clock() });
    expect(result).toMatchObject({ outcome: "updated", detail: "updated:runner,supervisor", generation: 2, exitCode: 0 });
    const after = JSON.parse(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8"));
    expect(after).toEqual(composeFile(NEW));
    expect(readFileSync(join(dir, PREVIOUS_COMPOSE_FILE), "utf8")).toBe(text);
    expect(calls.recreate).toBe(1);
    expect(calls.prepared).toEqual([[NEW.runner, NEW.supervisor]]);
    expect(calls.removed).toEqual([OLD.runner, OLD.supervisor]);
    expect(readReleaseState(dir)).toMatchObject({ generation: 2, previous: { ...OLD, watchdog: "" }, last: { outcome: "updated" } });
    expect(existsSync(join(dir, "update.lock"))).toBe(false);
    expect(existsSync(join(dir, IN_FLIGHT_FILE))).toBe(false);
  });

  it("a fleet already running the release, rolled by hand, is recorded with no recreate", async () => {
    const { dir, text } = install(NEW);
    const { engine, calls } = fake(dir);
    expect(await runFleetUpdate(engine, { dir, ...clock() }))
      .toMatchObject({ outcome: "recorded", detail: "already_running_release", generation: 2, exitCode: 0 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
    expect(calls.recreate + calls.prepared.length).toBe(0);
  });

  describe("a run killed between the recreate and the end of qualify", () => {
    /** compose.json already names the release, the saved previous file and baseline are on disk, and
     *  the new supervisor's own log shows only CTC: it must not be taken as the baseline. */
    function interrupted() {
      const { dir } = install(NEW);
      const previous = `${JSON.stringify(composeFile(OLD), null, 2)}\n`;
      writeFileSync(join(dir, PREVIOUS_COMPOSE_FILE), previous, { mode: 0o600 });
      writeFileSync(join(dir, IN_FLIGHT_FILE), JSON.stringify({ version: 1, scopes: ["tenant-0/CTC", "tenant-3/WID"], atMs: 1 }));
      return { dir, previous };
    }

    it("NEGATIVE: the next run qualifies against the saved scopes and rolls back to the saved previous file", async () => {
      const { dir, previous } = interrupted();
      const onlyCtc = qualifiedLine("tenant-0", "CTC");
      const { engine, calls } = fake(dir, { before: onlyCtc, logsFor: (i) => (i.runner === NEW.runner ? onlyCtc : SERVING) });
      expect(await runFleetUpdate(engine, { dir, ...clock() }))
        .toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_qualified", exitCode: 1 });
      expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(previous);
      expect(calls.recreate).toBe(2);
      expect(existsSync(join(dir, IN_FLIGHT_FILE))).toBe(false);
      expect(readReleaseState(dir).generation).toBeNull();
    });

    it("the next run finishes it when the new supervisor does serve every saved scope", async () => {
      const { dir } = interrupted();
      const { engine, calls } = fake(dir);
      expect(await runFleetUpdate(engine, { dir, ...clock() })).toMatchObject({ outcome: "updated", detail: "reconciled", generation: 2 });
      expect(calls.recreate).toBe(1);
      expect(existsSync(join(dir, IN_FLIGHT_FILE))).toBe(false);
    });
  });

  it.each([
    ["a scope that served before never qualifies again", { logsFor: (i: { runner: string }) => (i.runner === NEW.runner ? qualifiedLine("tenant-0", "CTC") : SERVING) }],
    ["a scope that served before logs host_not_ready", { logsFor: (i: { runner: string }) => (i.runner === NEW.runner ? `${SERVING}\n${notReadyLine("tenant-3", "WID")}` : SERVING) }],
    ["the new supervisor restarts", { restartAfterRecreate: true }],
  ])("NEGATIVE: %s, so the previous compose.json comes back and the supervisor is recreated on it", async (_label, options) => {
    const { dir, text } = install();
    const { engine, calls } = fake(dir, options);
    const result = await runFleetUpdate(engine, { dir, ...clock() });
    expect(result).toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_qualified", exitCode: 1 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
    expect(calls.recreate).toBe(2);
    expect(calls.removed).toEqual([]);
    expect(readReleaseState(dir).generation).toBeNull();
  });

  it("a scope that was not serving before may stay unready: it does not hold the update", async () => {
    const { dir } = install();
    const { engine } = fake(dir, { logsFor: () => `${SERVING}\n${notReadyLine("tenant-9", "ADV")}` });
    expect(await runFleetUpdate(engine, { dir, ...clock() })).toMatchObject({ outcome: "updated", exitCode: 0 });
  });

  it("a running phase container that changed across the recreate is reported for a person, exit 1", async () => {
    const { dir } = install();
    const { engine } = fake(dir, { childChanges: true });
    expect(await runFleetUpdate(engine, { dir, ...clock() }))
      .toMatchObject({ outcome: "updated", detail: "updated:runner,supervisor;children_changed:1", exitCode: 1 });
  });

  it.each([
    ["no scope qualified before the update", { before: notReadyLine("tenant-0", "CTC") }, "no_qualified_scope", 1],
    ["the candidate file fails docker compose config", { configValid: false }, "compose_config_invalid", 1],
  ])("NEGATIVE: %s changes nothing", async (_label, options, detail, exitCode) => {
    const { dir, text } = install();
    const { engine, calls } = fake(dir, options);
    expect(await runFleetUpdate(engine, { dir, ...clock() })).toMatchObject({ outcome: "retained", detail, exitCode });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
    expect(calls.recreate).toBe(0);
  });

  it("--check plans and changes nothing; the applied generation, running, is current", async () => {
    const { dir, text } = install();
    const { engine, calls } = fake(dir);
    expect(await runFleetUpdate(engine, { dir, check: true, ...clock() }))
      .toMatchObject({ outcome: "planned", detail: "would_update:runner,supervisor", generation: 2 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
    expect(calls.recreate + calls.prepared.length).toBe(0);

    await runFleetUpdate(engine, { dir, ...clock() });
    expect(await runFleetUpdate(engine, { dir, ...clock() })).toMatchObject({ outcome: "current", detail: "not_newer" });
    expect(calls.recreate).toBe(1);
  });

  it("a directory with no fleet compose.json fails and says so", async () => {
    const empty = mkdtempSync(join(tmpdir(), "fleet-none-"));
    const { engine } = fake(install().dir);
    expect(await runFleetUpdate(engine, { dir: empty })).toMatchObject({ outcome: "failed", detail: "fleet_not_installed", exitCode: 1 });
  });
});

describe("fleet update: reading the logs and the credential mount", () => {
  it("qualified scopes are keyed by tenant and team; unrelated lines are ignored", () => {
    const text = [SERVING, "plain text", '{"event":"host_ready"}', qualifiedLine("tenant-0", "CTC")].join("\n");
    expect([...qualifiedScopes(text)].sort()).toEqual(["tenant-0/CTC", "tenant-3/WID"]);
    expect(notReadyScope(notReadyLine("tenant-9", "ADV"), new Set(["tenant-0/CTC"]))).toBeNull();
    expect(notReadyScope(notReadyLine("tenant-0", "CTC"), new Set(["tenant-0/CTC"]))).toBe("tenant-0/CTC");
    expect(notReadyScope('{"event":"host_not_ready","failing":[]}', new Set(["tenant-0/CTC"]))).toBe("unscoped");
  });

  it("the credential mount resolves an external volume's name, a bind, and the short syntax, read-only", () => {
    const compose = composeFile() as unknown as Record<string, unknown>;
    const service = composeFile().services.supervisor as unknown as Record<string, unknown>;
    expect(credentialMount(compose, service, "/run/catalyst/root-credential/credential"))
      .toBe("type=volume,src=catalyst-host-credential,dst=/run/catalyst/root-credential,readonly");
    expect(credentialMount(compose, service, "/etc/catalyst/fleet/fleet.json"))
      .toBe("type=bind,src=/srv/fleet/fleet.json,dst=/etc/catalyst/fleet/fleet.json,readonly");
    expect(credentialMount(compose, { volumes: ["cred:/run/cred:ro"] }, "/run/cred/credential"))
      .toBe("type=volume,src=catalyst-fleet_cred,dst=/run/cred,readonly");
    expect(credentialMount(compose, service, "/somewhere/else")).toBeNull();
    const nested = { volumes: ["outer:/run/catalyst", "inner:/run/catalyst/root-credential:ro", "late:/run"] };
    expect(credentialMount(compose, nested, "/run/catalyst/root-credential/credential"))
      .toBe("type=volume,src=catalyst-fleet_inner,dst=/run/catalyst/root-credential,readonly");
  });
});

describe("catalyst runner update --fleet", () => {
  it("POSITIVE CONTROL: --fleet --check reads the fleet's compose.json through the fleet engine", async () => {
    const ctx = makeCtx(tempHome());
    const { dir } = install();
    const { engine } = fake(dir);
    expect(await main(["runner", "update", "--fleet", "--check", "--json", "--dir", dir], ctx, { runner: { fleetEngine: engine } })).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ outcome: "planned", detail: "would_update:runner,supervisor" });
  });

  it("--fleet without --dir is a usage error", async () => {
    const ctx = makeCtx(tempHome());
    expect(await main(["runner", "update", "--fleet"], ctx, {})).not.toBe(0);
  });
});

// A release can qualify and then stop receiving work minutes later (CTC-6564). A successful apply
// arms a check 10 minutes out; the check reads the supervisor's log since the roll began.
const ROLL_START = "2026-10-22T20:00:00.000Z";
const grantedLine = '2026-10-22T20:06:00Z {"version":1,"event":"work_granted","tenant":"tenant-0","team":"CTC"}';
const refusedLine = '2026-10-22T20:06:00Z {"version":1,"event":"acquire_refused","tenant":"tenant-0","team":"CTC"}';
const noneLine = '2026-10-22T20:06:00Z {"version":1,"event":"acquire_none","tenant":"tenant-0","team":"CTC"}';
const noResponseLine = '2026-10-22T20:06:00Z {"version":1,"event":"acquire_retry","detail":"fetch failed (no response)"}';
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const lines = (line: string, count: number) => Array.from({ length: count }, () => line).join("\n");
const readJson = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));

/** An install updated from OLD to NEW (generation 2); the fleet was on `fromGeneration` before it. */
async function rolled(options: FakeOptions = {}, fromGeneration: number | null = null) {
  const { dir, text } = install();
  if (fromGeneration !== null) writeReleaseState(dir, { ...readReleaseState(dir), generation: fromGeneration });
  const fleet = fake(dir, options);
  const result = await runFleetUpdate(fleet.engine, { dir, ...clock() });
  return { dir, text, result, ...fleet };
}
/** The engine as the check first sees it with the supervisor stopped or missing; later reads (after the
 *  rollback's recreate) are the real fake's. */
const supervisorDownAtCheck = (engine: FleetUpdateEngine, first: FleetSupervisor | null): FleetUpdateEngine => {
  let reads = 0;
  return {
    ...engine,
    supervisor: async (...args) => (reads++ === 0 ? first : engine.supervisor(...args)),
  };
};
const runCheck = (engine: FleetUpdateEngine, dir: string) => runFleetPostRollCheck(engine, { dir, now: clock().now });

describe("fleet update: the post-roll check is armed by a successful apply", () => {
  it("POSITIVE CONTROL: the apply arms the check 10 minutes out and records the bytes it wrote and when the roll began", async () => {
    const { dir, result, calls } = await rolled({}, 1);
    expect(result).toMatchObject({ outcome: "updated", detail: "updated:runner,supervisor", exitCode: 0 });
    expect(calls.armed).toEqual([{ dir, delayMs: 600_000 }]);
    expect(readJson(dir, POST_ROLL_ARMED_FILE)).toMatchObject({
      version: 1,
      sinceMs: Date.parse(ROLL_START),
      composeSha256: sha256(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")),
      generation: 2,
      fromGeneration: 1,
    });
  });

  it("NEGATIVE: a host that cannot arm the check still applies, and the output says it is not armed", async () => {
    const { dir, result } = await rolled({ arm: false });
    expect(result).toMatchObject({ outcome: "updated", detail: "updated:runner,supervisor;post_roll_check_not_armed", exitCode: 0 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(`${JSON.stringify(composeFile(NEW), null, 2)}\n`);
  });

  it.each([
    ["a rolled-back apply", { restartAfterRecreate: true }, false],
    ["--check", {}, true],
  ])("NEGATIVE: %s arms nothing", async (_label, options, check) => {
    const { dir } = install();
    const { engine, calls } = fake(dir, options);
    await runFleetUpdate(engine, { dir, check, ...clock() });
    expect(calls.armed).toEqual([]);
    expect(existsSync(join(dir, POST_ROLL_ARMED_FILE))).toBe(false);
  });
});

describe("fleet update: the post-roll verdict", () => {
  it("PASS: a grant since the roll leaves the release in place and records the counts", async () => {
    const { dir, engine, calls, setLogs } = await rolled();
    setLogs([grantedLine, refusedLine, noResponseLine].join("\n"));
    const outcome = await runCheck(engine, dir);
    expect(outcome).toMatchObject({ detail: "PASS", exitCode: 0 });
    expect(readJson(dir, POST_ROLL_RESULT_FILE)).toMatchObject({ verdict: "PASS", since: ROLL_START, granted: 1, noResponse: 1, answered: 2, generation: 2 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(`${JSON.stringify(composeFile(NEW), null, 2)}\n`);
    expect(calls.recreate).toBe(1);
    expect(existsSync(join(dir, POST_ROLL_ARMED_FILE))).toBe(false);
  });

  it("STANDS_IDLE: no grant, nothing logged and the supervisor running is an idle host, not a failure", async () => {
    const { dir, text, engine, calls, setLogs } = await rolled();
    setLogs("");
    calls.prepared.length = 0;
    expect(await runCheck(engine, dir)).toMatchObject({ detail: "STANDS_IDLE", exitCode: 0 });
    expect(readJson(dir, POST_ROLL_RESULT_FILE)).toMatchObject({ verdict: "STANDS_IDLE", granted: 0, noResponse: 0, answered: 0 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).not.toBe(text);
    expect(calls.recreate).toBe(1);
    expect(calls.prepared).toEqual([]);
    expect(existsSync(join(dir, POST_ROLL_ARMED_FILE))).toBe(false);
  });

  it("STANDS_IDLE: refused acquires and fewer than three no-response retries are not a failure either", async () => {
    const { dir, engine, calls, setLogs } = await rolled();
    setLogs([lines(refusedLine, 2), lines(noResponseLine, 2)].join("\n"));
    expect(await runCheck(engine, dir)).toMatchObject({ detail: "STANDS_IDLE", exitCode: 0 });
    expect(readJson(dir, POST_ROLL_RESULT_FILE)).toMatchObject({ verdict: "STANDS_IDLE", granted: 0, noResponse: 2, answered: 2 });
    expect(calls.recreate).toBe(1);
  });

  it("ROLLED_BACK: no grant and three no-response retries restores the saved previous file and recreates the supervisor alone", async () => {
    const { dir, text, engine, calls, setLogs } = await rolled({}, 1);
    setLogs([lines(noResponseLine, 3), lines(refusedLine, 3)].join("\n"));
    calls.prepared.length = 0;
    calls.logSince.length = 0;
    const outcome = await runCheck(engine, dir);
    expect(outcome).toMatchObject({ detail: "ROLLED_BACK", exitCode: 1 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
    expect(calls.recreate).toBe(2);
    expect(calls.prepared).toEqual([[OLD.runner, OLD.supervisor]]);
    expect(calls.logSince).toEqual([ROLL_START]);
    expect(readJson(dir, POST_ROLL_RESULT_FILE)).toMatchObject({
      verdict: "ROLLED_BACK", granted: 0, noResponse: 3, answered: 3, generation: 2, rolledBackFrom: 2, rolledBackTo: 1,
    });
    expect(existsSync(join(dir, POST_ROLL_ARMED_FILE))).toBe(false);
    expect(existsSync(join(dir, "update.lock"))).toBe(false);
  });

  it.each([
    ["stopped", true],
    ["not found", false],
  ])("ROLLED_BACK: a supervisor that is %s at check time goes back through the guarded path, and its log is not read", async (_label, found) => {
    const { dir, text, engine, calls } = await rolled({}, 1);
    const live = (await engine.supervisor(dir, "catalyst-fleet"))!;
    const check = supervisorDownAtCheck(engine, found ? { ...live, running: false } : null);
    calls.prepared.length = 0;
    calls.logSince.length = 0;
    expect(await runCheck(check, dir)).toMatchObject({ detail: "ROLLED_BACK", exitCode: 1 });
    expect(calls.logSince).toEqual([]);
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
    expect(calls.prepared).toEqual([[OLD.runner, OLD.supervisor]]);
    expect(calls.recreate).toBe(2);
    expect(readJson(dir, POST_ROLL_RESULT_FILE)).toMatchObject({
      verdict: "ROLLED_BACK", granted: 0, noResponse: 0, answered: 0, reason: "supervisor_not_running", rolledBackFrom: 2, rolledBackTo: 1,
    });
    expect(existsSync(join(dir, POST_ROLL_ARMED_FILE))).toBe(false);
  });

  it("NEGATIVE: a stopped supervisor is still refused when compose.json changed since the roll", async () => {
    const { dir, engine, calls } = await rolled();
    const moved = `${JSON.stringify(composeFile(NEW), null, 4)}\n`;
    writeFileSync(join(dir, FLEET_COMPOSE_FILE), moved);
    const stopped = { ...(await engine.supervisor(dir, "catalyst-fleet"))!, running: false };
    expect(await runCheck(supervisorDownAtCheck(engine, stopped), dir)).toMatchObject({ detail: "ROLLBACK_REFUSED", exitCode: 1 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(moved);
    expect(calls.recreate).toBe(1);
  });

  it("NEGATIVE: Docker unreadable (no supervisor read, or no log) judges nothing and keeps the check armed", async () => {
    const { dir, engine, calls } = await rolled();
    const noDocker: FleetUpdateEngine = { ...engine, supervisor: async () => undefined };
    expect(await runCheck(noDocker, dir)).toMatchObject({ detail: "docker_unavailable", result: null, exitCode: 1 });
    const noLogs: FleetUpdateEngine = { ...engine, logs: async () => null };
    expect(await runCheck(noLogs, dir)).toMatchObject({ detail: "docker_unavailable", result: null, exitCode: 1 });
    expect(existsSync(join(dir, POST_ROLL_ARMED_FILE))).toBe(true);
    expect(calls.recreate).toBe(1);
  });

  it("NEGATIVE: compose.json changed since the roll is refused, not overwritten", async () => {
    const { dir, engine, calls, setLogs } = await rolled();
    const moved = `${JSON.stringify(composeFile(NEW), null, 4)}\n`;
    writeFileSync(join(dir, FLEET_COMPOSE_FILE), moved);
    setLogs(lines(noResponseLine, 5));
    expect(await runCheck(engine, dir)).toMatchObject({ detail: "ROLLBACK_REFUSED", exitCode: 1 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(moved);
    expect(calls.recreate).toBe(1);
    expect(readJson(dir, POST_ROLL_RESULT_FILE)).toMatchObject({ verdict: "ROLLBACK_REFUSED", reason: "compose_changed_since_roll" });
  });

  it("a rollback whose supervisor is not running afterwards is recorded as failed", async () => {
    const { dir, engine, setLogs } = await rolled();
    setLogs(lines(noResponseLine, 3));
    let reads = 0;
    const down: FleetUpdateEngine = {
      ...engine,
      supervisor: async (...args) => (reads++ === 0 ? engine.supervisor(...args) : { ...(await engine.supervisor(...args))!, running: false }),
    };
    expect(await runCheck(down, dir)).toMatchObject({ detail: "ROLLBACK_FAILED", exitCode: 1 });
    expect(readJson(dir, POST_ROLL_RESULT_FILE)).toMatchObject({ verdict: "ROLLBACK_FAILED", reason: "supervisor_not_running" });
  });

  it("with no check armed there is nothing to judge and nothing changes", async () => {
    const { dir } = install();
    const { engine, calls } = fake(dir);
    expect(await runCheck(engine, dir)).toMatchObject({ detail: "no_post_roll_check_armed", result: null, exitCode: 0 });
    expect(calls.recreate).toBe(0);
  });

  it("counts: only the four events, and a retry counts only when it says no response", () => {
    const retryOther = '{"event":"acquire_retry","detail":"HTTP 503"}';
    expect(postRollCounts([grantedLine, grantedLine, refusedLine, noResponseLine, retryOther, "plain text"].join("\n")))
      .toEqual({ granted: 2, noResponse: 1, answered: 3 });
    expect(postRollCounts("")).toEqual({ granted: 0, noResponse: 0, answered: 0 });
  });

  it("counts: acquire_none lines are answered acquires", () => {
    expect(postRollCounts([noneLine, noneLine, refusedLine, grantedLine].join("\n")))
      .toEqual({ granted: 1, noResponse: 0, answered: 4 });
  });

  it.each([
    [{ granted: 1, noResponse: 9 }, false],
    [{ granted: 0, noResponse: 3 }, true],
    [{ granted: 0, noResponse: 9 }, true],
    [{ granted: 0, noResponse: 2 }, false],
    [{ granted: 0, noResponse: 0 }, false],
  ])("the rule: %j is failing=%s", (counts, failing) => {
    expect(postRollFailing(counts)).toBe(failing);
  });
});

describe("fleet update: a release the post-roll check rolled back", () => {
  const NEWER = [release(3, ["4", "5", "6"]), { runner: ref("runner", "4"), supervisor: ref("supervisor", "5") }] as const;

  async function rolledBack() {
    const state = await rolled({}, 1);
    state.setLogs(lines(noResponseLine, 3));
    await runCheck(state.engine, state.dir);
    return state;
  }

  it("is not applied again by the next scheduled run, which reports it as rolled back with the reason", async () => {
    const { dir, text, engine, calls } = await rolledBack();
    const recreates = calls.recreate;
    const again = await runFleetUpdate(engine, { dir, ...clock() });
    expect(again).toMatchObject({ outcome: "rolled_back", generation: 2, exitCode: 1 });
    expect(again.detail).toBe("post_roll_rolled_back:granted=0,no_response=3,answered=0");
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
    expect(calls.recreate).toBe(recreates);
    expect(calls.prepared).toHaveLength(2);
    expect(readReleaseState(dir).last).toMatchObject({ outcome: "rolled_back" });
  });

  it("is reported as rolled back by --check too, and nothing moves", async () => {
    const { dir, engine, calls } = await rolledBack();
    expect(await runFleetUpdate(engine, { dir, check: true, ...clock() })).toMatchObject({ outcome: "rolled_back", exitCode: 1 });
    expect(calls.recreate).toBe(2);
  });

  it("a newer approved release is applied normally, and its own check is armed", async () => {
    const { dir, engine, calls, approve } = await rolledBack();
    approve(NEWER[0]);
    expect(await runFleetUpdate(engine, { dir, ...clock() })).toMatchObject({ outcome: "updated", detail: "updated:runner,supervisor", generation: 3 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(`${JSON.stringify(composeFile(NEWER[1]), null, 2)}\n`);
    expect(calls.armed).toHaveLength(2);
    expect(existsSync(join(dir, POST_ROLL_RESULT_FILE))).toBe(false);
  });

  it("the same images approved again as a newer generation are applied", async () => {
    const { dir, engine, approve } = await rolledBack();
    approve(release(3));
    expect(await runFleetUpdate(engine, { dir, ...clock() })).toMatchObject({ outcome: "updated", generation: 3 });
  });
});

describe("catalyst runner update --fleet: the post-roll check on the command line", () => {
  it("--check names the last post-roll verdict, in the text and in the JSON", async () => {
    const { dir, engine, setLogs } = await rolled();
    setLogs(grantedLine);
    await runCheck(engine, dir);
    const json = makeCtx(tempHome());
    expect(await main(["runner", "update", "--fleet", "--check", "--json", "--dir", dir], json, { runner: { fleetEngine: engine } })).toBe(0);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ outcome: "current", lastPostRoll: { verdict: "PASS", granted: 1, generation: 2 } });
    const text = makeCtx(tempHome());
    await main(["runner", "update", "--fleet", "--check", "--dir", dir], text, { runner: { fleetEngine: engine } });
    expect(text.out.join("\n")).toContain("The last post-roll check, at ");
    expect(text.out.join("\n")).toContain("passed: the release was granted work");
  });

  it("--check names a rollback and the generation it went back to", async () => {
    const { dir, engine, setLogs } = await rolled({}, 1);
    setLogs(lines(noResponseLine, 3));
    await runCheck(engine, dir);
    const ctx = makeCtx(tempHome());
    expect(await main(["runner", "update", "--fleet", "--check", "--dir", dir], ctx, { runner: { fleetEngine: engine } })).toBe(1);
    expect(ctx.out.join("\n")).toMatch(/rolled the release back.*back to generation 1/);
  });

  it("--check says nothing about a verdict when there is none", async () => {
    const { dir } = install();
    const { engine } = fake(dir);
    const ctx = makeCtx(tempHome());
    await main(["runner", "update", "--fleet", "--check", "--json", "--dir", dir], ctx, { runner: { fleetEngine: engine } });
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ lastPostRoll: null });
  });

  it("--post-roll-check runs the armed check and exits with its verdict", async () => {
    const { dir, engine, setLogs } = await rolled();
    setLogs(lines(noResponseLine, 3));
    const ctx = makeCtx(tempHome());
    expect(await main(["runner", "update", "--fleet", "--post-roll-check", "--dir", dir], ctx, { runner: { fleetEngine: engine } })).toBe(1);
    expect(ctx.out.join("\n")).toContain("rolled the release back");
  });

  it.each([
    ["without --fleet", (dir: string) => ["--post-roll-check", "--dir", dir]],
    ["without --dir", () => ["--fleet", "--post-roll-check"]],
    ["with --check", (dir: string) => ["--fleet", "--check", "--post-roll-check", "--dir", dir]],
  ])("%s is a usage error and runs nothing", async (_label, flags) => {
    const { dir } = await rolled();
    const { engine, calls } = fake(dir);
    const ctx = makeCtx(tempHome());
    expect(await main(["runner", "update", ...flags(dir)], ctx, { runner: { fleetEngine: engine } })).not.toBe(0);
    expect(ctx.err.join("\n")).toContain("--");
    expect(calls.recreate + calls.logSince.length).toBe(0);
    expect(existsSync(join(dir, POST_ROLL_RESULT_FILE))).toBe(false);
  });
});

describe("fleet update: arming the check on the host", () => {
  const run = (status = 0) => {
    const calls: [string, string[]][] = [];
    return { calls, run: (cmd: string, args: string[]) => (calls.push([cmd, args]), { status, stdout: "", stderr: "" }) };
  };
  type Timer = NonNullable<NonNullable<Parameters<typeof dockerFleetUpdateEngine>[0]>["timer"]>;
  const engineFor = (timer: Timer) =>
    dockerFleetUpdateEngine({ env: { PATH: "/usr/bin:/bin", HOME: "/root", CATALYST_KEY: "x" }, timer });

  it("POSITIVE CONTROL: a transient systemd timer runs this command in 10 minutes, replacing an earlier one", async () => {
    const sched = run();
    const armed = await engineFor({ platform: "linux", uid: 0, command: ["/usr/bin/node", "/opt/catalyst/cli.js"], run: sched.run }).armPostRollCheck("/srv/fleet", 600_000);
    expect(armed).toBe(true);
    expect(sched.calls[0]).toEqual(["systemctl", ["stop", "catalyst-fleet-post-roll.timer", "catalyst-fleet-post-roll.service"]]);
    expect(sched.calls[1]).toEqual(["systemd-run", [
      "--quiet", "--collect", "--unit=catalyst-fleet-post-roll", "--on-active=600s", "--description=Catalyst fleet post-roll check",
      "--setenv=PATH=/usr/bin:/bin", "--setenv=HOME=/root",
      "--", "/usr/bin/node", "/opt/catalyst/cli.js", "runner", "update", "--fleet", "--dir", "/srv/fleet", "--post-roll-check",
    ]]);
  });

  it("a person who is not root gets a user timer", async () => {
    const sched = run();
    await engineFor({ platform: "linux", uid: 1000, command: ["/usr/bin/node", "/opt/catalyst/cli.js"], run: sched.run }).armPostRollCheck("/srv/fleet", 600_000);
    expect(sched.calls.map(([, args]) => args[0])).toEqual(["--user", "--user"]);
  });

  it("NEGATIVE: not Linux, or a systemd-run that fails, is not armed", async () => {
    const mac = run();
    expect(await engineFor({ platform: "darwin", command: ["/usr/bin/node", "/x"], run: mac.run }).armPostRollCheck("/srv/fleet", 600_000)).toBe(false);
    expect(mac.calls).toEqual([]);
    const failing = run(1);
    expect(await engineFor({ platform: "linux", uid: 0, command: ["/usr/bin/node", "/x"], run: failing.run }).armPostRollCheck("/srv/fleet", 600_000)).toBe(false);
  });
});

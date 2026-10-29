import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { readManifest } from "../src/config";
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

const readJson = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));

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
    reports: [] as (string | undefined)[],
    /** Per recreate: the supervisor image it ran, and the scopes the in-flight file required then. */
    recreatedOn: [] as string[], inFlight: [] as (string[] | null)[],
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
    desiredRelease: async (_dir, _compose, _signal, report) => {
      calls.reports.push(report);
      return { kind: "answered", status: 200, body: { ok: true, release: desired }, hostId: "host_root" };
    },
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
      calls.recreatedOn.push(images.supervisor);
      calls.inFlight.push(existsSync(join(dir, IN_FLIGHT_FILE)) ? readJson(dir, IN_FLIGHT_FILE).scopes : null);
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

describe("fleet update reports (CTC-8152)", () => {
  it("reports the previous update of generation 173 on the next read", async () => {
    const { dir } = install();
    const { engine, calls } = fake(dir, { read: release(173) });
    const time = clock();
    expect(await runFleetUpdate(engine, { dir, ...time })).toMatchObject({ outcome: "updated", generation: 173 });
    expect(calls.reports).toEqual([undefined]);
    const previous = readReleaseState(dir).last;
    expect(previous).toMatchObject({ outcome: "updated", detail: "updated:runner,supervisor", atMs: time.now() });

    expect(await runFleetUpdate(engine, { dir, ...time })).toMatchObject({ outcome: "current", generation: 173 });
    expect(calls.reports).toHaveLength(2);
    const report = calls.reports[1];
    if (typeof report !== "string") throw new Error("the next read did not carry the previous update report");
    expect(JSON.parse(report)).toEqual({
      v: 1, outcome: "updated", detail: "updated:runner,supervisor", applied: 173, offered: 173,
      atMs: previous?.atMs, cli: readManifest().version,
    });
  });

  it("a first run sends no report and still processes the desired release", async () => {
    const { dir } = install(NEW);
    const { engine, calls } = fake(dir, { read: release(173) });
    expect(readReleaseState(dir).last).toBeNull();
    expect(await runFleetUpdate(engine, { dir, ...clock() })).toMatchObject({ outcome: "recorded", generation: 173 });
    expect(calls.reports).toEqual([undefined]);
    expect(readReleaseState(dir)).toMatchObject({ generation: 173, last: { outcome: "recorded" } });
    expect(calls.recreate).toBe(0);
  });

  it("--check after a recorded run sends no report and preserves the last result", async () => {
    const { dir } = install();
    const { engine, calls, approve } = fake(dir, { read: release(173) });
    const time = clock();
    await runFleetUpdate(engine, { dir, ...time });
    const before = readReleaseState(dir);
    approve(release(174, ["4", "5", "6"]));
    expect(await runFleetUpdate(engine, { dir, check: true, ...time })).toMatchObject({ outcome: "planned" });
    expect(calls.reports).toEqual([undefined, undefined]);
    expect(readReleaseState(dir)).toEqual(before);
    expect(calls.recreate).toBe(1);
  });

  it.each(["retained", "failed"] as const)("reports a previous %s result with its applied generation and sanitized detail", async (outcome) => {
    const { dir } = install(NEW);
    const atMs = 1_800_000_000_000;
    writeReleaseState(dir, {
      ...readReleaseState(dir), generation: 173,
      last: { outcome, detail: "Image_unverified:ghcr.io/Runner@sha256:AB;retry=1", generation: 173, atMs },
    });
    const { engine, calls } = fake(dir, { read: release(173) });
    expect(await runFleetUpdate(engine, { dir, ...clock() })).toMatchObject({ outcome: "current", generation: 173 });
    expect(calls.reports).toHaveLength(1);
    const report = calls.reports[0];
    if (typeof report !== "string") throw new Error("the read did not carry the previous update report");
    expect(JSON.parse(report)).toEqual({
      v: 1, outcome, detail: "image_unverified:ghcr.io_runner_sha256:ab_retry_1",
      applied: 173, offered: 173, atMs, cli: readManifest().version,
    });
  });

  it.each([undefined, JSON.stringify({ v: 1, outcome: "updated", applied: 173, cli: readManifest().version })])(
    "Docker forwards the exact optional report %s before the entrypoint with only the credential mounted",
    async (report) => {
      const calls: string[][] = [];
      const environments: NodeJS.ProcessEnv[] = [];
      const answer = { kind: "answered", status: 200, body: { ok: true, release: release(173) }, hostId: "host_root" };
      const engine = dockerFleetUpdateEngine({
        env: { PATH: "/usr/bin", CATALYST_UPDATE_REPORT: "stale", CATALYST_KEY: "secret", DOCKER_SOCKET_PATH: "/var/run/docker.sock" },
        exec: async (args, options) => {
          calls.push(args);
          environments.push(options.env);
          return { code: 0, stdout: JSON.stringify(answer) };
        },
      });
      expect(await engine.desiredRelease("/srv/fleet", composeFile(), undefined, report)).toEqual(answer);
      expect(calls).toHaveLength(1);
      const args = calls[0];
      if (!args) throw new Error("Docker was not called");
      const reportValues = args.filter((arg) => arg.startsWith("CATALYST_UPDATE_REPORT="));
      expect(reportValues).toEqual(report === undefined ? [] : [`CATALYST_UPDATE_REPORT=${report}`]);
      if (report !== undefined) {
        const index = args.indexOf(`CATALYST_UPDATE_REPORT=${report}`);
        expect(args.slice(index - 1, index + 1)).toEqual(["--env", `CATALYST_UPDATE_REPORT=${report}`]);
        expect(index).toBeGreaterThan(args.indexOf("CATALYST_MIRROR_URL=https://mirror.example"));
        expect(index).toBeLessThan(args.indexOf("--entrypoint"));
      }
      expect(args.filter((arg) => arg === "--mount")).toHaveLength(1);
      expect(args.slice(args.indexOf("--mount"), args.indexOf("--mount") + 2))
        .toEqual(["--mount", "type=volume,src=catalyst-host-credential,dst=/run/catalyst/root-credential,readonly"]);
      expect(args).toEqual(expect.arrayContaining(["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]));
      expect(args.join(" ")).not.toContain("docker.sock");
      expect(args.join(" ")).not.toContain("/etc/catalyst/fleet");
      expect(environments).toEqual([{ PATH: "/usr/bin" }]);
    },
  );
});

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

// A team's admission turned off during a fleet update (CTC-7569): the supervisor stops starting its
// scope, so that scope never logs `supervisor_scope_qualified` again, from the new release or the old.
const FIFTEEN = [...Array.from({ length: 14 }, (_, i) => `tenant-${i % 4}/T${String(i).padStart(2, "0")}`), "tenant-0/ZCTC163"];
const DROPPED = "tenant-0/ZCTC163";
const STILL_DELEGATED = FIFTEEN.filter((scope) => scope !== DROPPED);
const servingScopes = (scopes: readonly string[]) =>
  scopes.map((scope) => {
    const [tenant = "", team = ""] = scope.split("/");
    return qualifiedLine(tenant, team);
  }).join("\n");
const NEW_COMPOSE = `${JSON.stringify(composeFile(NEW), null, 2)}\n`;

describe("fleet update: a scope whose delegation ends during the update (CTC-7569)", () => {
  it("the new supervisor qualifying the 14 still delegated is enough: the update succeeds, names the dropped scope and runs the new generation", async () => {
    const { dir, text } = install();
    const { engine, calls } = fake(dir, { before: servingScopes(FIFTEEN), logsFor: () => servingScopes(STILL_DELEGATED) });
    const result = await runFleetUpdate(engine, { dir, ...clock() });
    const detail = `updated:runner,supervisor;dropped_scope:${DROPPED}`;
    expect(result).toMatchObject({ outcome: "updated", detail, generation: 2, exitCode: 0 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(NEW_COMPOSE);
    expect(readFileSync(join(dir, PREVIOUS_COMPOSE_FILE), "utf8")).toBe(text);
    // The candidate, then the previous release as the control, then the candidate against the 14.
    expect(calls.recreatedOn).toEqual([NEW.supervisor, OLD.supervisor, NEW.supervisor]);
    expect(calls.inFlight.map((scopes) => scopes?.length)).toEqual([15, 15, 14]);
    expect(calls.inFlight[2]).toEqual([...STILL_DELEGATED].sort());
    expect(existsSync(join(dir, IN_FLIGHT_FILE))).toBe(false);
    expect(calls.removed).toEqual([OLD.runner, OLD.supervisor]);
    expect(calls.armed).toHaveLength(1);
    expect(readReleaseState(dir)).toMatchObject({ generation: 2, last: { outcome: "updated", detail } });
  });

  it("NEGATIVE: the previous supervisor still qualifies the scope the candidate missed, so the update rolls back", async () => {
    const { dir, text } = install();
    const { engine, calls } = fake(dir, {
      before: servingScopes(FIFTEEN),
      logsFor: (i) => servingScopes(i.supervisor === NEW.supervisor ? STILL_DELEGATED : FIFTEEN),
    });
    expect(await runFleetUpdate(engine, { dir, ...clock() }))
      .toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_qualified", exitCode: 1 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
    expect(calls.recreatedOn).toEqual([NEW.supervisor, OLD.supervisor]);
    expect(existsSync(join(dir, IN_FLIGHT_FILE))).toBe(false);
    expect(readReleaseState(dir).generation).toBeNull();
  });

  /** The first recreate's container, the candidate's, in the fake. */
  const CANDIDATE_ID = "1".repeat(64);
  const still = { logsFor: () => servingScopes(STILL_DELEGATED) };
  it.each<[string, FakeOptions, ((engine: FleetUpdateEngine) => FleetUpdateEngine)?]>([
    ["the candidate also misses a scope the previous supervisor still qualifies",
      { logsFor: (i) => servingScopes(i.supervisor === NEW.supervisor ? STILL_DELEGATED.slice(1) : STILL_DELEGATED) }],
    ["the candidate restarts", { ...still, restartAfterRecreate: true }],
    ["the candidate logs host_not_ready for the scope it misses",
      { logsFor: (i) => `${servingScopes(STILL_DELEGATED)}${i.supervisor === NEW.supervisor ? `\n${notReadyLine("tenant-0", "ZCTC163")}` : ""}` }],
    ["the candidate's log cannot be read", still,
      (engine) => ({ ...engine, logs: async (id, ...rest) => (id === CANDIDATE_ID ? null : engine.logs(id, ...rest)) })],
    ["the candidate runs another image", still, (engine) => ({
      ...engine,
      supervisor: async (...args) => {
        const live = await engine.supervisor(...args);
        return live?.id === CANDIDATE_ID ? { ...live, image: OLD.supervisor } : live;
      },
    })],
    ["neither supervisor qualifies any scope", { logsFor: () => "" }],
  ])("NEGATIVE: %s, so no scope is dropped and no generation is recorded", async (_label, options, alter = (engine) => engine) => {
    const { dir, text } = install();
    const fleet = fake(dir, { before: servingScopes(FIFTEEN), ...options });
    const { calls } = fleet;
    const engine = alter(fleet.engine);
    expect(await runFleetUpdate(engine, { dir, ...clock() }))
      .toMatchObject({ outcome: "failed", detail: "rollback_not_qualified", generation: null, exitCode: 1 });
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
    expect(calls.recreatedOn).toEqual([NEW.supervisor, OLD.supervisor]);
    expect(readJson(dir, IN_FLIGHT_FILE).scopes).toHaveLength(15);
    expect(readReleaseState(dir).generation).toBeNull();
  });

  it("NEGATIVE: a candidate that fails again against the 14 goes back to the previous release and records no generation", async () => {
    const { dir, text } = install();
    let recreates = 0;
    const { engine, calls } = fake(dir, {
      before: servingScopes(FIFTEEN),
      logsFor: () => `${servingScopes(STILL_DELEGATED)}${++recreates === 3 ? `\n${notReadyLine("tenant-0", "T00")}` : ""}`,
    });
    expect(await runFleetUpdate(engine, { dir, ...clock() }))
      .toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_qualified", generation: null, exitCode: 1 });
    expect(calls.recreatedOn).toEqual([NEW.supervisor, OLD.supervisor, NEW.supervisor, OLD.supervisor]);
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
    expect(existsSync(join(dir, IN_FLIGHT_FILE))).toBe(false);
    expect(calls.removed).toEqual([]);
    expect(calls.armed).toEqual([]);
    expect(readReleaseState(dir).generation).toBeNull();
  });

  describe("the run after a rollback that did not qualify", () => {
    /** Where the failed run left the host: compose.json and the running supervisor back on the
     *  previous release, which qualifies the 14 still delegated, and the 15 saved scopes on disk. */
    function afterFailedRollback(options: FakeOptions = {}) {
      const { dir, text } = install();
      writeFileSync(join(dir, PREVIOUS_COMPOSE_FILE), text, { mode: 0o600 });
      writeFileSync(join(dir, IN_FLIGHT_FILE), JSON.stringify({ version: 1, scopes: FIFTEEN, atMs: 1 }));
      const still = servingScopes(STILL_DELEGATED);
      return { dir, text, ...fake(dir, { before: still, logsFor: () => still, ...options }) };
    }

    it("requires only the scopes the previous supervisor qualifies now, names the one it dropped, and applies the release", async () => {
      const { dir, engine, calls } = afterFailedRollback();
      const result = await runFleetUpdate(engine, { dir, ...clock() });
      expect(result).toMatchObject({ outcome: "updated", detail: `updated:runner,supervisor;dropped_scope:${DROPPED}`, generation: 2, exitCode: 0 });
      expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(NEW_COMPOSE);
      expect(calls.recreatedOn).toEqual([NEW.supervisor]);
      expect(calls.inFlight).toEqual([[...STILL_DELEGATED].sort()]);
      expect(existsSync(join(dir, IN_FLIGHT_FILE))).toBe(false);
    });

    it("a candidate that then fails rolls back against the scopes still delegated and names the one dropped", async () => {
      const { dir, text, engine, calls } = afterFailedRollback({ restartAfterRecreate: true });
      expect(await runFleetUpdate(engine, { dir, ...clock() }))
        .toMatchObject({ outcome: "rolled_back", detail: `new_supervisor_not_qualified;dropped_scope:${DROPPED}`, generation: null, exitCode: 1 });
      expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
      expect(calls.recreatedOn).toEqual([NEW.supervisor, OLD.supervisor]);
      expect(existsSync(join(dir, IN_FLIGHT_FILE))).toBe(false);
    });

    /** The first supervisor read, the one the run starts from, with `change` applied. */
    const firstRead = (engine: FleetUpdateEngine, change: Partial<FleetSupervisor>): FleetUpdateEngine => {
      let reads = 0;
      return {
        ...engine,
        supervisor: async (...args) => {
          const live = await engine.supervisor(...args);
          return reads++ === 0 && live ? { ...live, ...change } : live;
        },
      };
    };
    it.each<[string, (fleet: ReturnType<typeof afterFailedRollback>) => FleetUpdateEngine]>([
      ["no previous compose.json was saved", (f) => (unlinkSync(join(f.dir, PREVIOUS_COMPOSE_FILE)), f.engine)],
      ["the running supervisor is not on the previous release", (f) => firstRead(f.engine, { image: NEW.supervisor, runnerImage: NEW.runner })],
      ["the previous supervisor started less than the qualify deadline ago", (f) => firstRead(f.engine, { startedAt: "2026-10-22T19:59:00Z" })],
      ["its log cannot be read", (f) => {
        let reads = 0;
        return { ...f.engine, logs: async (...args) => (reads++ === 0 ? null : f.engine.logs(...args)) };
      }],
      ["it qualifies none of the saved scopes", (f) => (f.setLogs(""), f.engine)],
      ["it logs host_not_ready for the saved scope it does not qualify",
        (f) => (f.setLogs(`${servingScopes(STILL_DELEGATED)}\n${notReadyLine("tenant-0", "ZCTC163")}`), f.engine)],
    ])("NEGATIVE: %s, so the saved scopes stay the requirement", async (_label, alter) => {
      const fleet = afterFailedRollback();
      await runFleetUpdate(alter(fleet), { dir: fleet.dir, ...clock() });
      // The candidate qualified against all 15; only the previous release as the control then dropped one.
      expect(fleet.calls.inFlight.map((scopes) => scopes?.length)).toEqual([15, 15, 14]);
      expect(fleet.calls.recreatedOn).toEqual([NEW.supervisor, OLD.supervisor, NEW.supervisor]);
    });
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

// CTC-7570: the armed check is a one-shot timer. When its time came while an update run held the lock it
// judged nothing, and nothing armed it again. The run that held the lock now arms it again as it lets go.
describe("fleet update: a post-roll check an update run kept from judging is armed again (CTC-7570)", () => {
  const NEWER = [release(3, ["4", "5", "6"]), { runner: ref("runner", "4"), supervisor: ref("supervisor", "5") }] as const;
  /** The newer release never qualifies WID, so the scheduled run rolls itself back, as on hetzner-3072373. */
  const newerFails = (i: { runner: string }) => (i.runner === NEWER[1].runner ? qualifiedLine("tenant-0", "CTC") : SERVING);
  const RETRY_MS = 5 * 60_000;
  const holdLock = (dir: string) => writeFileSync(join(dir, "update.lock"), `${process.pid} ${Date.now()}\n`);

  /** One clock for the host: the scheduled run, the check and qualify's sleeps all read it. */
  function hostClock(startMs: number) {
    let t = startMs;
    return { now: () => t, sleep: async (ms: number) => void (t += ms), at: (ms: number) => void (t = ms) };
  }

  /** Generation 2 rolled and armed its check; a scheduled run for generation 3 then starts 2.5 minutes
   *  later and is held inside its recreate, with the update lock, until `letGo()`. */
  async function scheduledRunHoldingTheLock(options: FakeOptions = {}) {
    const state = await rolled(options, 1);
    const armedAtMs = (readJson(state.dir, POST_ROLL_ARMED_FILE) as { armedAtMs: number }).armedAtMs;
    state.approve(NEWER[0]);
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const lockHeldAtArm: boolean[] = [];
    const engine: FleetUpdateEngine = {
      ...state.engine,
      recreate: async (...args) => (await held, state.engine.recreate(...args)),
      armPostRollCheck: async (...args) => {
        lockHeldAtArm.push(existsSync(join(state.dir, "update.lock")));
        return state.engine.armPostRollCheck(...args);
      },
    };
    const host = hostClock(armedAtMs + 150_000);
    const run = runFleetUpdate(engine, { dir: state.dir, now: host.now, sleep: host.sleep });
    expect(existsSync(join(state.dir, "update.lock"))).toBe(true);
    return { ...state, engine, armedAtMs, host, run, letGo, lockHeldAtArm };
  }

  it("RED: a check that finds an update running is armed again a few minutes after that run ends, and then judges the roll", async () => {
    const { dir, engine, calls, armedAtMs, host, run, letGo, lockHeldAtArm, setLogs } = await scheduledRunHoldingTheLock({ logsFor: newerFails });
    host.at(armedAtMs + 600_000);
    expect(await runFleetPostRollCheck(engine, { dir, now: host.now })).toMatchObject({ detail: "update_running", result: null, exitCode: 0 });
    letGo();
    expect(await run).toMatchObject({ outcome: "rolled_back", generation: 2 });
    expect(calls.armed).toEqual([{ dir, delayMs: 600_000 }, { dir, delayMs: RETRY_MS }]);
    expect(lockHeldAtArm).toEqual([true]);
    expect(existsSync(join(dir, "update.lock"))).toBe(false);
    // The re-armed timer fires with no update running and judges generation 2.
    host.at(host.now() + RETRY_MS);
    setLogs(grantedLine);
    expect(await runFleetPostRollCheck(engine, { dir, now: host.now })).toMatchObject({ detail: "PASS", exitCode: 0 });
    expect(readJson(dir, POST_ROLL_RESULT_FILE)).toMatchObject({ verdict: "PASS", generation: 2, since: ROLL_START });
    expect(existsSync(join(dir, POST_ROLL_ARMED_FILE))).toBe(false);
  });

  it("a run that applies a newer generation hands the judgment to that roll's own check and arms nothing more", async () => {
    const { dir, engine, calls, armedAtMs, host, run, letGo, lockHeldAtArm, setLogs } = await scheduledRunHoldingTheLock();
    host.at(armedAtMs + 600_000);
    expect(await runFleetPostRollCheck(engine, { dir, now: host.now })).toMatchObject({ detail: "update_running" });
    letGo();
    expect(await run).toMatchObject({ outcome: "updated", generation: 3 });
    expect(calls.armed).toEqual([{ dir, delayMs: 600_000 }, { dir, delayMs: 600_000 }]);
    expect(lockHeldAtArm).toEqual([true]);
    expect(readJson(dir, POST_ROLL_ARMED_FILE)).toMatchObject({ generation: 3, fromGeneration: 2 });
    host.at(host.now() + 600_000);
    setLogs(grantedLine);
    expect(await runFleetPostRollCheck(engine, { dir, now: host.now })).toMatchObject({ detail: "PASS" });
    expect(readJson(dir, POST_ROLL_RESULT_FILE)).toMatchObject({ verdict: "PASS", generation: 3 });
  });

  it("RED: an armed file whose time has passed with no verdict is armed again by the next scheduled run", async () => {
    const { dir, engine, calls } = await rolled({}, 1);
    const { armedAtMs } = readJson(dir, POST_ROLL_ARMED_FILE) as { armedAtMs: number };
    const host = hostClock(armedAtMs + 11 * 60_000);
    expect(await runFleetUpdate(engine, { dir, now: host.now, sleep: host.sleep })).toMatchObject({ outcome: "current", detail: "not_newer" });
    expect(calls.armed).toEqual([{ dir, delayMs: 600_000 }, { dir, delayMs: RETRY_MS }]);
  });

  it("RED: a check Docker kept from judging is armed again by the next scheduled run", async () => {
    const { dir, engine, calls } = await rolled({}, 1);
    const { armedAtMs } = readJson(dir, POST_ROLL_ARMED_FILE) as { armedAtMs: number };
    const host = hostClock(armedAtMs + 600_000);
    expect(await runFleetPostRollCheck({ ...engine, supervisor: async () => undefined }, { dir, now: host.now })).toMatchObject({ detail: "docker_unavailable" });
    host.at(armedAtMs + 15 * 60_000);
    await runFleetUpdate(engine, { dir, now: host.now, sleep: host.sleep });
    expect(calls.armed).toEqual([{ dir, delayMs: 600_000 }, { dir, delayMs: RETRY_MS }]);
  });

  it("RED: a host that cannot arm it, or an arm that throws, leaves the run's result and the lock as they were", async () => {
    const { dir, engine } = await rolled({}, 1);
    const { armedAtMs } = readJson(dir, POST_ROLL_ARMED_FILE) as { armedAtMs: number };
    let attempts = 0;
    for (const arm of [async () => (attempts++, false), async () => { attempts++; throw new Error("systemd-run"); }]) {
      const host = hostClock(armedAtMs + 11 * 60_000);
      expect(await runFleetUpdate({ ...engine, armPostRollCheck: arm }, { dir, now: host.now, sleep: host.sleep }))
        .toMatchObject({ outcome: "current", detail: "not_newer", exitCode: 0 });
      expect(existsSync(join(dir, "update.lock"))).toBe(false);
    }
    expect(attempts).toBe(2);
    expect(existsSync(join(dir, POST_ROLL_ARMED_FILE))).toBe(true);
  });

  it("NEGATIVE: a run inside the 10 minutes, a --check, and a run that finds the lock held arm nothing", async () => {
    const { dir, engine, calls } = await rolled({}, 1);
    const { armedAtMs } = readJson(dir, POST_ROLL_ARMED_FILE) as { armedAtMs: number };
    await runFleetUpdate(engine, { dir, ...hostClock(armedAtMs + 5 * 60_000) });
    await runFleetUpdate(engine, { dir, check: true, ...hostClock(armedAtMs + 11 * 60_000) });
    holdLock(dir);
    expect(await runFleetUpdate(engine, { dir, ...hostClock(armedAtMs + 11 * 60_000) })).toMatchObject({ outcome: "retained", detail: "update_running" });
    expect(calls.armed).toEqual([{ dir, delayMs: 600_000 }]);
  });

  it("the check's own line is unchanged: it still says update_running and exits 0", async () => {
    const { dir, engine } = await rolled();
    holdLock(dir);
    const ctx = makeCtx(tempHome());
    expect(await main(["runner", "update", "--fleet", "--post-roll-check", "--dir", dir], ctx, { runner: { fleetEngine: engine } })).toBe(0);
    expect(ctx.out).toEqual(["Post-roll check: update_running."]);
  });

  it("RED: a late judgment after a run that did not finish refuses to roll back onto the release's own file", async () => {
    const { dir, engine, calls, armedAtMs, host, run, letGo, setLogs } = await scheduledRunHoldingTheLock({ logsFor: newerFails });
    host.at(armedAtMs + 600_000);
    await runFleetPostRollCheck(engine, { dir, now: host.now });
    letGo();
    await run;
    const compose = readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8");
    expect(readFileSync(join(dir, PREVIOUS_COMPOSE_FILE), "utf8")).toBe(compose);
    const recreates = calls.recreate;
    setLogs(lines(noResponseLine, 3));
    host.at(host.now() + RETRY_MS);
    expect(await runFleetPostRollCheck(engine, { dir, now: host.now })).toMatchObject({ detail: "ROLLBACK_REFUSED", exitCode: 1 });
    expect(readJson(dir, POST_ROLL_RESULT_FILE)).toMatchObject({ verdict: "ROLLBACK_REFUSED", generation: 2, reason: "previous_compose_is_this_release" });
    expect(calls.recreate).toBe(recreates);
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(compose);
    expect(existsSync(join(dir, POST_ROLL_ARMED_FILE))).toBe(false);
    const ctx = makeCtx(tempHome());
    await main(["runner", "update", "--fleet", "--check", "--dir", dir], ctx, { runner: { fleetEngine: engine } });
    expect(ctx.out.join("\n")).toContain("did not roll back (previous_compose_is_this_release; generation 2;");
  });

  it("the re-arm is the same transient timer, 5 minutes out, replacing whatever was armed", async () => {
    const calls: [string, string[]][] = [];
    const run = (cmd: string, args: string[]) => (calls.push([cmd, args]), { status: 0, stdout: "", stderr: "" });
    const engine = dockerFleetUpdateEngine({ env: { PATH: "/usr/bin:/bin", HOME: "/root" }, timer: { platform: "linux", uid: 0, command: ["/usr/bin/node", "/opt/catalyst/cli.js"], run } });
    expect(await engine.armPostRollCheck("/srv/fleet", RETRY_MS)).toBe(true);
    expect(calls[0]).toEqual(["systemctl", ["stop", "catalyst-fleet-post-roll.timer", "catalyst-fleet-post-roll.service"]]);
    expect(calls[1]![1]).toContain("--on-active=300s");
  });
});

// CTC-8163: a busy host re-adopts its live sessions before its supervisor qualifies. On hetzner-3072373
// that took 240 to 300 seconds, past the fixed 240 the updater gave every recreate, so the release and
// then its rollback both timed out. The timed fake below logs each line a set number of seconds after
// its container started, on the same simulated clock the update polls with.

/** What one recreated supervisor does, in seconds after it started. */
interface Timeline {
  lines?: readonly (readonly [number, string])[];
  restartAt?: number;
  otherImageAt?: number;
  /** Its log cannot be read from this second on. */
  unreadableAt?: number;
}
const at = (seconds: number, ...texts: string[]) => texts.map((text) => [seconds, text] as const);
const scopeEvent = (event: string, scope: string, fields: Record<string, unknown> = {}) => {
  const [tenant = "", team = ""] = scope.split("/");
  return `2026-10-27T16:00:00Z ${JSON.stringify({ event, tenant, team, ...fields })}`;
};
const TENURE = `2026-10-27T16:00:00Z ${JSON.stringify({ event: "supervisor_fleet_tenure", tenure: 1, instanceId: "inst_1" })}`;
const readoptedLine = (scope: string) => scopeEvent("supervisor_readopted", scope, { continued: 1, stopped: 0 });
const readyLine = (scope: string) => scopeEvent("host_ready", scope, { freeSlots: 0 });
const qualifiedScope = (scope: string) => scopeEvent("supervisor_scope_qualified", scope, { hostId: "host_x" });
/** A gate snapshot for `scope` with the named conditions false. */
const gateLine = (scope: string, failing: string[] = []) => scopeEvent("supervisor_scope_qualification_state", scope,
  Object.fromEntries(["resourcesReady", "scopeEligible", "readyUntilValid", "sessionsReadopted"].map((field) => [field, !failing.includes(field)])));

/** hetzner-3072373's timing: tenure at +94 s, every saved scope re-adopted at +161 and ready at +238,
 *  then qualified one by one from +245 to +300. */
const busyHost = (scopes: readonly string[] = FIFTEEN): Timeline => ({
  lines: [
    ...at(94, TENURE),
    ...at(161, ...scopes.map(readoptedLine)),
    ...at(238, ...scopes.map(readyLine)),
    ...scopes.map((scope, i) => [245 + Math.round((i * 55) / Math.max(1, scopes.length - 1)), qualifiedScope(scope)] as const),
  ],
});
/** Every saved scope qualified at once. */
const quick = (scopes: readonly string[] = FIFTEEN): Timeline => ({ lines: at(0, ...scopes.map(qualifiedScope)) });

/** A fleet serving the fifteen scopes whose recreated supervisors follow `timeline`. `upSince` is when the
 *  supervisor the run starts from was started. */
function timedFleet(dir: string, timeline: (roll: "candidate" | "previous") => Timeline, setup: { fake?: FakeOptions; upSince?: string } = {}) {
  const host = clock();
  const t0 = host.now();
  const fleet = fake(dir, { before: servingScopes(FIFTEEN), ...setup.fake });
  /** Each recreate and each line the update reported, in order. */
  const order: string[] = [];
  /** Seconds after the run began that each recreate happened. */
  const recreatedAt: number[] = [];
  let current: { startMs: number; timeline: Timeline } | null = null;
  const engine: FleetUpdateEngine = {
    ...fleet.engine,
    recreate: async (...args) => {
      const ok = await fleet.engine.recreate(...args);
      const roll = fleet.calls.recreatedOn.at(-1) === NEW.supervisor ? "candidate" : "previous";
      current = { startMs: host.now(), timeline: timeline(roll) };
      recreatedAt.push((host.now() - t0) / 1000);
      order.push(`recreate ${roll}`);
      return ok;
    },
    supervisor: async (...args) => {
      const live = await fleet.engine.supervisor(...args);
      const roll = current;
      if (!live) return live;
      if (roll === null) return setup.upSince ? { ...live, startedAt: setup.upSince } : live;
      const age = (host.now() - roll.startMs) / 1000;
      if (roll.timeline.restartAt !== undefined && age >= roll.timeline.restartAt) return { ...live, restartCount: 1 };
      if (roll.timeline.otherImageAt !== undefined && age >= roll.timeline.otherImageAt) return { ...live, image: OLD.supervisor };
      return live;
    },
    logs: async (...args) => {
      const roll = current;
      if (roll === null) return fleet.engine.logs(...args);
      const age = (host.now() - roll.startMs) / 1000;
      if (roll.timeline.unreadableAt !== undefined && age >= roll.timeline.unreadableAt) return null;
      return (roll.timeline.lines ?? []).filter(([second]) => second <= age).map(([, text]) => text).join("\n");
    },
  };
  const run = (report: (line: string) => void = (line) => void order.push(line)) =>
    runFleetUpdate(engine, { dir, now: host.now, sleep: host.sleep, onQualificationPending: report });
  return { ...fleet, engine, run, order, recreatedAt, pending: () => order.filter((entry) => !entry.startsWith("recreate ")) };
}

describe("fleet update: a supervisor still making progress gets time to qualify (CTC-8163)", () => {
  it("RED: a busy host whose new supervisor qualifies 245 to 300 s after it starts applies the release with one recreate", async () => {
    const { dir } = install();
    const fleet = timedFleet(dir, (roll) => (roll === "candidate" ? busyHost() : quick()));
    expect(await fleet.run()).toMatchObject({ outcome: "updated", detail: "updated:runner,supervisor", generation: 2, exitCode: 0 });
    expect(fleet.order).toEqual(["recreate candidate"]);
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(NEW_COMPOSE);
    expect(readReleaseState(dir)).toMatchObject({ generation: 2, last: { outcome: "updated" } });
    expect(existsSync(join(dir, IN_FLIGHT_FILE))).toBe(false);
  });

  it("RED: a candidate that fails fast is restored within a minute, and a restore that qualifies by +300 s is a clean rollback", async () => {
    const { dir, text } = install();
    const fleet = timedFleet(dir, (roll) => (roll === "candidate" ? { lines: at(15, notReadyLine("tenant-1", "T01")) } : busyHost()));
    expect(await fleet.run()).toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_qualified", generation: null, exitCode: 1 });
    expect(fleet.order).toEqual(["recreate candidate", "recreate previous"]);
    expect(fleet.recreatedAt).toEqual([0, 20]);
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
    expect(existsSync(join(dir, IN_FLIGHT_FILE))).toBe(false);
    expect(readReleaseState(dir)).toMatchObject({ generation: null, last: { outcome: "rolled_back", detail: "new_supervisor_not_qualified" } });
  });

  /** Tenure and every re-adoption already logged, which moves the deadline to +320 s. */
  const progressing = (then: Timeline): Timeline => ({ ...then, lines: [...at(94, TENURE), ...at(161, ...FIFTEEN.map(readoptedLine)), ...(then.lines ?? [])] });
  it.each<[string, Timeline]>([
    ["logs host_not_ready for a saved scope", progressing({ lines: at(171, notReadyLine("tenant-1", "T01")) })],
    ["restarts", progressing({ restartAt: 171 })],
    ["runs another image", progressing({ otherImageAt: 171 })],
  ])("NEGATIVE: a candidate that has shown progress and then %s is restored at the next poll", async (_label, candidate) => {
    const { dir } = install();
    const fleet = timedFleet(dir, (roll) => (roll === "candidate" ? candidate : quick()));
    expect(await fleet.run()).toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_qualified", exitCode: 1 });
    expect(fleet.recreatedAt).toEqual([0, 180]);
    expect(fleet.pending()).toEqual([]);
  });

  it.each<[string, number, Timeline]>([
    ["a silent candidate", 240, {}],
    ["a candidate that keeps re-adopting scopes and never qualifies", 420,
      { lines: [...at(94, TENURE), ...FIFTEEN.map((scope, i) => [100 + i * 20, readoptedLine(scope)] as const)] }],
    ["a candidate whose later lines only repeat a step or name another scope", 250, {
      lines: [
        ...at(100, TENURE, readoptedLine("tenant-0/T00")),
        ...at(200, TENURE, readoptedLine("tenant-0/T00"), readoptedLine("tenant-9/ADV"), readyLine("tenant-9/ADV"),
          '{"event":"supervisor_readopted","tenant":"tenant-0"}', '{"event":"host_ready","freeSlots":0}', "supervisor_readopted tenant-0/T00"),
      ],
    }],
    ["a candidate with a scope ready but not re-adopted", 240, { lines: at(150, readyLine("tenant-0/T00")) }],
    ["a candidate with a scope ready, then re-adopted", 380, { lines: [...at(150, readyLine("tenant-0/T00")), ...at(225, readoptedLine("tenant-0/T00"))] }],
    ["a candidate with a scope re-adopted and its readiness pending", 350, { lines: at(200, readoptedLine("tenant-0/T00")) }],
  ])("the deadline: %s is restored at +%i s", async (_label, restoredAt, candidate) => {
    const { dir } = install();
    const fleet = timedFleet(dir, (roll) => (roll === "candidate" ? candidate : quick()));
    expect(await fleet.run()).toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_qualified" });
    expect(fleet.recreatedAt).toEqual([0, restoredAt]);
  });

  /** The host as a rollback that did not qualify left it: compose.json on the previous release, which
   *  the running supervisor runs and which has qualified 8 of the 15 saved scopes so far. */
  function afterSlowRollback(upSince: string) {
    const { dir, text } = install();
    writeFileSync(join(dir, PREVIOUS_COMPOSE_FILE), text, { mode: 0o600 });
    writeFileSync(join(dir, IN_FLIGHT_FILE), JSON.stringify({ version: 1, scopes: FIFTEEN, atMs: 1 }));
    return { dir, ...timedFleet(dir, () => quick(), { fake: { before: servingScopes(FIFTEEN.slice(0, 8)) }, upSince }) };
  }

  it("RED: a run 250 s after the previous supervisor started keeps every saved scope it is still qualifying", async () => {
    const fleet = afterSlowRollback("2026-10-22T19:55:50Z");
    expect(await fleet.run()).toMatchObject({ outcome: "updated", detail: "updated:runner,supervisor", generation: 2 });
    expect(fleet.calls.inFlight).toEqual([[...FIFTEEN].sort()]);
  });

  it("POSITIVE CONTROL: a run 430 s after it started, past the most any supervisor is given, drops the scopes it no longer qualifies", async () => {
    const fleet = afterSlowRollback("2026-10-22T19:52:50Z");
    const gone = FIFTEEN.slice(8).sort();
    expect(await fleet.run()).toMatchObject({ outcome: "updated", detail: `updated:runner,supervisor;dropped_scope:${gone.join(",")}` });
    expect(fleet.calls.inFlight).toEqual([FIFTEEN.slice(0, 8).sort()]);
  });
});

describe("fleet update: each saved scope still unqualified at the deadline is named before the restore (CTC-8163)", () => {
  const T13 = "tenant-1/T13";
  const T10 = "tenant-2/T10";
  /** Every saved scope qualified at once except `missing`; `extra` logged at +30 s. */
  const allBut = (missing: readonly string[], ...extra: string[]): Timeline => ({
    lines: [...at(0, ...FIFTEEN.filter((scope) => !missing.includes(scope)).map(qualifiedScope)), ...at(30, ...extra)],
  });
  const pending = (roll: string, scope: string, failed: string) => `fleet qualification pending: roll=${roll} scope=${scope} failed=${failed}`;

  it("RED: a scope whose sessions were not re-adopted is named with that condition after the candidate's deadline, before the restore", async () => {
    const { dir } = install();
    const fleet = timedFleet(dir, (roll) => (roll === "candidate" ? allBut([T13], gateLine(T13, ["sessionsReadopted"])) : quick()));
    expect(await fleet.run()).toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_qualified", exitCode: 1 });
    expect(fleet.order).toEqual(["recreate candidate", pending("candidate", T13, "sessions_readopted"), "recreate previous"]);
  });

  it.each<[string, string[], string]>([
    ["two conditions failing are both named, sorted", [gateLine(T13, ["sessionsReadopted", "resourcesReady"])], "resources_ready,sessions_readopted"],
    ["the latest valid line is the one read", [gateLine(T13, ["scopeEligible"]), gateLine(T13, ["readyUntilValid"])], "ready_until"],
    ["a malformed line is skipped for the latest valid one", [gateLine(T13, ["scopeEligible"]),
      scopeEvent("supervisor_scope_qualification_state", T13, { resourcesReady: true, scopeEligible: "yes", readyUntilValid: true, sessionsReadopted: false })], "scope_eligible"],
    ["only a malformed line", [scopeEvent("supervisor_scope_qualification_state", T13, { resourcesReady: true })], "diagnostic_unavailable"],
    ["no gate line, as from an older supervisor image", [], "diagnostic_unavailable"],
    ["only another scope's gate line", [gateLine("tenant-9/ADV", ["sessionsReadopted"])], "diagnostic_unavailable"],
    ["every condition held but no qualification line came", [gateLine(T13)], "qualification_event_missing"],
  ])("%s", async (_label, extra, failed) => {
    const { dir } = install();
    const fleet = timedFleet(dir, (roll) => (roll === "candidate" ? allBut([T13], ...extra) : quick()));
    await fleet.run();
    expect(fleet.pending()).toEqual([pending("candidate", T13, failed)]);
  });

  it("two missing scopes get one line each, sorted, and no scope that qualified is named", async () => {
    const { dir } = install();
    const fleet = timedFleet(dir, (roll) => (roll === "candidate"
      ? allBut([T10, T13], gateLine(T10, ["resourcesReady"]), gateLine(T13, ["sessionsReadopted"]), gateLine("tenant-0/T00", ["scopeEligible"]))
      : quick()));
    await fleet.run();
    expect(fleet.pending()).toEqual([pending("candidate", T13, "sessions_readopted"), pending("candidate", T10, "resources_ready")]);
  });

  it("the restored supervisor's deadline reads its own log, never the candidate's gate lines", async () => {
    const { dir } = install();
    const fleet = timedFleet(dir, (roll) => (roll === "candidate"
      ? allBut([T13], gateLine(T13, ["sessionsReadopted"]), gateLine(T10, ["resourcesReady"]))
      : allBut([T10])));
    expect(await fleet.run()).toMatchObject({ outcome: "failed", detail: "rollback_not_qualified" });
    expect(fleet.order).toEqual([
      "recreate candidate", pending("candidate", T13, "sessions_readopted"),
      "recreate previous", pending("rollback", T10, "diagnostic_unavailable"),
    ]);
  });

  it("a log that cannot be read at the deadline names every saved scope as unavailable", async () => {
    const { dir } = install();
    const fleet = timedFleet(dir, (roll) => (roll === "candidate" ? { ...allBut([T13], gateLine(T13, ["sessionsReadopted"])), unreadableAt: 200 } : quick()));
    expect(await fleet.run()).toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_qualified" });
    expect(fleet.pending()).toEqual([...FIFTEEN].sort().map((scope) => pending("candidate", scope, "diagnostic_unavailable")));
  });

  it("a report that cannot be written still lets the restore run", async () => {
    const { dir, text } = install();
    const fleet = timedFleet(dir, (roll) => (roll === "candidate" ? allBut([T10, T13]) : quick()));
    let calls = 0;
    const report = (line: string) => {
      if (calls++ === 0) throw new Error("write EPIPE");
      fleet.order.push(line);
    };
    expect(await fleet.run(report)).toMatchObject({ outcome: "rolled_back", detail: "new_supervisor_not_qualified" });
    // The first line, T13's, could not be written; T10's still was, and the restore still ran.
    expect(fleet.order).toEqual(["recreate candidate", pending("candidate", T10, "diagnostic_unavailable"), "recreate previous"]);
    expect(readFileSync(join(dir, FLEET_COMPOSE_FILE), "utf8")).toBe(text);
  });

  it("a saved scope with control characters or no end is printed escaped and cut short", async () => {
    const { dir } = install();
    const odd = "tenant-0/E\u001b[2JVIL\nX\\u0020";
    const long = `tenant-0/${"L".repeat(300)}`;
    writeFileSync(join(dir, IN_FLIGHT_FILE), JSON.stringify({ version: 1, scopes: ["tenant-0/CTC", odd, long], atMs: 1 }));
    const fleet = timedFleet(dir, () => ({ lines: at(0, qualifiedScope("tenant-0/CTC")) }));
    await fleet.run();
    const [first, second] = fleet.pending();
    expect(first).toBe(pending("candidate", "tenant-0/E\\u001b[2JVIL\\u000aX\\u005cu0020", "diagnostic_unavailable"));
    expect(second).toBe(pending("candidate", `tenant-0/${"L".repeat(111)}...`, "diagnostic_unavailable"));
    expect(fleet.pending().some((line) => /[\u0000-\u001f\u007f]/.test(line))).toBe(false);
  });
});

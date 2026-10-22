import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { readReleaseState, type ReleaseComponent } from "../src/runner-update";
import {
  credentialMount,
  FLEET_COMPOSE_FILE,
  notReadyScope,
  PREVIOUS_COMPOSE_FILE,
  qualifiedScopes,
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
}

function fake(dir: string, options: FakeOptions = {}) {
  const calls = { recreate: 0, removed: [] as string[], prepared: [] as string[][] };
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
    desiredRelease: async () => ({ kind: "answered", status: 200, body: { ok: true, release: options.read ?? release() }, hostId: "host_root" }),
    supervisor: async () => live,
    logs: async () => logText,
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
  };
  return { engine, calls };
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

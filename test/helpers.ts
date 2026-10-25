// helpers.ts — the per-test home, a capturing Ctx, a joined config, and a seeded replica file.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath, configPathFor, contractPathFor, defaultReplicaDbFor, type Ctx, type CustomerConfig } from "../src/config";
import { loadContract } from "../src/contract";
import { loadSdk } from "../src/sdk";
import { writerStatePath, type ReplicaWriterState } from "../src/replica";
import { FIXTURE_KEY, FIXTURE_ME_BODY, type FixtureServer } from "./fixture";

export interface TestCtx extends Ctx {
  out: string[];
  err: string[];
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "catalyst-skills-"));
}

export function makeCtx(home: string, overrides: Partial<Ctx> = {}): TestCtx {
  const out: string[] = [];
  const err: string[] = [];
  return {
    // CTC-2160 — `ready` gained its first network call (the published-release lookup); every
    // in-process test seam defaults offline so a test that forgets to inject `fetchLatestRelease`
    // fails loudly instead of quietly reaching the real npm registry. Tests exercising the lookup
    // override this explicitly via `overrides.env`.
    env: { CATALYST_SKILLS_OFFLINE: "1" },
    home,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch,
    now: () => new Date(),
    out,
    err,
    ...overrides,
  };
}

export function joinedConfig(server: FixtureServer, over: Partial<CustomerConfig> = {}): CustomerConfig {
  return {
    baseUrl: server.url,
    key: FIXTURE_KEY,
    account: FIXTURE_ME_BODY.account,
    slug: FIXTURE_ME_BODY.slug,
    name: FIXTURE_ME_BODY.name,
    permissions: [...FIXTURE_ME_BODY.permissions],
    principal: FIXTURE_ME_BODY.principal,
    joinedAt: "2026-09-01T00:00:00Z",
    lastSkillBundleVersion: currentVersion(),
    cliPath: cliPath(),
    ...over,
  };
}

function currentVersion(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

/** Write a joined config (and, unless told otherwise, cache the contract) into `home`. */
export async function seedJoined(home: string, server: FixtureServer, opts: { contract?: boolean; config?: Partial<CustomerConfig> } = {}): Promise<CustomerConfig> {
  const cfg = joinedConfig(server, opts.config);
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(configPathFor(home), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  if (opts.contract !== false) await loadContract(makeCtx(home), cfg, { refresh: true });
  return cfg;
}

export interface SeedReplicaOptions {
  dbPath?: string;
  cursor?: number | null;
  /** Writer-lock heartbeat age in ms; omit for no lock file. */
  heartbeatAgeMs?: number;
  lockPid?: number;
  issues?: { id: string; identifier: string; title: string; state: string; team_id: string; project_id?: string | null; priority?: number }[];
  pulls?: { repo_id: string; number: number; node_id: string; title: string; state: string; merged?: number; linear_issue_identifier?: string }[];
  projects?: { id: string; name: string; state: string }[];
}

/** Seed a real replica file: the SDK's migrations, a `sync_meta` cursor, optional rows and lock. */
export async function seedReplica(home: string, opts: SeedReplicaOptions = {}): Promise<string> {
  const sdk = await loadSdk();
  const schema = await import("@catalyst-cloud/schema");
  const dbPath = opts.dbPath ?? defaultReplicaDbFor(home);
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  const eng = await sdk.nodeSqliteEngine(dbPath);
  schema.applyMigrations({ exec: (s: string) => eng.exec(s), query: (s: string) => eng.all(s) }, schema.MIRROR_MIGRATIONS);
  eng.exec("CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT)");
  if (opts.cursor !== null) eng.run("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('cursor', ?)", String(opts.cursor ?? 10));
  eng.run("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('account', ?)", FIXTURE_ME_BODY.account);
  let n = 0;
  for (const i of opts.issues ?? []) {
    n += 1;
    eng.run(
      "INSERT INTO issues (id, identifier, title, state, team_id, project_id, priority, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      i.id,
      i.identifier,
      i.title,
      i.state,
      i.team_id,
      i.project_id ?? null,
      i.priority ?? 3,
      1_756_100_000_000 + n,
    );
  }
  for (const p of opts.pulls ?? []) {
    eng.run("INSERT INTO pull_requests (repo_id, number, node_id, title, state, merged, linear_issue_identifier, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", p.repo_id, p.number, p.node_id, p.title, p.state, p.merged ?? 0, p.linear_issue_identifier ?? null, 1_756_100_000_000);
  }
  for (const p of opts.projects ?? []) {
    eng.run("INSERT INTO projects (id, name, state, updated_at) VALUES (?, ?, ?, ?)", p.id, p.name, p.state, 1_756_100_000_000);
  }
  eng.close();
  if (opts.heartbeatAgeMs !== undefined) {
    writeFileSync(`${dbPath}.writer.lock`, JSON.stringify({ pid: opts.lockPid ?? process.pid, owner: "test", heartbeat: Date.now() - opts.heartbeatAgeMs }));
  }
  return dbPath;
}

/** Write a writer-state sidecar directly (test-only; production writes it from `replica start`). */
export function seedWriterState(home: string, over: Partial<Omit<ReplicaWriterState, "updatedAt">>, opts: { dbPath?: string } = {}): string {
  const dbPath = opts.dbPath ?? defaultReplicaDbFor(home);
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  const state: ReplicaWriterState = {
    updatedAt: Date.now(),
    pid: process.pid,
    consecutiveFailures: 0,
    lastError: null,
    lastFailureAt: null,
    stopped: null,
    ...over,
  };
  writeFileSync(writerStatePath(dbPath), JSON.stringify(state));
  return dbPath;
}

/** Put (or clear) a team's `dispatchGate` on the cached contract, the way a newer cloud would serve
 *  it. Mirrors how ready.test.ts already tests the optional `skillsBundle` field. */
export function seedTeamGate(home: string, teamIndex: number, gate: unknown | null): void {
  const p = contractPathFor(home);
  const cache = JSON.parse(readFileSync(p, "utf8")) as { doc: { teams: Record<string, unknown>[] } };
  if (gate === null) delete cache.doc.teams[teamIndex]!.dispatchGate;
  else cache.doc.teams[teamIndex]!.dispatchGate = gate;
  writeFileSync(p, JSON.stringify(cache));
}

/** Sleep-based bounded wait: polls `pred` every `stepMs` up to `timeoutMs`. */
export async function waitFor(pred: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

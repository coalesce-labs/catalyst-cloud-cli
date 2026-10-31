import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesiredReleaseRead, DrainRequest, DrainStatus, ReleaseComponent, RunnerUpdateEngine } from "../src/runner-update";

export const hex = (c: string) => c.repeat(64);
export const sha = (c: string) => c.repeat(40);
export const REPO = {
  runner: "ghcr.io/coalesce-labs/catalyst-runner",
  supervisor: "ghcr.io/coalesce-labs/catalyst-supervisor",
  watchdog: "ghcr.io/coalesce-labs/catalyst-deadline-watchdog",
} as const;
export const ref = (component: ReleaseComponent, c: string) => `${REPO[component]}@sha256:${hex(c)}`;

export function release(over: { generation?: number; digits?: [string, string, string]; mutate?: (r: Record<string, unknown>) => void } = {}) {
  const [r, s, w] = over.digits ?? ["1", "2", "3"];
  const image = (component: ReleaseComponent, c: string, src: string) => ({
    reference: ref(component, c),
    digest: `sha256:${hex(c)}`,
    tag: `${REPO[component]}:${sha(src)}${component === "runner" ? "-multiarch" : ""}`,
    sourceSha: sha(src),
  });
  const body: Record<string, unknown> = {
    version: 1,
    releaseId: `hr-${hex(r).slice(0, 16)}-${hex(s).slice(0, 16)}-${hex(w).slice(0, 16)}`,
    generation: over.generation ?? 1,
    approvedAtMs: 1_800_000_000_000,
    runner: image("runner", r, "a"),
    supervisor: image("supervisor", s, "b"),
    watchdog: image("watchdog", w, "b"),
  };
  over.mutate?.(body);
  return body;
}
export const answered = (body: unknown, status = 200): DesiredReleaseRead =>
  ({ kind: "answered", status, body: status === 200 ? { ok: true, release: body } : body, hostId: "host_abc" });

export const ORIGINAL_ENV = [
  "# setup wrote this",
  "CATALYST_HOST_FREE_FLOOR_GIB=25",
  `CATALYST_SUPERVISOR_IMAGE=${ref("supervisor", "a")}`,
  `CATALYST_WATCHDOG_IMAGE=${ref("watchdog", "b")}`,
  `CATALYST_RUNNER_IMAGE=${ref("runner", "c")}`,
  "",
].join("\n");

export function install(env = ORIGINAL_ENV): string {
  const dir = mkdtempSync(join(tmpdir(), "runner-update-"));
  writeFileSync(join(dir, ".env"), env, { mode: 0o600 });
  writeFileSync(join(dir, "compose.yaml"), "name: catalyst-host\n");
  return dir;
}

export type Images = Record<ReleaseComponent, string>;
export const imagesIn = (text: string): Images => {
  const get = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1] ?? "";
  return { runner: get("CATALYST_RUNNER_IMAGE"), supervisor: get("CATALYST_SUPERVISOR_IMAGE"), watchdog: get("CATALYST_WATCHDOG_IMAGE") };
};
export const TARGET: Images = { runner: ref("runner", "1"), supervisor: ref("supervisor", "2"), watchdog: ref("watchdog", "3") };
export const OLD: Images = { runner: ref("runner", "c"), supervisor: ref("supervisor", "a"), watchdog: ref("watchdog", "b") };

export interface FakeOptions {
  read?: DesiredReleaseRead | (() => DesiredReleaseRead);
  /** Attempt counts, one per look (the first look, then the look after the supervisor stops). */
  busy?: (number | null)[];
  prepare?: string | null;
  composeUp?: boolean[];
  /** Whether a supervisor on this image reports host_ready. Default: always. */
  ready?: (supervisorImage: string) => boolean;
  preparationStop?: (supervisorImage: string) => boolean;
  /** Whether a container on these images is up. Default: the supervisor unless stopped, the watchdog always. */
  up?: { supervisor?: (images: Images) => boolean; watchdog?: (images: Images) => boolean };
  /** The authority custody returns for these images, or `{ refused }`. Default: the installed one, unchanged. */
  custody?: (images: Images) => string | { refused: string };
  /** What is running before the update. Default: what `.env` names. */
  live?: Images;
  stop?: boolean;
  onStop?: () => void;
  /** Images Docker refuses to remove, for example because a running phase still uses them. */
  inUse?: (image: string) => boolean;
  phases?: () => number | null;
  drain?: (request: DrainRequest | null) => ReturnType<RunnerUpdateEngine["updateDrain"]>;

}
/** A machine: what runs is what `.env` named at the last successful compose up. */
export function fakeEngine(dir: string, options: FakeOptions = {}) {
  const calls: string[] = [];
  const reports: Array<string | undefined> = [];
  let live: Images = options.live ?? imagesIn(readFileSync(join(dir, ".env"), "utf8"));
  let stopped = false;
  let ups = 0;
  let looks = 0;
  const engine: RunnerUpdateEngine = {
    async desiredRelease(_d, _signal, report) { calls.push("read"); reports.push(report); return typeof options.read === "function" ? options.read() : options.read ?? answered(release()); },
    async updateDrain(_d, request) { calls.push(request === null ? "GET" : request.action === "request" ? `request:${request.generation}` : "release"); return options.drain ? options.drain(request) : { kind: "no_credential" }; },
    async attemptContainers(_d, hostId) { calls.push(`attempts:${hostId}`); return options.phases ? options.phases() : options.busy ? (options.busy[looks++] ?? 0) : 0; },
    async prepare(images) { calls.push(`prepare:${images.length}`); return options.prepare ?? null; },
    async custody(_d, images) {
      calls.push(`custody:${images.supervisor}`);
      const answer = options.custody ? options.custody(images) : "AUTH";
      return typeof answer === "string" ? { authority: answer } : answer;
    },
    async services() {
      return {
        supervisor: { image: live.supervisor, running: !stopped && (options.up?.supervisor?.(live) ?? true), startedAtMs: 1 },
        watchdog: { image: live.watchdog, running: options.up?.watchdog?.(live) ?? true, startedAtMs: 1 },
      };
    },
    async stopSupervisor() { calls.push("stop"); options.onStop?.(); if (options.stop === false) return false; stopped = true; return true; },
    async composeUp() {
      calls.push("up");
      if (!(options.composeUp?.[ups++] ?? true)) return false;
      live = imagesIn(readFileSync(join(dir, ".env"), "utf8"));
      stopped = false;
      return true;
    },
    async supervisorReadySinceStart() { return options.ready ? options.ready(live.supervisor) : true; },
    async supervisorInPreparationStop() { return options.preparationStop?.(live.supervisor) ?? false; },
    async removeImages(images) { calls.push(`rm:${images.join(",")}`); return images.filter((image) => options.inUse?.(image) ?? false); },
  };
  return { engine, calls, reports, live: () => live };
}
export const fastClock = () => {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
};

/** A small in-memory model of the host-scoped cloud drain contract. */
export function fakeDrainCloud(options: { live: () => number; now?: () => number; refuse?: (request: DrainRequest | null) => DesiredReleaseRead | null }) {
  let revision = 0;
  let drain: DrainStatus["drain"] = null;
  let lastCompleted: string | null = null;
  const calls: string[] = [];
  const answered = (body: unknown, status = 200): DesiredReleaseRead => ({ kind: "answered", status, body, hostId: "host_abc" });
  const status = () => ({ ok: true, revision, drain, liveGenerations: options.live() });
  const call = async (request: DrainRequest | null): Promise<DesiredReleaseRead> => {
    calls.push(request === null ? "GET" : request.action === "request" ? `request:${request.generation}` : "release");
    const refused = options.refuse?.(request);
    if (refused) return refused;
    if (!request) return answered(status());
    if (request.action === "request") {
      if (drain?.requestId === request.requestId && drain.generation === request.generation) return answered(status());
      if (drain || request.expectedRevision !== revision) return answered({ ok: false, refusal: "update_drain_conflict" }, 409);
      drain = { requestId: request.requestId, generation: request.generation, requestedAtMs: options.now?.() ?? 1_800_000_000_000, admissionBlocked: true };
      revision++;
      return answered(status());
    }
    if (request.requestId === lastCompleted && drain === null) return answered(status());
    if (!drain || drain.requestId !== request.requestId || request.expectedRevision !== revision)
      return answered({ ok: false, refusal: "update_drain_conflict" }, 409);
    lastCompleted = drain.requestId;
    drain = null;
    revision++;
    return answered(status());
  };
  return { call, calls, status, get drain() { return drain; }, setDrain(value: DrainStatus["drain"]) { drain = value; revision++; } };
}

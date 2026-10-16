import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeConfig, type Ctx, type CustomerConfig } from "../src/config.js";
import {
  dockerRunnerEngine,
  onboardRunnerAdapter,
  RUNNER_HOST_IMAGES,
  runnerDefaultHostName,
  type RunnerEngine,
  type RunnerEngineInfo,
} from "../src/onboard-runner.js";
import { readOnboardJournal, writeOnboardJournal, type OnboardJournal } from "../src/onboard.js";
import { onboardReasonText } from "../src/onboard-next.js";

const now = new Date("2026-10-02T12:00:00.000Z");
const SUPERVISOR = `ghcr.io/coalesce-labs/catalyst-supervisor@sha256:${"a".repeat(64)}`;
const WATCHDOG = `ghcr.io/coalesce-labs/catalyst-deadline-watchdog@sha256:${"b".repeat(64)}`;
const RUNNER = `registry.cloudflare.com/acct/catalyst-runner@sha256:${"c".repeat(64)}`;
const JOIN_TOKEN = "cjt_fixture_join_secret";
const ORG_KEY = "ctc_org_fixture_secret";
const optionalRunnerRows=[
 ["GET","runner-admission"],["PUT","runner-admission"],["POST","runner-keys"],["GET","runner-keys/:requestId"],["DELETE","runner-keys/:requestId"]
].map(([method,path])=>({method,path:"/api/v1/agent/"+path,personalBearer:true,takesWriteBudgetUnit:false,idempotencyKeyField:method==="POST"?"requestId":null}));
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

interface FakeEngine extends RunnerEngine {
  nativeThoughtsCustody(input: { dir: string; supervisorImage: string; runnerImage: string }, signal?: AbortSignal): Promise<ReturnType<typeof nativeCustodyFixture>>;
  calls: string[];
  images: Map<string, string>;
  networkState: "ready" | "missing" | "misshaped";
  running: boolean;
  files: Map<string, string>;
  upError: string | false;
  containers: Array<{ service: string; state: string }> | null;
  unpauseFails: boolean;
}
const custodyKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
function nativeCustodyFixture(dir: string) {
  const state = join(dir, "..", "darwin-thoughts-custody");
  const authority = { version: 1 as const, installationId: "a".repeat(64), publicKey: custodyKey,
    nativeUid: 501, nativeGid: 20, nativeHome: join(dir, "..", ".."), endpoint: "unix:///fixture/docker.sock", daemonId: "fixture-daemon",
    thoughtsRoot: join(dir, "thoughts"), locksRoot: join(dir, "locks"), requestsRoot: join(dir, "..", "darwin-thoughts-requests"), responsesRoot: join(dir, "..", "darwin-thoughts-responses") };
  return { authority, envAuthority: JSON.stringify(Object.fromEntries(Object.entries(authority).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))),
    requestsRoot: authority.requestsRoot, responsesRoot: authority.responsesRoot, configPath: join(state, "producer.json"), serviceLabel: "dev.catalystcloud.runner.darwin-thoughts-custody" };
}
function fakeEngine(
  info: RunnerEngineInfo | null = { arch: "arm64", vm: true },
): FakeEngine {
  const engine: FakeEngine = {
    calls: [],
    images: new Map([
      [SUPERVISOR, "arm64"],
      [WATCHDOG, "arm64"],
      [RUNNER, "arm64"],
    ]),
    networkState: "missing",
    running: false,
    files: new Map(),
    upError: false,
    containers: null,
    unpauseFails: false,
    info: async () => {
      engine.calls.push("info");
      return info;
    },
    imageArch: async (ref) => {
      engine.calls.push(`imageArch ${ref}`);
      return engine.images.get(ref) ?? null;
    },
    pull: async (ref) => {
      engine.calls.push(`pull ${ref}`);
      return false;
    },
    network: async () => engine.networkState,
    createNetwork: async (name) => {
      engine.calls.push(`createNetwork ${name}`);
      engine.networkState = "ready";
      return true;
    },
    socketGid: async () => 991,
    nativeEgressStatus: async()=>true,
    vmCapabilities: async () => { engine.calls.push("vmCapabilities"); return "ready"; },
    nativeThoughtsCustody: async ({ dir }) => { engine.calls.push("nativeThoughtsCustody"); return nativeCustodyFixture(dir); },
    claimDirs: async (dir, paths) => {
      engine.calls.push(`claimDirs ${paths.length}`);
      return true;
    },
    hasVolumeFile: async (_dir, variable) => engine.files.has(variable),
    enrollment: async (dir) => {
      try {
        const stored = JSON.parse(engine.files.get("CATALYST_HOST_CREDENTIAL_FILE") ?? "null");
        if (stored?.enrollment !== null) return stored?.enrollment ?? null;
        const token = /^CATALYST_HOST_JOIN_TOKEN=(.*)$/m.exec(readFileSync(join(dir,".env"),"utf8"))?.[1]?.replace(/^'|'$/g,"");
        return { unenrolled: true, tokenSpent: !token || stored.spentJoinTokens.includes(createHash("sha256").update(token).digest("hex")) };
      }
      catch { return null; }
    },
    orgKeyStatus: async (_dir, _account, _baseUrl, candidate) => {
      const stored = engine.files.get("CATALYST_ORG_KEY_FILE");
      const key = candidate ?? stored;
      if (!key) return "missing";
      if (!key.startsWith("ctc_org_")) return "invalid";
      return candidate && candidate !== stored ? "different" : "valid";
    },
    writeVolumeFile: async (_dir, variable, value) => {
      engine.calls.push(`writeVolumeFile ${variable}`);
      engine.files.set(variable, value);
      return true;
    },
    composeUp: async () => {
      engine.calls.push("composeUp");
      if (engine.upError !== false)
        return { ok: false, ...(engine.upError ? { error: engine.upError } : {}) };
      engine.running = true;
      return { ok: true };
    },
    projectContainers: async () => {
      engine.calls.push("projectContainers");
      return engine.containers;
    },
    composeUnpause: async () => {
      engine.calls.push("composeUnpause");
      if (engine.unpauseFails) return false;
      for (const row of engine.containers ?? []) if (row.state === "paused") row.state = "running";
      return true;
    },
    composeRunning: async () => engine.running,
  };
  return engine;
}

interface Host {
  hostId: string;
  hostName: string;
  team: string;
  enrollmentKind: string;
  revokedAtMs: number | null;
  capability: {
    placeableCapacity: number;
    runtimeLive: boolean;
    failingRequired: string[];
    receivedAtMs: number;
  } | null;
}

function fixture(
  options: {
    role?: "owner" | "admin" | "member";
    engine?: FakeEngine;
    selected?: boolean;
    choose?: () => Promise<boolean | null>;
    env?: NodeJS.ProcessEnv;
    hostRoutes?: boolean;
    runnerCloud?: boolean;
    capacityMapped?: boolean;
  } = {},
) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "onboard-runner-"));
  homes.push(home);
  const config: CustomerConfig = {
    baseUrl: "https://cloud.example.test",
    account: "account-a",
    slug: "a",
    name: "Private Workspace",
    permissions: ["mirror:read", "mirror:write"],
    principal: "service",
    key: "ctc_user_fixture_secret",
    user: {
      id: "person-a",
      role: options.role ?? "owner",
      label: "Private Person",
      email: "private@example.test",
      linearUserId: null,
    },
    joinedAt: now.toISOString(),
    lastSkillBundleVersion: "fixture",
  };
  writeConfig(home, config);
  const journal: OnboardJournal = {
    schema: 1,
    runId: "runner-run",
    cli: "fixture",
    installer: null,
    tenant: "account-a",
    account: "account-a",
    membershipId: "person-a",
    baseUrl: config.baseUrl,
    exit: null,
    steps: [
      {
        id: "linear.team",
        state: "done",
        evidence: { team: "team-a", teamKey: "A" },
      },
    ],
    changes: [],
  };
  const routes = [
    {
      method: "GET",
      path: "/api/v1/me/runner-capacity",
      personalBearer: true,
    },
    ...(options.hostRoutes === false
      ? []
      : [
          {
            method: "GET",
            path: "/api/v1/hosts/enrollments",
            personalBearer: true,
          },
          {
            method: "POST",
            path: "/api/v1/hosts/join-tokens",
            personalBearer: true,
          },
        ]),
  ];
  const state = {
    hosts: [] as Host[],
    admission: true,
    capacityMapped: options.capacityMapped ?? true,
    // A host enrolls as soon as its supervisor starts with a minted token.
    enrollOnUp: true as boolean,
    minimumEnrollmentMint: 1,
    admissionWrites: [] as unknown[],
    keyMints: [] as unknown[],
    capability: {
      placeableCapacity: 2,
      runtimeLive: true,
      failingRequired: [] as string[],
      receivedAtMs: now.getTime(),
    } as Host["capability"],
    mints: [] as unknown[],
  };
  const engine = options.engine ?? fakeEngine();
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe(config.baseUrl);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer ctc_user_fixture_secret",
    );
    expect(new Headers(init?.headers).get("origin")).toBeNull();
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/v1/agent/contract")
      return Response.json({
        contractVersion: "2.3.0",
        account: { id: "account-a" },
        ...(options.runnerCloud ? {runnerOnboarding:{schema:1,routes:optionalRunnerRows}} : {}),
        onboarding: {
          schema: 1,
          routes,
          web: {
            connections: "/a/account/connections",
            personalConnections: "/settings/connected-accounts",
          },
        },
      });
    if(options.runnerCloud && url.pathname === "/api/v1/agent/runner-admission") {
      expect(url.searchParams.get("team")).toBe("team-a");
      if(method==="PUT"){const body=JSON.parse(String(init?.body));state.admissionWrites.push(body);state.admission=true;}
      return Response.json({account:"account-a",team:"team-a",admissionEnabled:state.admission,revision:1,changed:method==="PUT"});
    }
    if(options.runnerCloud && url.pathname === "/api/v1/agent/runner-keys") {
      const body=JSON.parse(String(init?.body));state.keyMints.push(body);
      return Response.json({account:"account-a",requestId:body.requestId,status:"issued",key:{value:ORG_KEY,permissions:["mirror:read","mirror:write","mirror:feed"]}}, {status:201});
    }
    if (url.pathname === "/api/v1/me")
      return Response.json({
        account: config.account,
        principal: config.principal,
        permissions: config.permissions,
        user: config.user,
        name: config.name,
        slug: config.slug,
      });
    if (url.pathname === "/api/v1/agent/teams")
      return Response.json({
        teams: [{ teamId: "team-a", teamKey: "A", teamName: "Team A" }],
        liveTeamRead: { error: null },
      });
    if (url.pathname === "/api/v1/hosts/enrollments" && method === "GET") {
      if (state.enrollOnUp && engine.running && state.mints.length >= state.minimumEnrollmentMint) {
        const minted = state.mints[state.mints.length - 1] as {
          hostName: string;
        };
        const hostId = `host-${state.mints.length}`;
        if (!state.hosts.some((h) => h.hostId === hostId)) {
          state.hosts.push({
            hostId,
            hostName: minted.hostName,
            team: "A",
            enrollmentKind: "self_hosted",
            revokedAtMs: null,
            capability: state.capability,
          });
        engine.files.set("CATALYST_HOST_CREDENTIAL_FILE", JSON.stringify({
          version: 1, enrollment: { hostId, tenant: config.account, team: "A", enrollmentKind: "self_hosted" },
        }));
        }
      }
      return Response.json({ hosts: state.hosts });
    }
    if (url.pathname === "/api/v1/hosts/join-tokens" && method === "POST") {
      state.mints.push(JSON.parse(String(init?.body)));
      return Response.json(
        {
          ok: true,
          tokenId: "tok-1",
          joinToken: state.mints.length === 1 ? JOIN_TOKEN : `${JOIN_TOKEN}-${state.mints.length}`,
          expiresAtMs: now.getTime() + 3_600_000,
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/api/v1/me/runner-capacity")
      return Response.json({
        status: "ok",
        scope: "mapped-team-defaults",
        observedAtMs: now.getTime(),
        buckets: state.capacityMapped ? [
          {
            repoId: "repo-a",
            effectiveLimit: 3,
            occupiedUnits: 0,
            teams: [
              {
                teamKey: "A",
                configuredLimit: null,
                defaultLimit: 3,
                effectiveTeamLimit: 3,
                source: "default",
                paused: false,
                admissionEnabled: state.admission,
                remainingUnits: state.admission ? 3 : null,
              },
            ],
          },
        ] : [],
      });
    return new Response(null, { status: 404 });
  };
  const output: string[] = [];
  const ctx: Ctx = {
    home,
    env: {
      CATALYST_STATE_DIR: join(home, "state"),
      ...(options.env ?? {
        CATALYST_SUPERVISOR_IMAGE: SUPERVISOR,
        CATALYST_WATCHDOG_IMAGE: WATCHDOG,
        CATALYST_RUNNER_IMAGE: RUNNER,
      }),
    },
    fetch: fetchImpl,
    now: () => now,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
  };
  const messages: string[] = [];
  let asked = 0;
  const adapter = onboardRunnerAdapter({
    selected: options.selected,
    choose: options.choose
      ? async () => {
          asked++;
          return options.choose!();
        }
      : undefined,
    engine,
    hostName: () => "catalyst-laptop",
    sleep: async () => {},
    waitMs: 20_000,
    pollMs: 5_000,
    message: (line) => messages.push(line),
  });
  const dir = join(home, "state", "runner");
  const results: unknown[] = [];
  return {
    results,
    home,
    dir,
    journal,
    state,
    engine,
    requests,
    output,
    messages,
    ctx,
    adapter,
    asked: () => asked,
  };
}

/** What the engine does: check, then act on pending, then check again. */
async function run(f: ReturnType<typeof fixture>) {
  const first = await f.adapter.check(f.ctx, f.journal);
  f.results.push(first);
  if (first.state !== "pending" || !f.adapter.act) return first;
  const acted = await f.adapter.act(f.ctx, f.journal);
  f.results.push(acted);
  const last = acted.state === "done" ? await f.adapter.check(f.ctx, f.journal) : acted;
  f.results.push(last);
  return last;
}

function secretsNowhere(f: ReturnType<typeof fixture>) {
  // What reaches the terminal, the receipt (every step result) and the engine's call log.
  const visible = [
    ...f.messages,
    ...f.output,
    ...f.engine.calls,
    JSON.stringify(f.results),
  ].join("\n");
  expect(visible).not.toContain(JOIN_TOKEN);
  expect(visible).not.toContain(ORG_KEY);
  expect(visible).not.toContain("ctc_user_fixture_secret");
}

describe("release-pinned supervisor receiving", () => {
  const old = `ghcr.io/coalesce-labs/catalyst-supervisor@sha256:${"d".repeat(64)}`;
  function productionImages(initial: "matching" | "stale", pullResult: "matching" | "stale" | "refused" = "matching") {
    const engine = fakeEngine();
    let supervisor = initial === "matching" ? RUNNER_HOST_IMAGES.supervisor : old;
    const reads: string[] = [];
    const pulls: string[] = [];
    const configs: string[] = [];
    const actual = dockerRunnerEngine({
      env: { DOCKER_HOST: "unix:///fixture/docker.sock" },
      exec: async (args, opts) => {
        if (args[0] === "image" && args[1] === "inspect") {
          const requested = args[2]!;
          reads.push(requested);
          const received = requested === RUNNER_HOST_IMAGES.supervisor ? supervisor : requested;
          return { code: 0, stdout: JSON.stringify([{
            Id: `sha256:${"e".repeat(64)}`, Os: "linux", Architecture: "arm64", RepoDigests: [received],
          }]) };
        }
        if (args.includes("pull")) {
          const requested = args.at(-1)!;
          pulls.push(requested);
          const config = args[args.indexOf("--config") + 1]!;
          configs.push(config);
          expect(args.slice(0, 2)).toEqual(["--host", "unix:///fixture/docker.sock"]);
          expect(opts.env?.DOCKER_CONFIG).toBe(config);
          expect(JSON.parse(readFileSync(join(config, "config.json"), "utf8"))).toEqual({ auths: {} });
          if (pullResult === "matching") supervisor = requested;
          return { code: pullResult === "refused" ? 1 : 0, stdout: "" };
        }
        throw Error(`unexpected Docker call: ${args.join(" ")}`);
      },
    });
    engine.imageArch = actual.imageArch;
    engine.pull = actual.pull;
    const enrollment = engine.enrollment;
    engine.enrollment = async (...args) => {
      engine.calls.push("credential-helper");
      return enrollment(...args);
    };
    const f = fixture({ selected: true, runnerCloud: true, env: {}, engine });
    return { f, reads, pulls, configs };
  }

  test("a matching production cache starts the release digest, records it and makes no pull", async () => {
    const x = productionImages("matching");
    const result = await run(x.f);
    expect(result).toMatchObject({ state: "done", evidence: { supervisorImage: RUNNER_HOST_IMAGES.supervisor } });
    if (result.state !== "done") throw Error("expected completed installation receiving");
    expect(x.reads).toEqual(Object.values(RUNNER_HOST_IMAGES).flatMap(ref => [ref, ref]));
    expect(x.pulls).toEqual([]);
    expect(x.f.engine.calls).toContain("composeUp");
    expect(readFileSync(join(x.f.dir, ".env"), "utf8")).toContain(`CATALYST_SUPERVISOR_IMAGE=${RUNNER_HOST_IMAGES.supervisor}\n`);
    const path = join(x.f.home, "install-journal.json");
    writeOnboardJournal(path, { ...x.f.journal, steps: [...x.f.journal.steps, { id: "runner", ...result, state: result.state }] });
    expect(readOnboardJournal(path, x.f.journal.cli)?.steps.find(s => s.id === "runner")?.evidence?.supervisorImage).toBe(RUNNER_HOST_IMAGES.supervisor);
    secretsNowhere(x.f);
  });

  test("a stale arm64 cache is pulled by the release digest and verified again before Compose", async () => {
    const x = productionImages("stale");
    x.f.engine.nativeThoughtsCustody = async ({ dir, supervisorImage }) => {
      expect(supervisorImage).toBe(RUNNER_HOST_IMAGES.supervisor);
      expect(x.reads.filter(ref => ref === supervisorImage)).toHaveLength(2);
      expect(x.pulls).toEqual([supervisorImage]);
      expect(x.f.engine.calls).not.toContain("credential-helper");
      expect(x.f.engine.calls).not.toContain("composeUp");
      return nativeCustodyFixture(dir);
    };
    expect(await run(x.f)).toMatchObject({ state: "done", evidence: { supervisorImage: RUNNER_HOST_IMAGES.supervisor } });
    expect(x.f.engine.calls).toContain("composeUp");
    expect(x.pulls).toEqual([RUNNER_HOST_IMAGES.supervisor]);
    expect(x.configs).toHaveLength(1);
    expect(existsSync(x.configs[0]!)).toBe(false);
    secretsNowhere(x.f);
  });

  test.each(["refused", "stale"] as const)("stale cache and %s pull refuse before credentials, admission or runtime start", async pull => {
    const x = productionImages("stale", pull);
    const result = await x.f.adapter.act!(x.f.ctx, x.f.journal);
    expect(result).toMatchObject({ state: "waiting", reason: "runner_supervisor_image_unavailable",
      evidence: { image: RUNNER_HOST_IMAGES.supervisor, supervisorImage: RUNNER_HOST_IMAGES.supervisor } });
    expect(x.pulls).toEqual([RUNNER_HOST_IMAGES.supervisor]);
    for (const call of ["vmCapabilities", "nativeThoughtsCustody", "credential-helper", "composeUp"])
      expect(x.f.engine.calls).not.toContain(call);
    expect(x.f.engine.calls.some(call => call.startsWith("writeVolumeFile"))).toBe(false);
    expect(x.f.state.mints).toEqual([]);
    expect(x.f.state.keyMints).toEqual([]);
    expect(x.f.state.admissionWrites).toEqual([]);
    expect(x.f.engine.running).toBe(false);
    expect(existsSync(join(x.f.dir, ".env"))).toBe(false);
    expect(x.configs).toHaveLength(1);
    expect(existsSync(x.configs[0]!)).toBe(false);
    if (result.state !== "waiting") throw Error("expected supervisor image refusal");
    expect(onboardReasonText({ id: "runner", ...result, state: result.state }, {})).toContain("supervisor image required by this CLI release");
  });

  test.each([
    { Id: "sha256:bad" }, { Os: "windows" }, { Architecture: "" }, { RepoDigests: [] },
  ])("production cache refuses malformed image metadata %j", async patch => {
    const engine = dockerRunnerEngine({ exec: async () => ({ code: 0, stdout: JSON.stringify([{
      Id: `sha256:${"e".repeat(64)}`, Os: "linux", Architecture: "arm64", RepoDigests: [RUNNER_HOST_IMAGES.supervisor], ...patch,
    }]) }) });
    expect(await engine.imageArch(RUNNER_HOST_IMAGES.supervisor)).toBeNull();
  });

  test("saved intent and a live old supervisor do not satisfy the current release", async () => {
    const x = productionImages("matching");
    expect((await run(x.f)).state).toBe("done");
    const custody = nativeCustodyFixture(x.f.dir);
    for (const root of [custody.requestsRoot, custody.responsesRoot]) mkdirSync(root, { mode: 0o700 });
    const config = { Image: old,
      Env: ["CATALYST_HOST_NAME=catalyst-laptop", "CATALYST_MIRROR_URL=https://cloud.example.test"],
      Labels: { "com.docker.compose.project": "catalyst-host", "com.docker.compose.service": "supervisor",
        "com.docker.compose.project.working_dir": x.f.dir,
        "com.docker.compose.project.config_files": join(x.f.dir, "compose.yaml") + "," + join(x.f.dir, "compose.darwin-thoughts.yaml") } };
    x.f.engine.installation = dockerRunnerEngine({ exec: async args => {
      if (args[0] === "ps") return { code: 0, stdout: "e".repeat(64) };
      if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ Config: config }]) };
      throw Error(`unexpected Docker call: ${args.join(" ")}`);
    } }).installation;
    expect(await x.f.adapter.check(x.f.ctx, x.f.journal)).toEqual({ state: "pending" });
    config.Image = RUNNER_HOST_IMAGES.supervisor;
    expect(await x.f.adapter.check(x.f.ctx, x.f.journal)).toMatchObject({ state: "done" });
  });
});

describe("opting in", () => {
  test("without a choice and without a terminal it is skipped and touches nothing", async () => {
    const f = fixture();
    expect(await run(f)).toEqual({
      state: "skipped",
      reason: "runner_not_selected",
    });
    expect(f.engine.calls).toEqual([]);
    expect(f.requests).toEqual([]);
    expect(existsSync(f.dir)).toBe(false);
  });

  test("--no-runner wins over the question", async () => {
    const f = fixture({ selected: false, choose: async () => true });
    expect((await run(f)).reason).toBe("runner_not_selected");
    expect(f.asked()).toBe(0);
  });

  test("the question defaults to no", async () => {
    const f = fixture({ choose: async () => false });
    expect((await run(f)).reason).toBe("runner_not_selected");
    expect(f.asked()).toBe(1);
    expect(f.engine.calls).toEqual([]);
  });

  test("a cancelled question is not a yes", async () => {
    const f = fixture({ choose: async () => null });
    expect((await run(f)).reason).toBe("runner_not_selected");
  });

  test("a yes is asked once per run and remembered in the receipt", async () => {
    const f = fixture({ choose: async () => true });
    const result = await run(f);
    expect(result.reason).toBe("runner_org_key_missing");
    expect(f.asked()).toBe(1);
    expect(result.evidence?.selected).toBe(true);
    // A later run reads the saved choice instead of asking again.
    const later = fixture({ choose: async () => false });
    later.journal.steps.push({
      id: "runner",
      state: "waiting",
      reason: "runner_org_key_missing",
      evidence: { selected: true },
    });
    await later.adapter.check(later.ctx, later.journal);
    expect(later.asked()).toBe(0);
  });

  test("an earlier no is not asked again without the flag", async () => {
    const f = fixture({ choose: async () => true });
    f.journal.steps.push({
      id: "runner",
      state: "skipped",
      reason: "runner_not_selected",
      evidence: { selected: false },
    });
    expect((await run(f)).reason).toBe("runner_not_selected");
    expect(f.asked()).toBe(0);
  });
});

describe("prerequisites", () => {
  test.each([
    "runner_home_mount_unwritable", "runner_container_host_unreachable",
    "runner_container_network_unreachable", "runner_engine_probe_unavailable",
  ] as const)("a failed VM capability probe stops before enrollment or start: %s", async reason => {
    const engine = fakeEngine();
    engine.vmCapabilities = async (dir, image, baseUrl) => {
      engine.calls.push("vmCapabilities");
      expect(dir).toBe(f.dir); expect(image).toBe(SUPERVISOR);
      expect(baseUrl).toBe("https://cloud.example.test");
      return reason;
    };
    const f = fixture({ selected: true, runnerCloud: true, engine });
    const result = await run(f);
    expect(result).toMatchObject({ state: "waiting", reason, evidence: { selected: true } });
    expect(engine.calls).toContain("vmCapabilities");
    expect(engine.calls).not.toContain("nativeThoughtsCustody");
    expect(engine.calls).not.toContain("composeUp");
    expect(engine.calls.some(call => call.startsWith("writeVolumeFile") || call.startsWith("createNetwork"))).toBe(false);
    expect(f.state.mints).toEqual([]); expect(f.state.keyMints).toEqual([]);
    expect(f.state.admissionWrites).toEqual([]);
    const text = onboardReasonText({ id: "runner", state: "waiting", reason });
    expect(text).toContain("catalyst onboard --runner");
    if (reason === "runner_home_mount_unwritable") {
      expect(text).toContain("writable"); expect(text).toContain("Colima");
      expect(text).toContain("uid 10001");
    }
    if (reason === "runner_container_host_unreachable") expect(text).toContain("reach this Mac");
    if (reason === "runner_container_network_unreachable") expect(text).toContain("health endpoint");
  });

  test("a remote endpoint is named before any local change or cloud request", async () => {
    const engine = fakeEngine({ arch: "arm64", vm: true, unsupported: true,
      unsupportedReason: "runner_engine_nonlocal" });
    const f = fixture({ selected: true, engine });
    expect((await run(f)).reason).toBe("runner_engine_nonlocal");
    expect(existsSync(f.dir)).toBe(false); expect(f.requests).toEqual([]);
    expect(onboardReasonText({ id: "runner", state: "waiting", reason: "runner_engine_nonlocal" }))
      .toContain("unix:///");
  });

  test("no Docker engine is said plainly and skipped, with nothing written", async () => {
    const f = fixture({ selected: true, engine: fakeEngine(null) });
    expect(await run(f)).toEqual({
      state: "skipped",
      reason: "runner_docker_missing",
      evidence: { selected: true },
    });
    expect(existsSync(f.dir)).toBe(false);
    expect(f.requests).toEqual([]);
  });

  test("a member cannot enroll a host", async () => {
    const f = fixture({ selected: true, role: "member" });
    expect((await run(f)).reason).toBe("runner_identity_unverified");
    expect(f.state.mints).toEqual([]);
  });

  test("a server that does not advertise the host routes waits before any local change", async () => {
    const f = fixture({ selected: true, hostRoutes: false });
    expect((await run(f)).reason).toBe("cloud_capability_unavailable");
    expect(existsSync(f.dir)).toBe(false);
    expect(f.engine.calls).toEqual(["info"]);
  });

  test.each([
    { name: "macOS Docker Desktop", arch: "arm64" as const, vm: true },
    { name: "native Linux", arch: "amd64" as const, vm: false },
  ])("supported $name setup prepares missing images before receiving native custody", async (info) => {
    const engine = fakeEngine(info);
    engine.images.clear();
    engine.pull = async (ref) => {
      engine.calls.push(`pull ${ref}`);
      engine.images.set(ref, info.arch);
      return true;
    };
    const f = fixture({ selected: true, runnerCloud: true, engine });
    engine.nativeThoughtsCustody = async ({ dir }) => {
      engine.calls.push("nativeThoughtsCustody");
      for (const ref of [SUPERVISOR, WATCHDOG, RUNNER]) {
        expect(engine.calls.filter(call => call === `pull ${ref}`)).toHaveLength(1);
        expect(engine.images.get(ref)).toBe(info.arch);
      }
      expect(engine.calls).toContain("vmCapabilities");
      expect(engine.calls).not.toContain("composeUp");
      expect(f.state.mints).toEqual([]);
      expect(f.state.keyMints).toEqual([]);
      expect(f.state.admissionWrites).toEqual([]);
      return nativeCustodyFixture(dir);
    };
    expect(await run(f)).toMatchObject({ state: "done" });
    for (const ref of [SUPERVISOR, WATCHDOG, RUNNER])
      expect(engine.calls.filter(call => call === `pull ${ref}`)).toHaveLength(1);
    expect(engine.calls.includes("nativeThoughtsCustody")).toBe(info.vm);
    expect(engine.calls.filter(call => call === "composeUp")).toHaveLength(1);
  });

  test("unavailable VM images stop before custody, enrollment or Compose", async () => {
    const engine = fakeEngine();
    engine.images.delete(SUPERVISOR);
    const f = fixture({ selected: true, engine });
    const result = await run(f);
    expect(result).toMatchObject({
      state: "waiting",
      reason: "runner_supervisor_image_unavailable",
      evidence: { selected: true, image: SUPERVISOR },
    });
    expect(engine.calls.filter(call => call.startsWith("pull "))).toEqual([`pull ${SUPERVISOR}`]);
    expect(engine.calls).not.toContain("nativeThoughtsCustody");
    expect(f.state.mints).toEqual([]);
    expect(engine.calls).not.toContain("composeUp");
  });

  test.each([
    ["pull refused", "runner_supervisor_image_unavailable"],
    ["image still absent", "runner_supervisor_image_unavailable"],
    ["emulated image", "runner_image_emulated"],
    ["interrupted pull", "interrupted"],
  ])("VM image preparation holds on %s before native or credential work", async (kind, reason) => {
    const engine = fakeEngine();
    engine.images.delete(SUPERVISOR);
    const f = fixture({ selected: true, runnerCloud: true, engine });
    const controller = new AbortController();
    const enrollment = engine.enrollment;
    engine.enrollment = async (...args) => {
      engine.calls.push("credential-helper");
      return enrollment(...args);
    };
    engine.pull = async (ref) => {
      engine.calls.push(`pull ${ref}`);
      if (kind === "emulated image") engine.images.set(ref, "amd64");
      if (kind === "interrupted pull") controller.abort();
      return kind !== "pull refused";
    };
    expect(await f.adapter.act!(f.ctx, f.journal, controller.signal)).toMatchObject({ state: "waiting", reason });
    expect(engine.calls.filter(call => call.startsWith("pull "))).toEqual([`pull ${SUPERVISOR}`]);
    for (const call of ["vmCapabilities", "nativeThoughtsCustody", "credential-helper", "composeUp"])
      expect(engine.calls).not.toContain(call);
    expect(f.state.mints).toEqual([]);
    expect(f.state.keyMints).toEqual([]);
    expect(f.state.admissionWrites).toEqual([]);
  });

  test("VM image preparation never substitutes for a fresh signed custody check", async () => {
    const engine = fakeEngine();
    engine.images.delete(SUPERVISOR);
    engine.pull = async (ref) => {
      engine.calls.push(`pull ${ref}`);
      engine.images.set(ref, "arm64");
      return true;
    };
    engine.nativeThoughtsCustody = async () => {
      engine.calls.push("nativeThoughtsCustody");
      throw new Error("darwin_thoughts_custody_install:foreign_owner");
    };
    const f = fixture({ selected: true, runnerCloud: true, engine });
    expect(await run(f)).toMatchObject({ state: "waiting", reason: "runner_thoughts_custody_unavailable" });
    expect(engine.calls).toContain(`pull ${SUPERVISOR}`);
    expect(engine.calls).toContain("nativeThoughtsCustody");
    expect(engine.calls).not.toContain("composeUp");
    expect(engine.calls.some(call => call.startsWith("writeVolumeFile"))).toBe(false);
    expect(f.state.mints).toEqual([]);
    expect(f.state.keyMints).toEqual([]);
    expect(f.state.admissionWrites).toEqual([]);
  });

  test("native custody refusal stops a VM before credential helpers, join, key mint, admission or Compose", async () => {
    const engine = fakeEngine();
    engine.nativeThoughtsCustody = async () => { engine.calls.push("nativeThoughtsCustody"); throw new Error("darwin_thoughts_custody_install:foreign_owner"); };
    const enrollment = engine.enrollment;
    engine.enrollment = async (...args) => { engine.calls.push("credential-helper"); return enrollment(...args); };
    const f = fixture({ selected: true, runnerCloud: true, engine });
    const result = await run(f);
    expect(result).toMatchObject({ state: "waiting", reason: "runner_thoughts_custody_unavailable" });
    expect(engine.calls).toContain("nativeThoughtsCustody");
    expect(engine.calls).not.toContain("credential-helper");
    expect(engine.calls).not.toContain("composeUp");
    expect(engine.calls.some(call => call.startsWith("writeVolumeFile"))).toBe(false);
    expect(f.state.mints).toEqual([]);
    expect(f.state.keyMints).toEqual([]);
    expect(f.state.admissionWrites).toEqual([]);
    expect(existsSync(join(f.dir, ".env"))).toBe(false);
  });

  test.each(["capability_missing", "result_unverified", "call_threw"] as const)(
    "reports custody case %s in output, journal and actual OTLP payload without credentials", async failureCase => {
      const engine = fakeEngine();
      expect(typeof engine.nativeThoughtsCustody).toBe("function");
      if (failureCase === "capability_missing") Object.defineProperty(engine, "nativeThoughtsCustody", { value: undefined });
      else if (failureCase === "result_unverified") engine.nativeThoughtsCustody = async ({ dir }) => {
        const value = nativeCustodyFixture(dir);
        return { ...value, authority: { ...value.authority, installationId: "b".repeat(64) } };
      };
      else engine.nativeThoughtsCustody = async () => { throw new TypeError(JOIN_TOKEN + ORG_KEY); };
      const f = fixture({ selected: true, runnerCloud: true, engine });
      const original = f.ctx.fetch;
      const sent: string[] = [];
      f.ctx.fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/v1/telemetry/token")) return Response.json({ token: "ctc_tel_fixture_export", account: "account-a", scope: "telemetry:write", endpoint: "https://cloud.example.test/api/v1/telemetry" });
        if (url.endsWith("/api/v1/telemetry/v1/logs")) { sent.push(String(init?.body)); return Response.json({}); }
        return original(input, init);
      };
      const result = await run(f);
      expect(result).toMatchObject({ reason: "runner_thoughts_custody_unavailable", evidence: { custodyFailureCase: failureCase, custodyTelemetry: "sent" } });
      expect(f.messages.join("\n")).toContain("Setup could not verify local storage:");
      if (failureCase === "call_threw") expect(result.evidence).toMatchObject({ custodyErrorClass: "TypeError", custodyErrorMessageRedacted: true });
      if (failureCase === "result_unverified") expect(result.evidence).toMatchObject({ custodyResultInstalled: true, custodyAuthorityMatched: false });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('"eventName":"onboarding.runner.custody.refused"');
      expect(sent[0]).toContain('"stringValue":"' + failureCase + '"');
      expect(sent[0]).not.toContain(JOIN_TOKEN); expect(sent[0]).not.toContain(ORG_KEY);
      if (result.state !== "waiting") throw Error("expected a custody refusal receipt");
      f.journal.steps = [{ ...result, id: "runner", state: result.state }];
      const path = join(f.home, "diagnostic-journal.json");
      writeOnboardJournal(path, f.journal);
      expect(readOnboardJournal(path, f.journal.cli)?.steps[0]?.evidence).toEqual(result.evidence);
      expect(engine.calls).not.toContain("composeUp");
      secretsNowhere(f);
    },
  );

  test("fresh native custody reaches the VM installer before credential work and persists only public authority channels", async () => {
    const engine = fakeEngine();
    const f = fixture({ selected: true, runnerCloud: true, engine });
    let custodyReceived = false;
    engine.nativeThoughtsCustody = async (input) => {
      expect(input).toEqual({ dir: f.dir, supervisorImage: SUPERVISOR, runnerImage: RUNNER });
      expect(engine.calls).toContain("vmCapabilities");
      expect(f.state.mints).toEqual([]); expect(f.state.keyMints).toEqual([]); expect(f.state.admissionWrites).toEqual([]);
      expect(engine.calls).not.toContain("composeUp");
      custodyReceived = true;
      return nativeCustodyFixture(f.dir);
    };
    const hasVolumeFile = engine.hasVolumeFile;
    engine.hasVolumeFile = async (...args) => { expect(custodyReceived).toBe(true); return hasVolumeFile(...args); };
    expect((await run(f)).state).toBe("done");
    expect(custodyReceived).toBe(true);
    const installed = nativeCustodyFixture(f.dir);
    const persisted = readFileSync(join(f.dir, ".env"), "utf8");
    expect(persisted).toContain("CATALYST_THOUGHTS_CUSTODY_AUTHORITY='" + installed.envAuthority + "'");
    expect(persisted).toContain("CATALYST_THOUGHTS_CUSTODY_REQUESTS_DIR=" + installed.requestsRoot);
    expect(persisted).toContain("CATALYST_THOUGHTS_CUSTODY_RESPONSES_DIR=" + installed.responsesRoot);
    expect(persisted).not.toContain("private-key.der");
    expect(persisted).not.toContain("producer.json");
    expect(existsSync(join(f.dir, "compose.darwin-thoughts.yaml"))).toBe(true);
  });

  test("native custody receives existing VM install root mode without adopting unsafe permissions", async () => {
    const receiveMode = async (input: { dir: string }) => {
      if ((statSync(input.dir).mode & 0o7777) !== 0o700)
        throw new Error("darwin_thoughts_custody_install:directory_custody_unsafe");
      return nativeCustodyFixture(input.dir);
    };
    const healthyEngine = fakeEngine();
    healthyEngine.nativeThoughtsCustody = receiveMode;
    const healthy = fixture({ selected: true, runnerCloud: true, engine: healthyEngine });
    mkdirSync(healthy.dir, { recursive: true, mode: 0o700 });
    chmodSync(healthy.dir, 0o700);
    expect((await run(healthy)).state).toBe("done");
    expect(statSync(healthy.dir).mode & 0o7777).toBe(0o700);

    const unsafeEngine = fakeEngine();
    unsafeEngine.nativeThoughtsCustody = receiveMode;
    const enrollment = unsafeEngine.enrollment;
    unsafeEngine.enrollment = async (...args) => {
      unsafeEngine.calls.push("credential-helper");
      return enrollment(...args);
    };
    const unsafe = fixture({ selected: true, runnerCloud: true, engine: unsafeEngine });
    mkdirSync(unsafe.dir, { recursive: true, mode: 0o700 });
    chmodSync(unsafe.dir, 0o777);
    expect(statSync(unsafe.dir).mode & 0o7777).toBe(0o777);
    expect(await run(unsafe)).toMatchObject({ state: "waiting", reason: "runner_thoughts_custody_unavailable" });
    expect(statSync(unsafe.dir).mode & 0o7777).toBe(0o777);
    expect(unsafeEngine.calls).not.toContain("credential-helper");
    expect(unsafeEngine.calls).not.toContain("composeUp");
    expect(unsafeEngine.calls.some(call => call.startsWith("writeVolumeFile"))).toBe(false);
    expect(unsafe.state.mints).toEqual([]);
    expect(unsafe.state.keyMints).toEqual([]);
    expect(unsafe.state.admissionWrites).toEqual([]);
  });

  test("re-installing over an existing custody project re-attests on the new pin and reaches Compose again", async () => {
    const engine = fakeEngine();
    const f = fixture({ selected: true, runnerCloud: true, engine });
    expect((await run(f)).state).toBe("done");
    const next = SUPERVISOR.replace("a".repeat(64), "f".repeat(64));
    engine.images.set(next, "arm64");
    f.ctx.env.CATALYST_SUPERVISOR_IMAGE = next;
    let custodyImage: string | undefined;
    engine.nativeThoughtsCustody = async (input) => {
      engine.calls.push("nativeThoughtsCustody");
      custodyImage = input.supervisorImage;
      return nativeCustodyFixture(input.dir);
    };
    expect((await run(f)).state).toBe("done");
    expect(custodyImage).toBe(next);
    expect(readFileSync(join(f.dir, ".env"), "utf8")).toContain(`CATALYST_SUPERVISOR_IMAGE=${next}\n`);
    expect(readFileSync(join(f.dir, ".env"), "utf8")).toContain("CATALYST_THOUGHTS_CUSTODY_AUTHORITY=");
    expect(existsSync(join(f.dir, "compose.darwin-thoughts.yaml"))).toBe(true);
    expect(engine.calls).toContain(`imageArch ${next}`);
    expect(engine.calls.filter(call => call === "composeUp")).toHaveLength(2);
    secretsNowhere(f);
  });

  test("native Linux keeps cached-image pulls and never invokes Darwin custody", async () => {
    const engine = fakeEngine({ arch: "amd64", vm: false });
    for (const ref of [SUPERVISOR, WATCHDOG, RUNNER]) engine.images.set(ref, "amd64");
    engine.images.delete(SUPERVISOR);
    engine.pull = async (ref) => { engine.calls.push(`pull ${ref}`); engine.images.set(ref, "amd64"); return true; };
    const f = fixture({ selected: true, runnerCloud: true, engine });
    expect((await run(f)).state).toBe("done");
    expect(engine.calls).toContain(`pull ${SUPERVISOR}`);
    expect(engine.calls).toContain("claimDirs 3");
    expect(engine.calls).not.toContain("nativeThoughtsCustody");
    expect(readFileSync(join(f.dir, ".env"), "utf8")).not.toContain("CATALYST_THOUGHTS_CUSTODY_");
    expect(existsSync(join(f.dir, "compose.darwin-thoughts.yaml"))).toBe(false);
  });

  test("the default host images are digest-pinned", () => {
    for (const ref of Object.values(RUNNER_HOST_IMAGES))
      expect(ref).toMatch(/^ghcr\.io\/coalesce-labs\/[a-z-]+@sha256:[0-9a-f]{64}$/);
  });

  const PUBLIC_RUNNER = "ghcr.io/coalesce-labs/catalyst-runner@sha256:9db2bf2c5580e2a1459fd076fa32c9af34456cc639ec3ab92b57b6ad98da67fb";
  function defaultFixture() {
    const engine = fakeEngine();
    engine.images.set(RUNNER_HOST_IMAGES.supervisor, "arm64");
    engine.images.set(RUNNER_HOST_IMAGES.watchdog, "arm64");
    engine.images.set(PUBLIC_RUNNER, "arm64");
    const f = fixture({ selected: true, engine, env: {}, runnerCloud: true });
    return f;
  }

  test("fresh opt-in uses the approved public native runner digest", async () => {
    const f = defaultFixture();
    expect((await run(f)).state).toBe("done");
    expect(readFileSync(join(f.dir, ".env"), "utf8")).toContain(`CATALYST_RUNNER_IMAGE=${PUBLIC_RUNNER}\n`);
    expect(f.engine.calls).toContain(`imageArch ${PUBLIC_RUNNER}`);
    expect(f.state.mints).toHaveLength(1);
  });

  test("a saved pinned runner overrides the public default", async () => {
    const f = defaultFixture();
    mkdirSync(f.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(f.dir, ".env"), `CATALYST_RUNNER_IMAGE=${RUNNER}\n`, { mode: 0o600 });
    expect((await run(f)).state).toBe("done");
    expect(f.engine.calls).toContain(`imageArch ${RUNNER}`);
    expect(f.engine.calls).not.toContain(`imageArch ${PUBLIC_RUNNER}`);
  });

  test("an explicit pinned runner overrides a saved runner", async () => {
    const f = defaultFixture();
    mkdirSync(f.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(f.dir, ".env"), `CATALYST_RUNNER_IMAGE=${RUNNER}\n`, { mode: 0o600 });
    f.ctx.env.CATALYST_RUNNER_IMAGE = PUBLIC_RUNNER;
    expect((await run(f)).state).toBe("done");
    expect(f.engine.calls).toContain(`imageArch ${PUBLIC_RUNNER}`);
    expect(f.engine.calls).not.toContain(`imageArch ${RUNNER}`);
    expect(readFileSync(join(f.dir, ".env"), "utf8")).toContain(`CATALYST_RUNNER_IMAGE=${PUBLIC_RUNNER}\n`);
  });

  test.each(["", "ghcr.io/coalesce-labs/catalyst-runner:latest", "not an image"])(
    "explicit invalid runner %j refuses without falling back", async (value) => {
      const f = defaultFixture();
      f.ctx.env.CATALYST_RUNNER_IMAGE = value;
      expect((await run(f)).reason).toBe("runner_image_unpinned");
      expect(f.state.mints).toEqual([]);
      expect(f.state.keyMints).toEqual([]);
      expect(f.engine.calls).toEqual(["info"]);
      expect(existsSync(f.dir)).toBe(false);
    },
  );

  test.each(["", "ghcr.io/coalesce-labs/catalyst-runner:latest", "not-an-image"])(
    "saved invalid runner %j refuses without falling back", async (value) => {
      const f = defaultFixture();
      mkdirSync(f.dir, { recursive: true, mode: 0o700 });
      const saved = `CATALYST_RUNNER_IMAGE=${value}\n`;
      writeFileSync(join(f.dir, ".env"), saved, { mode: 0o600 });
      expect((await run(f)).reason).toBe("runner_image_unpinned");
      expect(f.state.mints).toEqual([]);
      expect(f.state.keyMints).toEqual([]);
      expect(f.engine.calls).toEqual(["info"]);
      expect(readFileSync(join(f.dir, ".env"), "utf8")).toBe(saved);
    },
  );

  test("the public default still refuses an image of a different native architecture", async () => {
    const f = defaultFixture();
    f.engine.images.set(PUBLIC_RUNNER, "amd64");
    expect((await run(f)).reason).toBe("runner_image_emulated");
    expect(f.state.mints).toEqual([]);
    expect(f.state.keyMints).toEqual([]);
    expect(f.state.admissionWrites).toEqual([]);
    expect(f.engine.calls).not.toContain("composeUp");
  });

  test("an image reference that is not digest-pinned is refused", async () => {
    const f = fixture({
      selected: true,
      env: {
        CATALYST_SUPERVISOR_IMAGE: "ghcr.io/coalesce-labs/catalyst-supervisor:latest",
        CATALYST_WATCHDOG_IMAGE: WATCHDOG,
        CATALYST_RUNNER_IMAGE: RUNNER,
      },
    });
    expect((await run(f)).reason).toBe("runner_image_unpinned");
  });

  test("a runner image for another architecture would be emulated, so it waits", async () => {
    const engine = fakeEngine();
    engine.images.set(RUNNER, "amd64");
    const f = fixture({ selected: true, engine });
    expect((await run(f)).reason).toBe("runner_image_emulated");
    expect(f.state.mints).toEqual([]);
  });
});

describe("bringing the host up", () => {
  function withOrgKey(f: ReturnType<typeof fixture>) {
    const file = join(f.home, "org-key");
    writeFileSync(file, `${ORG_KEY}\n`, { mode: 0o600 });
    f.ctx.env.CATALYST_RUNNER_ORG_KEY_FILE = file;
  }

  test("enrolls with the person's key, starts Compose and reports capacity", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    const result = await run(f);
    expect(result).toEqual({
      state: "done",
      evidence: {
        selected: true,
        hostName: "catalyst-laptop",
        hostId: "host-1",
        capacity: 2,
        supervisorImage: SUPERVISOR,
      },
    });
    expect(f.state.mints).toEqual([
      {
        version: 1,
        team: "A",
        enrollmentKind: "self_hosted",
        hostName: "catalyst-laptop",
        ttlMs: 3_600_000,
      },
    ]);
    expect(f.requests).toContain(
      "POST /api/v1/hosts/join-tokens?account=account-a",
    );
    expect(f.engine.calls).toContain("createNetwork catalyst-session-v1");
    expect(f.engine.calls).toContain("writeVolumeFile CATALYST_ORG_KEY_FILE");
    expect(f.engine.files.get("CATALYST_ORG_KEY_FILE")).toBe(ORG_KEY);
    expect(f.engine.calls).not.toContain("claimDirs 3");
    expect(f.messages.join("\n")).toContain("2 slots");
    secretsNowhere(f);

    const env = readFileSync(join(f.dir, ".env"), "utf8");
    expect(statSync(join(f.dir, ".env")).mode & 0o777).toBe(0o600);
    expect(env).toContain(`CATALYST_HOST_JOIN_TOKEN=${JOIN_TOKEN}\n`);
    expect(env).toContain("CATALYST_HOST_NAME=catalyst-laptop\n");
    expect(env).toContain("CATALYST_MIRROR_URL=https://cloud.example.test\n");
    expect(env).toContain(`CATALYST_SUPERVISOR_IMAGE=${SUPERVISOR}\n`);
    expect(env).toContain(`CATALYST_RUNNER_IMAGE=${RUNNER}\n`);
    expect(env).toContain("DOCKER_SOCKET_GID=0\n");
    expect(env).toContain(`CATALYST_SLOTS_DIR=${join(f.dir, "slots")}\n`);
    expect(statSync(join(f.dir, "slots")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(f.dir, "compose.yaml"))).toEqual(
      readFileSync(join(__dirname, "..", "vendor", "self-host", "compose.yaml")),
    );
  });

  test("a host name enrolled for another team never verifies the selected team", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    f.state.hosts[0]!.team = "B";
    f.engine.calls.length = 0;
    expect(await run(f)).toMatchObject({
      state: "waiting",
      reason: "runner_enrolled_for_other_team",
    });
    expect(f.state.mints).toHaveLength(1);
    expect(f.engine.calls).not.toContain("composeUp");
  });

  test("a renamed enrolled machine remains recognized when another team takes its old name",async()=>{
    const f=fixture({selected:true});withOrgKey(f);await run(f);
    const own=f.state.hosts[0];if(!own)throw new Error("missing enrollment");own.hostName="studio-mac";
    f.state.hosts.push({...own,hostId:"host-other",hostName:"catalyst-laptop",team:"B"});
    expect((await run(f)).state).toBe("done");expect(f.state.mints).toHaveLength(1);
  });

  test("a rerun on an enrolled, running host mints nothing and changes nothing", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    const env = readFileSync(join(f.dir, ".env"), "utf8");
    f.engine.calls.length = 0;
    const again = await run(f);
    expect(again.state).toBe("done");
    expect(f.state.mints).toHaveLength(1);
    expect(f.engine.calls).not.toContain("composeUp");
    expect(readFileSync(join(f.dir, ".env"), "utf8")).toBe(env);
  });

  test("losing the credential volume obtains a fresh join token instead of reusing a spent one", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    f.engine.files.delete("CATALYST_HOST_CREDENTIAL_FILE");
    f.engine.running = false;
    const result = await run(f);
    expect(result).toMatchObject({ state: "done", evidence: { hostId: "host-2" } });
    expect(f.state.mints).toHaveLength(2);
  });

  test("an old live advertisement cannot verify a runner whose credential was lost", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    f.engine.files.delete("CATALYST_HOST_CREDENTIAL_FILE");
    f.state.enrollOnUp = false;
    expect((await run(f)).reason).toBe("runner_enrollment_unverified");
    expect(f.state.mints).toHaveLength(2);
    expect(readFileSync(join(f.dir, ".env"), "utf8")).toContain(`${JOIN_TOKEN}-2`);
  });

  test("a credential appearing after the first host list is verified against a fresh list", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.state.enrollOnUp = false;
    f.engine.enrollment = async () => {
      const enrollment = { hostId: "host-1", tenant: "account-a", team: "A", enrollmentKind: "self_hosted" as const };
      f.state.hosts = [{ ...enrollment, hostName: "catalyst-laptop", revokedAtMs: null, capability: f.state.capability }];
      return enrollment;
    };
    expect((await run(f)).state).toBe("done");
  });

  test("a repair reads the credential before reconciling its cloud enrollment", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    const previous = f.state.hosts[0]!;
    f.state.hosts = [];
    f.state.enrollOnUp = false;
    const read = f.engine.enrollment;
    f.engine.enrollment = async (dir, signal) => { f.state.hosts.push(previous); return read(dir, signal); };
    const next = `ghcr.io/coalesce-labs/catalyst-supervisor@sha256:${"d".repeat(64)}`;
    f.ctx.env.CATALYST_SUPERVISOR_IMAGE = next;
    f.engine.images.set(next, "arm64");
    expect((await run(f)).state).toBe("done");
  });

  test.each([false, true])("an unenrolled credential with spent token=%s preserves retry identity and its key", async (spent) => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.state.enrollOnUp = false;
    const up = f.engine.composeUp;
    let starts = 0;
    f.engine.composeUp = async (dir, signal) => {
      f.state.enrollOnUp = ++starts > 1;
      f.engine.files.set("CATALYST_HOST_CREDENTIAL_FILE", JSON.stringify({ version: 1, enrollment: null, spentJoinTokens: spent ? [createHash("sha256").update(JOIN_TOKEN).digest("hex")] : [] }));
      return up(dir, signal);
    };
    expect((await run(f)).reason).toBe("runner_enrollment_unverified");
    f.state.minimumEnrollmentMint = spent ? 2 : 1;
    expect(await run(f)).toMatchObject({ state: "done", evidence: { hostId: spent ? "host-2" : "host-1" } });
    expect(f.state.mints).toHaveLength(spent ? 2 : 1);
    expect(f.engine.files.get("CATALYST_ORG_KEY_FILE")).toBe(ORG_KEY);
  });

  test("fresh Linux waits for separately authorized genuine producer before writes",async()=>{
    const f=fixture({selected:true,engine:fakeEngine({arch:"amd64",vm:false})});
    f.engine.nativeEgressStatus=async()=>false;
    for(const ref of [SUPERVISOR,WATCHDOG,RUNNER])f.engine.images.set(ref,"amd64");
    expect(await run(f)).toMatchObject({state:"waiting",reason:"runner_native_egress_setup_required"});
    expect(f.state.mints).toEqual([]);expect(f.engine.calls).not.toContain("composeUp");expect(existsSync(f.dir)).toBe(false);
  });

  test("a native Linux engine gets its socket group and directories handed to the runner uid", async () => {
    const engine = fakeEngine({ arch: "amd64", vm: false });
    for (const ref of [SUPERVISOR, WATCHDOG, RUNNER]) engine.images.set(ref, "amd64");
    const f = fixture({ selected: true, engine });
    withOrgKey(f);
    await run(f);
    expect(readFileSync(join(f.dir, ".env"), "utf8")).toContain(
      "DOCKER_SOCKET_GID=991\n",
    );
    expect(engine.calls).toContain("claimDirs 3");
  });

  test("a saved yes alone only reports: an unattended run never restarts a stopped runner", async () => {
    const f = fixture();
    const enrollment = f.engine.enrollment;
    f.engine.enrollment = async (...args) => { f.engine.calls.push("credential-helper"); return enrollment(...args); };
    withOrgKey(f);
    f.journal.steps.push({
      id: "runner",
      state: "done",
      evidence: { selected: true },
    });
    expect(await run(f)).toMatchObject({
      state: "waiting",
      reason: "runner_needs_runner_flag",
    });
    expect(f.engine.calls).not.toContain("composeUp");
    expect(f.engine.calls).not.toContain("nativeThoughtsCustody");
    expect(f.engine.calls).not.toContain("credential-helper");
    expect(f.state.mints).toEqual([]);
    expect(existsSync(f.dir)).toBe(false);
  });

  test("a person's own .env settings survive a rerun, and do not count as drift", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    writeFileSync(
      join(f.dir, ".env"),
      `${readFileSync(join(f.dir, ".env"), "utf8")}CATALYST_SLOTS=4\n`,
    );
    f.engine.calls.length = 0;
    expect((await run(f)).state).toBe("done");
    expect(f.engine.calls).not.toContain("composeUp");
    // A key the step owns moves; the person's key stays.
    const newer = `ghcr.io/coalesce-labs/catalyst-supervisor@sha256:${"d".repeat(64)}`;
    f.engine.images.set(newer, "arm64");
    f.ctx.env.CATALYST_SUPERVISOR_IMAGE = newer;
    expect((await run(f)).state).toBe("done");
    expect(f.engine.calls).toContain("composeUp");
    const env = readFileSync(join(f.dir, ".env"), "utf8");
    expect(env).toContain(`CATALYST_SUPERVISOR_IMAGE=${newer}\n`);
    expect(env).toContain("CATALYST_SLOTS=4\n");
    expect(env).toContain(`CATALYST_HOST_JOIN_TOKEN=${JOIN_TOKEN}\n`);
    expect(f.state.mints).toHaveLength(1);
  });

  test("a stale compose is refreshed without losing the saved disk policy or enrollment", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    expect((await run(f)).state).toBe("done");
    const policy = [
      "CATALYST_SLOTS=1", "CATALYST_SLOT_DISK_MODE=budget", "CATALYST_SLOT_DISK_BUDGET_GIB=12",
      "CATALYST_DISK_BUDGET_GIB=32", "CATALYST_WORKSPACE_RETENTION_HOURS=1",
      "CATALYST_HOST_FREE_FLOOR_GIB=45", "CATALYST_HOST_DISK_SAMPLE_DIR=/host/samples",
      "CATALYST_HOST_DISK_SAMPLE_FILE=/var/lib/catalyst/host-disk/sample.json",
    ];
    const envPath = join(f.dir, ".env");
    writeFileSync(envPath, readFileSync(envPath, "utf8") + policy.join("\n") + "\n");
    const beforeEnv = readFileSync(envPath);
    const beforeCredential = f.engine.files.get("CATALYST_HOST_CREDENTIAL_FILE");
    writeFileSync(join(f.dir, "compose.yaml"), "services: {}\n");
    f.engine.calls.length = 0;
    expect((await run(f)).state).toBe("done");
    expect(f.engine.calls.filter(call => call === "composeUp")).toHaveLength(1);
    expect(readFileSync(envPath)).toEqual(beforeEnv);
    expect(f.engine.files.get("CATALYST_HOST_CREDENTIAL_FILE")).toBe(beforeCredential);
    expect(f.state.mints).toHaveLength(1);
    const rendered = readFileSync(join(f.dir, "compose.yaml"), "utf8");
    expect(rendered).toBe(readFileSync(join(__dirname, "..", "vendor/self-host/compose.yaml"), "utf8"));
    expect(rendered).toContain("${CATALYST_HOST_DISK_SAMPLE_DIR:-./host-disk}:/var/lib/catalyst/host-disk:ro");
    expect(rendered).toContain("CATALYST_HOST_FREE_FLOOR_GIB: ${CATALYST_HOST_FREE_FLOOR_GIB:-25}");
    expect(rendered).toContain("CATALYST_HOST_DISK_SAMPLE_FILE: ${CATALYST_HOST_DISK_SAMPLE_FILE:-}");
    expect(existsSync(join(f.dir, "host-disk"))).toBe(true);
  });

  test("a stale compose remains untouched when this run has not selected runner repair", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    expect((await run(f)).state).toBe("done");
    const stale = "services: {}\n";
    writeFileSync(join(f.dir, "compose.yaml"), stale);
    f.engine.calls.length = 0;
    const adapter = onboardRunnerAdapter({ selected: false, engine: f.engine });
    // Reporting without --runner never applies an update.
    await adapter.check(f.ctx, f.journal);
    expect(readFileSync(join(f.dir, "compose.yaml"), "utf8")).toBe(stale);
    expect(f.engine.calls).not.toContain("composeUp");
  });

  test("an explicit disk policy overrides saved values while retaining other saved settings", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    expect((await run(f)).state).toBe("done");
    const envPath = join(f.dir, ".env");
    writeFileSync(envPath, readFileSync(envPath, "utf8") + "CATALYST_HOST_FREE_FLOOR_GIB=25\nCATALYST_DISK_BUDGET_GIB=32\n");
    f.ctx.env.CATALYST_SLOTS = "1";
    f.ctx.env.CATALYST_HOST_FREE_FLOOR_GIB = "45";
    f.ctx.env.CATALYST_HOST_DISK_SAMPLE_DIR = "/host/fresh-samples";
    f.ctx.env.CATALYST_HOST_DISK_SAMPLE_FILE = "/var/lib/catalyst/host-disk/sample.json";
    expect((await run(f)).state).toBe("done");
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain("CATALYST_SLOTS=1\n");
    expect(env).toContain("CATALYST_HOST_FREE_FLOOR_GIB=45\n");
    expect(env).toContain("CATALYST_HOST_DISK_SAMPLE_DIR=/host/fresh-samples\n");
    expect(env).toContain("CATALYST_HOST_DISK_SAMPLE_FILE=/var/lib/catalyst/host-disk/sample.json\n");
    expect(env).toContain("CATALYST_DISK_BUDGET_GIB=32\n");
  });

  test("an explicitly supplied replacement organization key replaces the saved key", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    const replacement = "ctc_org_replacement_fixture_secret";
    writeFileSync(f.ctx.env.CATALYST_RUNNER_ORG_KEY_FILE!, replacement, { mode: 0o600 });
    expect((await run(f)).state).toBe("done");
    expect(f.engine.files.get("CATALYST_ORG_KEY_FILE")).toBe(replacement);
  });

  test("an unreadable organization key file is named as invalid, not as missing", async () => {
    const f = fixture({ selected: true });
    await run(f);
    const file = join(f.home, "org-key");
    writeFileSync(file, "two\nlines\n", { mode: 0o600 });
    f.ctx.env.CATALYST_RUNNER_ORG_KEY_FILE = file;
    expect((await run(f)).reason).toBe("runner_org_key_file_invalid");
  });

  test("the machine name defaults to the hostname; enrollment IDs distinguish machines",()=>{
    expect(runnerDefaultHostName()).toBe(hostname().split(".")[0]?.replace(/[^A-Za-z0-9._-]/g,"-").slice(0,63));
    expect(runnerDefaultHostName()).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/);
  });

  test("a misshaped session network is reported, never replaced", async () => {
    const engine = fakeEngine();
    engine.networkState = "misshaped";
    const f = fixture({ selected: true, engine });
    expect((await run(f)).reason).toBe("runner_session_network_misshaped");
    expect(engine.calls).not.toContain("createNetwork catalyst-session-v1");
    expect(f.state.mints).toEqual([]);
  });

  test("a Compose failure fails the step naming the project and the daemon's error", async () => {
    const engine = fakeEngine();
    engine.upError = "Error response from daemon: driver failed programming external connectivity";
    const f = fixture({ selected: true, engine });
    withOrgKey(f);
    expect(await run(f)).toMatchObject({
      state: "failed",
      reason: "runner_compose_failed",
      evidence: {
        project: "catalyst-host",
        composeError: "Error response from daemon: driver failed programming external connectivity",
      },
    });
  });

  test("without an organization key the host still enrolls, and the step names the key it needs", async () => {
    const f = fixture({ selected: true });
    const result = await run(f);
    expect(result).toMatchObject({
      state: "waiting",
      reason: "runner_org_key_missing",
      evidence: { selected: true, hostName: "catalyst-laptop" },
    });
    expect(f.engine.calls).toContain("composeUp");
  });

  test("a host that never enrolls waits with the reason", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.state.enrollOnUp = false;
    expect((await run(f)).reason).toBe("runner_enrollment_unverified");
  });

  test("a host advertising zero capacity names its failing checks", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.state.capability = {
      placeableCapacity: 0,
      runtimeLive: true,
      failingRequired: ["host.session-network"],
      receivedAtMs: now.getTime(),
    };
    expect(await run(f)).toMatchObject({
      state: "waiting",
      reason: "runner_host_not_ready",
      evidence: { failing: "host.session-network", capacity: 0 },
    });
  });

  test("a non-live host advertisement cannot claim usable capacity", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.state.capability!.runtimeLive = false;
    expect(await run(f)).toMatchObject({ state: "waiting", reason: "runner_host_not_ready", evidence: { capacity: 0 } });
  });

  test("a ready host whose team does not admit hosts names the operator ask", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.state.admission = false;
    expect(await run(f)).toMatchObject({
      state: "waiting",
      reason: "runner_admission_operator",
      evidence: { capacity: 2, hostId: "host-1" },
    });
  });

  test("reuses the verified existing installation after the workstation state root changes", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    const before = f.engine.calls.filter(c => c === "composeUp").length;
    f.engine.installation = async () => ({ dir: f.dir, hostName: "catalyst-laptop", baseUrl: "https://cloud.example.test" });
    const alternative = join(f.ctx.home, "different-state");
    f.ctx.env.CATALYST_STATE_DIR = alternative;
    expect(await f.adapter.check(f.ctx, f.journal)).toMatchObject({ state: "done", evidence: { hostId: "host-1" } });
    expect(existsSync(alternative)).toBe(false);
    expect(f.engine.calls.filter(c => c === "composeUp")).toHaveLength(before);
    expect(f.state.mints).toHaveLength(1);
  });

  test("the naming prompt chooses a new machine but preserves a verified installation name", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    let questions = 0;
    const adapter = onboardRunnerAdapter({
      selected: true,
      engine: f.engine,
      hostName: () => "default-machine",
      chooseName: async () => { questions++; return "studio-mac"; },
      sleep: async () => {},
    });
    expect((await adapter.check(f.ctx, f.journal)).state).toBe("pending");
    expect((await adapter.act!(f.ctx, f.journal)).state).toBe("done");
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({ state: "done", evidence: { hostName: "studio-mac" } });
    expect(questions).toBe(1);
    f.engine.installation = async () => ({ dir: f.dir, hostName: "studio-mac", baseUrl: "https://cloud.example.test" });
    const envFile = join(f.dir, ".env");
    writeFileSync(envFile, readFileSync(envFile, "utf8").replace(/^CATALYST_HOST_NAME=.*\n/m, ""));
    const resumed = onboardRunnerAdapter({
      selected: true,
      engine: f.engine,
      chooseName: async () => { questions++; return "replacement-name"; },
      sleep: async () => {},
    });
    expect((await resumed.check(f.ctx, f.journal)).state).toBe("pending");
    expect((await resumed.act!(f.ctx, f.journal)).state).toBe("done");
    expect(await resumed.check(f.ctx, f.journal)).toMatchObject({ state: "done", evidence: { hostName: "studio-mac" } });
    expect(questions).toBe(1);
    expect(readFileSync(envFile, "utf8")).toContain("CATALYST_HOST_NAME=studio-mac");
    expect(f.state.mints).toHaveLength(1);
  });
  test("moving on reuses only the verified existing machine's project without selecting another team", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    f.engine.installation = async () => ({ dir: f.dir, hostName: "catalyst-laptop", baseUrl: "https://cloud.example.test" });
    f.journal.steps = [{ id: "linear.team", state: "skipped", reason: "returning_workspace_move_on" }];
    expect(await f.adapter.check(f.ctx, f.journal)).toMatchObject({ state: "done", evidence: { hostId: "host-1" } });
    expect(f.journal.steps[0]!.state).toBe("skipped");
    expect(f.state.mints).toHaveLength(1);
    f.engine.installation = async () => "missing";
    expect(await f.adapter.check(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "runner_context_unverified" });
    expect(f.state.mints).toHaveLength(1);
  });

  test("an existing installation for another project keeps its config before an attempted repair", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    f.engine.installation = async () => ({ dir: f.dir, hostName: "catalyst-laptop", baseUrl: "https://cloud.example.test" });
    f.engine.enrollment = async () => ({ hostId: "host-other", tenant: "account-a", team: "B", enrollmentKind: "self_hosted" });
    const before = readFileSync(join(f.dir, ".env"), "utf8");
    expect((await f.adapter.act!(f.ctx, f.journal)).reason).toBe("runner_enrolled_for_other_team");
    expect(readFileSync(join(f.dir, ".env"), "utf8")).toBe(before);
    expect(f.state.mints).toHaveLength(1);
  });
  test("an unverifiable existing installation is preserved before preparing replacement files", async () => {
    const f = fixture({ selected: true });
    f.engine.installation = async () => "unverified";
    expect((await run(f)).reason).toBe("runner_installation_unverified");
    expect(existsSync(f.dir)).toBe(false);
    expect(f.state.mints).toHaveLength(0);
    expect(f.engine.calls).not.toContain("composeUp");
  });

  test("a healthy exact enrollment is recognized after its machine is renamed", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    f.state.hosts[0]!.hostName = "My renamed machine";
    expect(await f.adapter.check(f.ctx, f.journal)).toMatchObject({
      state: "done", evidence: { hostId: "host-1", hostName: "My renamed machine" },
    });
    expect(f.state.mints).toHaveLength(1);
  });
  test("a missing exact enrollment is unverified, never evidence of revocation", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    f.state.hosts = [];
    f.state.enrollOnUp = false;
    expect((await f.adapter.check(f.ctx, f.journal)).reason).toBe("runner_enrollment_unverified");
    expect(f.state.mints).toHaveLength(1);
  });

  test("a host whose old enrollment was revoked is not silently re-enrolled over its stale credential", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    f.state.hosts[0]!.revokedAtMs = now.getTime();
    expect((await run(f)).reason).toBe("runner_enrollment_revoked");
    expect(f.state.mints).toHaveLength(1);
  });
});

describe("the Docker engine", () => {
  function recordingExec(answers: Record<string, { code: number; stdout?: string; stderr?: string }> = {}) {
    const runs: Array<{
      args: string[];
      env: NodeJS.ProcessEnv;
      cwd?: string;
      input?: string;
    }> = [];
    return {
      runs,
      exec: async (
        args: string[],
        opts: { env: NodeJS.ProcessEnv; cwd?: string; input?: string },
      ) => {
        runs.push({ args, ...opts });
        const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
        return {
          code: key ? answers[key]!.code : 0,
          stdout: key ? (answers[key]!.stdout ?? "") : "",
          stderr: key ? (answers[key]!.stderr ?? "") : "",
        };
      },
    };
  }

  test("the production Engine exposes the closed native custody installer port", () => {
    expect(dockerRunnerEngine().nativeThoughtsCustody).toBeTypeOf("function");
  });

  test("discovers the exact owned Compose directory and public machine identity", async () => {
    const engine = fakeEngine({ arch: "amd64", vm: false });
    for (const ref of [SUPERVISOR, WATCHDOG, RUNNER]) engine.images.set(ref, "amd64");
    const f = fixture({ selected: true, engine });
    f.engine.files.set("CATALYST_ORG_KEY_FILE", ORG_KEY);
    await run(f);
    const config = {
      Image: SUPERVISOR,
      Env: ["CATALYST_HOST_NAME=catalyst-laptop", "CATALYST_MIRROR_URL=https://cloud.example.test"],
      Labels: {
        "com.docker.compose.project": "catalyst-host",
        "com.docker.compose.service": "supervisor",
        "com.docker.compose.project.working_dir": f.dir,
        "com.docker.compose.project.config_files": join(f.dir, "compose.yaml"),
      },
    };
    const inspect = (value: unknown, code = 0) => dockerRunnerEngine({ exec: recordingExec({
      "ps --all": { code: 0, stdout: "0123456789ab" },
      inspect: { code, stdout: JSON.stringify(value) },
    }).exec }).installation!(f.ctx.home, SUPERVISOR);
    expect(await inspect([{ Config: config }])).toEqual({ dir: f.dir, hostName: "catalyst-laptop", baseUrl: "https://cloud.example.test", supervisorImage: SUPERVISOR });
    expect(await inspect([{ Config: { ...config, Image: "unrelated:latest" } }])).toBe("unverified");
    expect(await inspect([{ Config: config }], 1)).toBe("unverified");
    expect(await dockerRunnerEngine({ exec: recordingExec({ "ps --all": { code: 0, stdout: "" } }).exec }).installation!(f.ctx.home, SUPERVISOR)).toBe("missing");
    expect(await dockerRunnerEngine({ exec: recordingExec({ "ps --all": { code: 1, stdout: "" } }).exec }).installation!(f.ctx.home, SUPERVISOR)).toBe("unverified");
  });

  test("Compose runs in the runner directory with the caller's CATALYST_ variables removed", async () => {
    const r = recordingExec();
    const engine = dockerRunnerEngine({
      exec: r.exec,
      env: { PATH: "/bin", CATALYST_RUNNER_IMAGE: "other", DOCKER_HOST: "unix:///x.sock" },
    });
    expect(await engine.composeUp("/r")).toEqual({ ok: true });
    expect(r.runs[0]!.args).toEqual([
      "compose",
      "--project-name",
      "catalyst-host",
      "--file",
      "/r/compose.yaml",
      "--env-file",
      "/r/.env",
      "up",
      "--detach",
    ]);
    expect(r.runs[0]!.cwd).toBe("/r");
    expect(r.runs[0]!.env).toEqual({ PATH: "/bin", DOCKER_HOST: "unix:///x.sock" });
  });

  test("persisted native custody selects exactly the base and Darwin Compose files", async () => {
    const f = fixture();
    mkdirSync(f.dir, { recursive: true, mode: 0o700 });
    const custody = nativeCustodyFixture(f.dir);
    writeFileSync(join(f.dir, ".env"), `CATALYST_THOUGHTS_CUSTODY_AUTHORITY='${custody.envAuthority}'\nCATALYST_THOUGHTS_CUSTODY_REQUESTS_DIR=${custody.requestsRoot}\nCATALYST_THOUGHTS_CUSTODY_RESPONSES_DIR=${custody.responsesRoot}\n`, { mode: 0o600 });
    writeFileSync(join(f.dir, "compose.darwin-thoughts.yaml"), "services: {}\n", { mode: 0o600 });
    const r = recordingExec();
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    expect(await engine.composeUp(f.dir)).toEqual({ ok: true });
    expect(r.runs[0]!.args).toEqual(["compose", "--project-name", "catalyst-host", "--file", join(f.dir, "compose.yaml"), "--file", join(f.dir, "compose.darwin-thoughts.yaml"), "--env-file", join(f.dir, ".env"), "up", "--detach"]);
  });

  test("partial persisted native custody refuses Compose rather than silently dropping the Darwin override", async () => {
    const f = fixture();
    mkdirSync(f.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(f.dir, ".env"), "CATALYST_THOUGHTS_CUSTODY_AUTHORITY='{}'\n", { mode: 0o600 });
    const r = recordingExec();
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    expect(await engine.composeUp(f.dir)).toEqual({ ok: false });
    expect(r.runs).toEqual([]);
  });

  test("the existing project's containers are read with their states before Compose starts", async () => {
    const r = recordingExec({ "ps --all": { code: 0, stdout: "watchdog\tpaused\nsupervisor\texited\n" } });
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    expect(await engine.projectContainers!()).toEqual([
      { service: "watchdog", state: "paused" },
      { service: "supervisor", state: "exited" },
    ]);
    expect(r.runs[0]!.args).toEqual([
      "ps", "--all",
      "--filter", "label=com.docker.compose.project=catalyst-host",
      "--format", '{{.Label "com.docker.compose.service"}}\t{{.State}}',
    ]);
  });

  test("an unreadable container listing reads as null, never as a wrong verdict", async () => {
    const r = recordingExec({ "ps --all": { code: 1, stdout: "" } });
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    expect(await engine.projectContainers!()).toBeNull();
  });

  test("compose unpause adopts the paused project in place, removing nothing", async () => {
    const r = recordingExec();
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    expect(await engine.composeUnpause!("/r")).toBe(true);
    expect(r.runs[0]!.args).toEqual([
      "compose", "--project-name", "catalyst-host", "--file", "/r/compose.yaml",
      "--env-file", "/r/.env", "unpause",
    ]);
    expect(r.runs[0]!.cwd).toBe("/r");
  });

  test("a Compose failure carries the daemon's own error text, without log noise", async () => {
    const r = recordingExec({ compose: { code: 1, stderr: "time=2026-10-02T12:00:00Z level=warning msg=unrelated noise\nError response from daemon: Cannot start container catalyst-host-supervisor-1: container is paused\n" } });
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    const up = await engine.composeUp("/r");
    expect(up.ok).toBe(false);
    expect(up.error).toBe("Error response from daemon: Cannot start container catalyst-host-supervisor-1: container is paused");
  });

  test("Compose output that is only control characters yields no error text", async () => {
    const r = recordingExec({ compose: { code: 1, stderr: "\x00\x07\x1b" } });
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    const up = await engine.composeUp("/r");
    expect(up.ok).toBe(false);
    expect(up.error).toBeUndefined();
  });

  test("installation receives an exact two-file Darwin identity only with private custody files", async () => {
    const f = fixture();
    mkdirSync(f.dir, { recursive: true, mode: 0o700 });
    const custody = nativeCustodyFixture(f.dir);
    writeFileSync(join(f.dir, "compose.yaml"), "services: {}\n", { mode: 0o644 });
    const override = join(f.dir, "compose.darwin-thoughts.yaml");
    writeFileSync(override, "services: {}\n", { mode: 0o600 });
    writeFileSync(join(f.dir, ".env"), `CATALYST_THOUGHTS_CUSTODY_AUTHORITY='${custody.envAuthority}'\nCATALYST_THOUGHTS_CUSTODY_REQUESTS_DIR=${custody.requestsRoot}\nCATALYST_THOUGHTS_CUSTODY_RESPONSES_DIR=${custody.responsesRoot}\n`, { mode: 0o600 });
    for (const root of [custody.requestsRoot, custody.responsesRoot]) mkdirSync(root, { mode: 0o700 });
    const config = { Image: SUPERVISOR, Env: ["CATALYST_HOST_NAME=catalyst-laptop", "CATALYST_MIRROR_URL=https://cloud.example.test"], Labels: {
      "com.docker.compose.project": "catalyst-host", "com.docker.compose.service": "supervisor",
      "com.docker.compose.project.working_dir": f.dir,
      "com.docker.compose.project.config_files": join(f.dir, "compose.yaml") + "," + override,
    } };
    const inspect = () => dockerRunnerEngine({ exec: recordingExec({ "ps --all": { code: 0, stdout: "0123456789ab" }, inspect: { code: 0, stdout: JSON.stringify([{ Config: config }]) } }).exec }).installation!(f.ctx.home, SUPERVISOR);
    expect(await inspect()).toEqual({ dir: f.dir, hostName: "catalyst-laptop", baseUrl: "https://cloud.example.test", supervisorImage: SUPERVISOR });
    writeFileSync(override, "services: {}\n");
    // chmod, rather than creation mode, makes the broad permissions meaningful on an existing file.
    const { chmodSync } = await import("node:fs");
    chmodSync(override, 0o666);
    expect(await inspect()).toBe("unverified");
    chmodSync(override, 0o600);
    config.Labels["com.docker.compose.project.config_files"] += ",/foreign/override.yaml";
    expect(await inspect()).toBe("unverified");
  });

  test("handing folders to the runner uid gives root back only CHOWN", async () => {
    const r = recordingExec();
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    await engine.claimDirs("/r", ["/r/slots"]);
    const args = r.runs[0]!.args;
    expect(args.slice(args.indexOf("run"))).toEqual([
      "run",
      "--rm",
      "-T",
      "--no-deps",
      "--user",
      "0",
      "--cap-add",
      "CHOWN",
      "--entrypoint",
      "chown",
      "supervisor",
      "10001:10001",
      "/r/slots",
    ]);
  });

  test.each(["unenrolled", "spent", "missing token", "enrolled", "malformed"])("the actual credential program handles %s without exposing its secret", async (kind) => {
    const home = mkdtempSync(join(tmpdir(), "runner-credential-program-")); homes.push(home);
    const path = join(home, "credential");
    const enrollment = { hostId: "host-fixture", tenant: "account-a", team: "A", enrollmentKind: "self_hosted" };
    const privateSecret = "fixture_secret_"+"x".repeat(32);
    writeFileSync(path, kind === "malformed" ? "{" : JSON.stringify({ version: 1, secret: privateSecret, enrollment: ["unenrolled", "spent", "missing token"].includes(kind) ? null : enrollment, spentJoinTokens: kind === "spent" ? [createHash("sha256").update(JOIN_TOKEN).digest("hex")] : [] }), { mode: 0o600 });
    const outputs: string[] = [];
    const engine = dockerRunnerEngine({ env: {}, exec: async args => {
      const index = args.indexOf("-e");
      return await new Promise((resolve, reject) => {
        const child = spawn(process.env.RUNNER_JS_TEST_RUNTIME ?? process.execPath, ["-e", args[index+1]!], { env: { CATALYST_HOST_CREDENTIAL_FILE: path, ...(kind === "missing token" ? {} : { CATALYST_HOST_JOIN_TOKEN: JOIN_TOKEN }) }, stdio: ["ignore", "pipe", "ignore"] });
        let stdout = ""; child.stdout.on("data", chunk => { stdout+=String(chunk); });
        child.on("error", reject); child.on("close", code => { outputs.push(stdout); resolve({ code: code ?? 1, stdout }); });
      });
    } });
    expect(await engine.enrollment(home)).toEqual(["unenrolled", "spent", "missing token"].includes(kind) ? { unenrolled: true, tokenSpent: kind !== "unenrolled" } : kind === "enrolled" ? enrollment : null);
    expect(outputs.join("")).not.toContain(privateSecret);
  });

  test("a secret reaches the volume on stdin, never in arguments", async () => {
    const r = recordingExec();
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    await engine.writeVolumeFile("/r", "CATALYST_ORG_KEY_FILE", ORG_KEY);
    expect(r.runs[0]!.input).toBe(`${ORG_KEY}\n`);
    expect(r.runs[0]!.args.join(" ")).not.toContain(ORG_KEY);
    expect(r.runs[0]!.args.join(" ")).toContain('mv -f "$tmp" "$CATALYST_ORG_KEY_FILE"');
  });

  test.each([
    ["Ubuntu 24.04 (Colima)", "unix:///Users/person/.colima/default/docker.sock"],
    ["Rancher Desktop", "unix:///Users/person/.rd/docker.sock"],
    ["OrbStack", "unix:///Users/person/.orbstack/run/docker.sock"],
    ["Docker Desktop", "unix:///Users/person/.docker/run/docker.sock"],
    ["another Linux engine", "unix:///var/run/docker.sock"],
  ])("macOS accepts %s by local Linux engine capabilities", async (operatingSystem, endpoint) => {
    const r = recordingExec({
      "info": {
        code: 0,
        stdout: JSON.stringify({ Architecture: "aarch64", OperatingSystem: operatingSystem, OSType: "linux" }),
      },
      "compose version": { code: 0, stdout: "v2.40.0" },
    });
    const engine = dockerRunnerEngine({ exec: r.exec, env: { DOCKER_HOST: endpoint }, platform: "darwin" });
    expect(await engine.info()).toEqual({ arch: "arm64", vm: true });
    expect(await engine.socketGid()).toBeNull();
    expect(r.runs.some(row => row.args.join(" ") === "compose version")).toBe(true);
  });

  test.each([
    { platform: "darwin" as const, operatingSystem: "Ubuntu (Colima)", endpoint: "tcp://remote:2376" },
    { platform: "linux" as const, operatingSystem: "Ubuntu", endpoint: "tcp://remote:2376" },
    { platform: "darwin" as const, operatingSystem: "Docker Desktop", endpoint: "ssh://remote" },
    { platform: "linux" as const, operatingSystem: "Ubuntu", endpoint: "unix:///run/user/1000/docker.sock" },
  ])("an unsupported $endpoint engine never uses the client's local socket gid", async ({ platform, operatingSystem, endpoint }) => {
    const r = recordingExec({
      info: { code: 0, stdout: JSON.stringify({ Architecture: "amd64", OperatingSystem: operatingSystem, OSType: "linux" }) },
      "context inspect": { code: 0, stdout: endpoint },
    });
    const engine = dockerRunnerEngine({ exec: r.exec, env: {}, platform, socketPath: tmpdir() });
    expect(await engine.info()).toMatchObject({ unsupported: true });
    expect(await engine.socketGid()).toBeNull();
  });

  test("conflicting Docker endpoint variables refuse setup and pulls without local gid", async () => {
    const r = recordingExec({
      info: { code: 0, stdout: JSON.stringify({ Architecture: "amd64", OperatingSystem: "Ubuntu", OSType: "linux" }) },
      "context inspect": { code: 0, stdout: "unix:///var/run/docker.sock" },
    });
    const engine = dockerRunnerEngine({ exec: r.exec, env: { DOCKER_CONTEXT: "local", DOCKER_HOST: "tcp://remote:2376" }, platform: "linux", socketPath: tmpdir() });
    expect(await engine.info()).toMatchObject({ unsupported: true });
    expect(await engine.socketGid()).toBeNull();
    expect(await engine.pull(SUPERVISOR)).toBe(false);
    expect(r.runs.some(run => run.args.includes("pull"))).toBe(false);
  });

  test("no Docker CLI, no engine or no Compose plugin is no engine", async () => {
    const cases: Array<Record<string, { code: number; stdout?: string }>> = [
      { info: { code: 1 } },
      {
        info: { code: 0, stdout: JSON.stringify({ Architecture: "x86_64", OperatingSystem: "Ubuntu", OSType: "linux" }) },
        "compose version": { code: 1 },
      },
      { info: { code: 0, stdout: JSON.stringify({ Architecture: "x86_64", OSType: "windows" }) } },
    ];
    for (const answers of cases) {
      const engine = dockerRunnerEngine({ exec: recordingExec(answers).exec, env: {} });
      expect(await engine.info()).toBeNull();
    }
    const missing = dockerRunnerEngine({
      exec: async () => {
        throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
      },
      env: {},
    });
    expect(await missing.info()).toBeNull();
  });

  test.each([
    [1,"","Error response from daemon: network catalyst-session-v1 not found","missing"],
    [1,"[]","Error response from daemon: network catalyst-session-v1 not found","missing"],
    [0,"[]","Error response from daemon: network catalyst-session-v1 not found","unavailable"],
    [1,"","permission denied","unavailable"],
    [1,"[]","Cannot connect to Docker daemon","unavailable"],
    [1,"","Error response from daemon: network some-other-name not found","unavailable"],
    [1,"{}","Error response from daemon: network catalyst-session-v1 not found","unavailable"],
    [1,"","transport timeout for catalyst-session-v1","unavailable"],
    [1,"","permission denied: network catalyst-session-v1 not found","unavailable"],
    [0,"[]","","misshaped"],
    [0,"{bad","","misshaped"],
  ])("network inspect code=%s stdout=%s stderr=%s is %s",async(code,stdout,stderr,expected)=>{
    const calls:string[][]=[];
    const engine=dockerRunnerEngine({env:{},exec:async(args)=>{calls.push(args);return{code:code as number,stdout:stdout as string,stderr:stderr as string};}});
    expect(await engine.network("catalyst-session-v1")).toBe(expected);expect(calls).toEqual([["network","inspect","catalyst-session-v1"]]);
  });

  test("the session network is created with the isolated shape the supervisor checks", async () => {
    const r = recordingExec();
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    await engine.createNetwork("catalyst-session-v1");
    expect(r.runs[0]!.args).toEqual([
      "network",
      "create",
      "--driver=bridge",
      "--opt",
      "com.docker.network.bridge.enable_icc=false",
      "--opt",
      "com.docker.network.bridge.name=catalyst-sess0",
      "--label",
      "dev.catalystcloud.session-network=v1",
      "catalyst-session-v1",
    ]);
  });

  test("an existing network is ready only with icc off, the bridge name and the label", async () => {
    const shape = (icc: string, name: string, label: string | undefined) =>
      JSON.stringify([
        {
          Driver: "bridge",
          Internal: false,
          EnableIPv6: false,
          Options: {
            "com.docker.network.bridge.enable_icc": icc,
            "com.docker.network.bridge.name": name,
          },
          Labels: label ? { "dev.catalystcloud.session-network": label } : {},
        },
      ]);
    const at = (stdout: string, code = 0) =>
      dockerRunnerEngine({
        exec: recordingExec({ "network inspect": { code, stdout } }).exec,
        env: {},
      }).network("catalyst-session-v1");
    expect(await at(shape("false", "catalyst-sess0", "v1"))).toBe("ready");
    expect(await at(shape("true", "catalyst-sess0", "v1"))).toBe("misshaped");
    expect(await at(shape("false", "docker0", "v1"))).toBe("misshaped");
    expect(await at(shape("false", "catalyst-sess0", undefined))).toBe("misshaped");
    expect(await at("", 1)).toBe("unavailable");
  });

  test("host image pulls use an empty disposable config and preserve the engine endpoint", async () => {
    const r = recordingExec({ "context inspect": { code: 0, stdout: "unix:///local/docker.sock" } });
    let pullConfig = "";
    const engine = dockerRunnerEngine({
      exec: async (args, opts) => {
        if (args.includes("pull")) {
          pullConfig = args[args.indexOf("--config") + 1]!;
          expect(JSON.parse(readFileSync(join(pullConfig, "config.json"), "utf8"))).toEqual({ auths: {} });
          expect(opts.env.DOCKER_CONFIG).toBe(pullConfig);
          expect(opts.env.DOCKER_CONTEXT).toBeUndefined();
          expect(opts.env.DOCKER_AUTH_CONFIG).toBeUndefined();
        }
        return r.exec(args, opts);
      },
      env: { DOCKER_CONFIG: "/home/x/.docker", DOCKER_CONTEXT: "local", DOCKER_AUTH_CONFIG: '{"auths":{"private.example":{}}}' },
    });
    expect(await engine.pull(SUPERVISOR)).toBe(true);
    expect(r.runs.at(-1)!.args).toEqual(["--host", "unix:///local/docker.sock", "--config", pullConfig, "pull", "--quiet", SUPERVISOR]);
    expect(existsSync(pullConfig)).toBe(false);
  });

  test.each([
    { DOCKER_HOST: "tcp://remote.example:2376" },
    { DOCKER_HOST: "unix:///local/docker.sock", DOCKER_CONTEXT: "other" },
  ])("image preparation refuses remote or conflicting engine selectors", async (env) => {
    const r = recordingExec();
    expect(await dockerRunnerEngine({ exec: r.exec, env }).pull(SUPERVISOR)).toBe(false);
    expect(r.runs.some(run => run.args.includes("pull"))).toBe(false);
  });

  test("failed anonymous image preparation removes its private configuration", async () => {
    let pullConfig = "";
    const engine = dockerRunnerEngine({
      env: { DOCKER_HOST: "unix:///local/docker.sock" },
      exec: async (args, opts) => {
        expect(args).toContain("pull");
        pullConfig = args[args.indexOf("--config") + 1]!;
        expect(JSON.parse(readFileSync(join(pullConfig, "config.json"), "utf8"))).toEqual({ auths: {} });
        expect(opts.timeoutMs).toBe(900_000);
        return { code: 1, stdout: "" };
      },
    });
    expect(await engine.pull(SUPERVISOR)).toBe(false);
    expect(pullConfig).not.toBe("");
    expect(existsSync(pullConfig)).toBe(false);
  });
});

test("the vendored Compose file matches its recorded provenance", () => {
  const root = join(__dirname, "..", "vendor", "self-host");
  const manifest = JSON.parse(readFileSync(join(root, "provenance.json"), "utf8"));
  expect(
    createHash("sha256").update(readFileSync(join(root, "compose.yaml"))).digest("hex"),
  ).toBe(manifest.sha256["deploy/self-host/compose.yaml"]);
});


describe("runner account key enrollment policy", () => {
  async function keyFixture() {
    const home = mkdtempSync(join(tmpdir(), "runner-key-policy-"));
    homes.push(home);
    const file = join(home, "key");
    writeFileSync(file, ORG_KEY, { mode: 0o600 });
    const policy = { status: 200, body: { account: "account-a", principal: "service", permissions: ["mirror:read", "mirror:write", "mirror:feed"] } as Record<string, unknown> };
    const server = createServer((req, res) => {
      expect(req.url).toBe("/api/v1/me");
      expect(req.headers.authorization).toBe(`Bearer ${ORG_KEY}`);
      res.writeHead(policy.status, { "content-type": "application/json" });
      res.end(JSON.stringify(policy.body));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("test_listener_missing");
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    let storedPath = file;
    const output: string[] = [];
    const engine = dockerRunnerEngine({ env: {}, exec: async (args, options) => {
      const scriptIndex = args.indexOf("-e");
      return await new Promise((resolve, reject) => {
        // Execute the actual in-container program against a loopback provider, without Docker.
        const child = spawn(process.env.RUNNER_JS_TEST_RUNTIME ?? process.execPath, ["-e", args[scriptIndex + 1]!, ...args.slice(scriptIndex + 2)], {
          env: { CATALYST_ORG_KEY_FILE: storedPath }, stdio: ["pipe", "pipe", "ignore"],
        });
        let stdout = "";
        child.stdout.on("data", chunk => { stdout += String(chunk); });
        child.on("error", reject);
        child.on("close", code => { output.push(stdout); resolve({ code: code ?? 1, stdout }); });
        child.stdin.end(options.input ?? "");
      });
    } });
    return { policy, engine, file, home, baseUrl, output, stored: (path: string) => { storedPath = path; }, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
  }

  test.each([
    ["same tenant scoped key", {}, "valid"],
    ["other tenant", { account: "account-b" }, "invalid"],
    ["personal key", { user: { id: "person-a" } }, "invalid"],
    ["missing feed scope", { permissions: ["mirror:read", "mirror:write"] }, "invalid"],
    ["broad key", { permissions: ["mirror:read", "mirror:write", "mirror:feed", "admin:write"] }, "invalid"],
  ])("validates %s against the actual enrollment policy", async (_name, body, expected) => {
    const f = await keyFixture();
    try {
      Object.assign(f.policy.body, body);
      expect(await f.engine.orgKeyStatus(f.home, "account-a", f.baseUrl)).toBe(expected);
      expect(f.output.join("")).not.toContain(ORG_KEY);
    } finally { await f.close(); }
  });

  test("rate limiting does not tell the person to replace a valid key", async () => {
    const f = await keyFixture();
    try { f.policy.status = 429; expect(await f.engine.orgKeyStatus(f.home, "account-a", f.baseUrl)).toBe("unavailable"); }
    finally { await f.close(); }
  });

  test("a stored key symlink cannot verify readiness", async () => {
    const f = await keyFixture();
    try {
      const link = join(f.home, "link"); symlinkSync(f.file, link); f.stored(link);
      expect(await f.engine.orgKeyStatus(f.home, "account-a", f.baseUrl)).toBe("invalid");
    } finally { await f.close(); }
  });

  test("a valid supplied replacement is distinct and travels only on stdin", async () => {
    const f = await keyFixture();
    try {
      writeFileSync(f.file, "ctc_org_old_fixture_secret");
      expect(await f.engine.orgKeyStatus(f.home, "account-a", f.baseUrl, ORG_KEY)).toBe("different");
      expect(f.output.join("")).toBe("different");
    } finally { await f.close(); }
  });
});


describe("approved cloud runner integration",()=>{
 function cloudFixture(selected=true){
  const f=fixture({selected,runnerCloud:true,engine:fakeEngine({arch:"arm64",vm:true}),env:{CATALYST_SUPERVISOR_IMAGE:SUPERVISOR,CATALYST_WATCHDOG_IMAGE:WATCHDOG,CATALYST_RUNNER_IMAGE:RUNNER}});
  for(const ref of [SUPERVISOR,WATCHDOG,RUNNER]) f.engine.images.set(ref,"arm64");
  f.state.admission=false;
  return f;
 }
 test("explicit selection uses native pinned image, scoped key and selected team admission",async()=>{
  const f=cloudFixture();expect(await run(f)).toMatchObject({state:"done",evidence:{capacity:2,hostId:"host-1"}});
  expect(f.state.admissionWrites).toEqual([{admissionEnabled:true}]);expect(f.state.keyMints).toHaveLength(1);
  expect(f.engine.files.get("CATALYST_ORG_KEY_FILE")).toBe(ORG_KEY);
  expect(readFileSync(join(f.dir,".env"),"utf8")).toContain("CATALYST_RUNNER_IMAGE="+RUNNER);
  expect(f.output.join("\n")+JSON.stringify(f.journal)).not.toMatch(/ctcpull_|ctc_org_fixture/);
 });
 test("default no cannot discover, mint, enroll or admit",async()=>{
  const f=cloudFixture(false);expect(await run(f)).toMatchObject({state:"skipped"});
  expect(f.requests).toEqual([]);expect(f.state.keyMints).toEqual([]);expect(f.state.admissionWrites).toEqual([]);
 });
 test("saved yes checks cannot provision or change admission",async()=>{
  const f=cloudFixture();expect((await run(f)).state).toBe("done");
  f.state.admission=false;const writes=f.state.admissionWrites.length;
  f.journal.steps.push({id:"runner",state:"done",evidence:{selected:true}});
  const adapter=onboardRunnerAdapter({engine:f.engine,sleep:async()=>{},waitMs:20,pollMs:10});
  expect((await adapter.check(f.ctx,f.journal)).state).toBe("waiting");expect(f.state.admissionWrites).toHaveLength(writes);
 });
});


describe("runner admission without a repository capacity mapping", () => {
  function withOrgKey(f: ReturnType<typeof fixture>) {
    const file = join(f.home, "org-key");
    writeFileSync(file, `${ORG_KEY}\n`, { mode: 0o600 });
    f.ctx.env.CATALYST_RUNNER_ORG_KEY_FILE = file;
  }

  test("supported personal admission completes an unmapped team's runner check", async () => {
    const f = fixture({ selected: true, runnerCloud: true, capacityMapped: false });
    withOrgKey(f);
    expect(await run(f)).toMatchObject({ state: "done", evidence: { hostId: "host-1", capacity: 2 } });
    expect(f.requests).toContain("GET /api/v1/agent/runner-admission?account=account-a&team=team-a");
    expect(f.requests.some((r) => r.includes("/api/v1/me/runner-capacity"))).toBe(false);
    expect(f.engine.calls.filter((r) => r === "composeUp")).toHaveLength(1);
    secretsNowhere(f);
  });

  test("supported personal admission initializes and reads back before starting an unmapped runner", async () => {
    const f = fixture({ selected: true, runnerCloud: true, capacityMapped: false });
    withOrgKey(f);
    f.state.admission = false;
    const composeUp = f.engine.composeUp;
    f.engine.composeUp = async (dir, signal) => {
      expect(f.state.admissionWrites).toEqual([{ admissionEnabled: true }]);
      expect(f.requests.at(-1)).toBe("GET /api/v1/agent/runner-admission?account=account-a&team=team-a");
      return composeUp(dir, signal);
    };
    expect(await run(f)).toMatchObject({ state: "done" });
    expect(f.requests.some((r) => r.includes("/api/v1/me/runner-capacity"))).toBe(false);
    secretsNowhere(f);
  });

  test("legacy clouds still require a mapped admission bucket", async () => {
    const f = fixture({ selected: true, capacityMapped: false });
    withOrgKey(f);
    expect(await run(f)).toMatchObject({ state: "waiting", reason: "runner_admission_unverified" });
    expect(f.requests).toContain("GET /api/v1/me/runner-capacity");
    expect(f.state.admissionWrites).toEqual([]);
  });

  test("legacy mapped admission false still waits for the operator", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.state.admission = false;
    expect(await run(f)).toMatchObject({ state: "waiting", reason: "runner_admission_operator" });
    expect(f.requests).toContain("GET /api/v1/me/runner-capacity");
  });

  test("supported policy refusal prevents Compose start even without a capacity mapping", async () => {
    const f = fixture({ selected: true, runnerCloud: true, capacityMapped: false });
    withOrgKey(f);
    f.state.admission = false;
    const fetch = f.ctx.fetch;
    f.ctx.fetch = async (input, init) => {
      if (String(input).includes("/runner-admission?") && init?.method === "PUT")
        return Response.json({ error: "runner_placement_unsupported" }, { status: 409 });
      return fetch(input, init);
    };
    expect(await run(f)).toMatchObject({ state: "waiting", reason: "runner_admission_operator" });
    expect(f.engine.calls).not.toContain("composeUp");
  });

  test("a supported enable response without successful readback prevents Compose start", async () => {
    const f = fixture({ selected: true, runnerCloud: true, capacityMapped: false });
    withOrgKey(f);
    f.state.admission = false;
    const fetch = f.ctx.fetch;
    f.ctx.fetch = async (input, init) => {
      if (String(input).includes("/runner-admission?") && init?.method === "GET")
        return Response.json({ account: "account-a", team: "team-a", admissionEnabled: false, revision: 1 });
      return fetch(input, init);
    };
    expect(await run(f)).toMatchObject({ state: "waiting", reason: "runner_admission_unverified" });
    expect(f.engine.calls).not.toContain("composeUp");
  });

  test("a missing org key still blocks the supported unmapped runner check", async () => {
    const f = fixture({ selected: true, runnerCloud: true, capacityMapped: false });
    withOrgKey(f);
    f.ctx.env.CATALYST_RUNNER_ORG_KEY_FILE = undefined;
    // Seed a healthy enrollment, then remove its key and only check, without act consent.
    await run(f);
    f.engine.files.delete("CATALYST_ORG_KEY_FILE");
    const adapter = onboardRunnerAdapter({ selected: false, engine: f.engine });
    // Use saved selection to allow read-only checking without permission to provision.
    f.journal.steps.push({ id: "runner", state: "done", evidence: { selected: true } });
    const readOnly = onboardRunnerAdapter({ engine: f.engine });
    expect(await readOnly.check(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "runner_org_key_missing" });
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({ state: "skipped" });
  });

  test("non-live host capacity still blocks supported admission without a repo mapping", async () => {
    const f = fixture({ selected: true, runnerCloud: true, capacityMapped: false });
    withOrgKey(f);
    f.state.capability!.runtimeLive = false;
    expect(await run(f)).toMatchObject({ state: "waiting", reason: "runner_host_not_ready", evidence: { capacity: 0 } });
  });
});

describe("owner-managed preserving replacement through the existing CLI path", () => {
  function retained() {
    const f = fixture({ selected: true });
    delete f.ctx.env.CATALYST_STATE_DIR;
    delete f.ctx.env.XDG_STATE_HOME;
    f.dir = join(f.home, ".local", "state", "catalyst", "runner");
    mkdirSync(f.dir, { recursive: true, mode: 0o700 });
    for (const leaf of ["slots", "thoughts", "locks"])
      mkdirSync(join(f.dir, leaf), { mode: leaf === "slots" ? 0o700 : 0o750 });
    const old = `ghcr.io/coalesce-labs/catalyst-supervisor@sha256:${"d".repeat(64)}`;
    const original = `CATALYST_SUPERVISOR_IMAGE=${old}\nCATALYST_RUNNER_IMAGE=${RUNNER}\nCATALYST_HOST_NAME=catalyst-laptop\nCATALYST_MIRROR_URL=https://cloud.example.test\nCATALYST_HOST_JOIN_TOKEN=${JOIN_TOKEN}\nCATALYST_SLOTS=8\n`;
    writeFileSync(join(f.dir, ".env"), original, { mode: 0o600 });
    writeFileSync(
      join(f.dir, "compose.yaml"),
      "name: catalyst-host\nservices: {}\n",
      { mode: 0o644 },
    );
    const credential = JSON.stringify({
      version: 1,
      enrollment: {
        hostId: "retained-host",
        tenant: "account-a",
        team: "A",
        enrollmentKind: "self_hosted",
      },
    });
    f.engine.files.set("CATALYST_HOST_CREDENTIAL_FILE", credential);
    f.engine.files.set("CATALYST_ORG_KEY_FILE", ORG_KEY);
    f.state.enrollOnUp = false;
    f.state.hosts.push({
      hostId: "retained-host",
      hostName: "catalyst-laptop",
      team: "A",
      enrollmentKind: "self_hosted",
      revokedAtMs: null,
      capability: f.state.capability,
    });
    let present = true;
    const cachedRuntime = { Id: `sha256:${"d".repeat(64)}`, RepoDigests: [old] };
    let runtimeCacheAvailable = true;
    const row = {
      Image: cachedRuntime.Id,
      Config: {
        Image: old,
        Env: [
          "CATALYST_HOST_NAME=catalyst-laptop",
          "CATALYST_MIRROR_URL=https://cloud.example.test",
        ],
        Labels: {
          "com.docker.compose.project": "catalyst-host",
          "com.docker.compose.service": "supervisor",
          "com.docker.compose.project.working_dir": f.dir,
          "com.docker.compose.project.config_files": join(
            f.dir,
            "compose.yaml",
          ),
        },
      },
    };
    const actual = dockerRunnerEngine({
      exec: async (args) => {
        if (args[0] === "ps")
          return { code: 0, stdout: present ? "e".repeat(64) : "" };
        if (args[0] === "inspect")
          return { code: 0, stdout: JSON.stringify([row]) };
        if (args[0] === "image" && args[1] === "inspect" && args[2] === old && runtimeCacheAvailable)
          return { code: 0, stdout: JSON.stringify([cachedRuntime]) };
        return { code: 1, stdout: "" };
      },
    });
    f.engine.installation = actual.installation;
    const composeUp = f.engine.composeUp;
    f.engine.composeUp = async (...args) => {
      const started = await composeUp(...args);
      if (started.ok) {
        row.Config.Image = SUPERVISOR;
        row.Image = `sha256:${"a".repeat(64)}`;
      }
      return started;
    };
    let received = false;
    f.engine.nativeThoughtsCustody = async ({
      dir,
      supervisorImage,
      runnerImage,
    }) => {
      expect(dir).toBe(f.dir);
      expect(supervisorImage).toBe(SUPERVISOR);
      expect(runnerImage).toBe(RUNNER);
      for (const image of [SUPERVISOR, WATCHDOG, RUNNER])
        expect(f.engine.calls).toContain(`imageArch ${image}`);
      expect(f.engine.calls).not.toContain("composeUp");
      received = true;
      return nativeCustodyFixture(dir);
    };
    const hasFile = f.engine.hasVolumeFile;
    f.engine.hasVolumeFile = async (...args) => {
      expect(received).toBe(true);
      return hasFile(...args);
    };
    return {
      f,
      credential,
      row,
      cachedRuntime,
      setRuntimeCacheAvailable: (value: boolean) => { runtimeCacheAvailable = value; },
      removedOutsideCli: () => {
        present = false;
      },
    };
  }
  test("a verified owner-managed old pin upgrades through standard paths, retaining enrollment and tuning", async () => {
    const x = retained();
    expect(await x.f.adapter.act!(x.f.ctx, x.f.journal)).toEqual({
      state: "done",
    });
    expect(x.f.engine.files.get("CATALYST_HOST_CREDENTIAL_FILE")).toBe(
      x.credential,
    );
    expect(x.f.engine.files.get("CATALYST_ORG_KEY_FILE")).toBe(ORG_KEY);
    expect(x.f.state.mints).toEqual([]);
    expect(x.f.state.keyMints).toEqual([]);
    expect(x.f.state.admissionWrites).toEqual([]);
    expect(x.f.engine.calls.filter((c) => c === "composeUp")).toHaveLength(1);
    const saved = readFileSync(join(x.f.dir, ".env"), "utf8");
    expect(saved).toContain(`CATALYST_SUPERVISOR_IMAGE=${SUPERVISOR}`);
    expect(saved).toContain(`CATALYST_WATCHDOG_IMAGE=${WATCHDOG}`);
    expect(saved).toContain(`CATALYST_RUNNER_IMAGE=${RUNNER}`);
    expect(saved).toContain("CATALYST_SLOTS=8");
    expect(saved).toContain(`CATALYST_HOST_JOIN_TOKEN=${JOIN_TOKEN}`);
    for (const leaf of ["thoughts", "locks"])
      expect(statSync(join(x.f.dir, leaf)).mode & 0o777).toBe(0o750);
    secretsNowhere(x.f);
  });
  test("a running image that differs from the saved pin stays unverified", async () => {
    const x = retained();
    x.row.Config.Image = `ghcr.io/coalesce-labs/catalyst-supervisor@sha256:${"f".repeat(64)}`;
    expect((await x.f.adapter.act!(x.f.ctx, x.f.journal)).reason).toBe("runner_installation_unverified");
    expect(x.f.engine.calls).not.toContain("composeUp");
  });
  function actOwned(f: ReturnType<typeof fixture>) {
    if (!f.adapter.act) throw Error("fixture must provide an installer action");
    return f.adapter.act(f.ctx, f.journal);
  }
  test("resumes the exact requested pin after an interrupted owner-managed upgrade", async () => {
    const x = retained();
    writeFileSync(join(x.f.dir, ".env"), readFileSync(join(x.f.dir, ".env"), "utf8").replace(/CATALYST_SUPERVISOR_IMAGE=[^\n]+/, `CATALYST_SUPERVISOR_IMAGE=${SUPERVISOR}`), { mode: 0o600 });
    expect(await actOwned(x.f)).toEqual({ state: "done" });
    expect(x.f.engine.calls.filter(call => call === "composeUp")).toHaveLength(1);
    expect(x.f.engine.files.get("CATALYST_HOST_CREDENTIAL_FILE")).toBe(x.credential);
    expect(x.f.state.mints).toEqual([]);
  });
  function interruptedIntent(x: ReturnType<typeof retained>) {
    const middle = `ghcr.io/coalesce-labs/catalyst-supervisor@sha256:${"e".repeat(64)}`;
    writeFileSync(join(x.f.dir, ".env"), readFileSync(join(x.f.dir, ".env"), "utf8").replace(/CATALYST_SUPERVISOR_IMAGE=[^\n]+/, `CATALYST_SUPERVISOR_IMAGE=${middle}`), { mode: 0o600 });
  }
  test("a cached old runtime upgrades after saved intent advanced to a different intermediate pin", async () => {
    const x = retained();
    interruptedIntent(x);
    expect(await actOwned(x.f)).toEqual({ state: "done" });
    expect(x.f.engine.calls.filter(call => call === "composeUp")).toHaveLength(1);
    expect(x.f.engine.files.get("CATALYST_HOST_CREDENTIAL_FILE")).toBe(x.credential);
    expect(x.f.state.mints).toEqual([]);
    expect(readFileSync(join(x.f.dir, ".env"), "utf8")).toContain(`CATALYST_SUPERVISOR_IMAGE=${SUPERVISOR}`);
  });
  test.each(["cache unavailable", "cached identity differs", "configured digest absent", "runtime identity absent", "runtime identity unpinned"])("intermediate saved intent refuses %s before custody, enrollment or config writes", async kind => {
    const x = retained();
    interruptedIntent(x);
    const before = readFileSync(join(x.f.dir, ".env"));
    if (kind === "cache unavailable") x.setRuntimeCacheAvailable(false);
    if (kind === "cached identity differs") x.cachedRuntime.Id = `sha256:${"f".repeat(64)}`;
    if (kind === "configured digest absent") x.cachedRuntime.RepoDigests = [];
    if (kind === "runtime identity absent") x.row.Image = "";
    if (kind === "runtime identity unpinned") x.row.Image = "latest";
    x.f.engine.nativeThoughtsCustody = async () => { throw Error("must not reach custody on an unverified runtime"); };
    x.f.engine.enrollment = async () => { throw Error("must not reach enrollment on an unverified runtime"); };
    expect((await actOwned(x.f)).reason).toBe("runner_installation_unverified");
    expect(readFileSync(join(x.f.dir, ".env"))).toEqual(before);
    expect(x.f.engine.calls).not.toContain("composeUp");
  });
  test("a custody refusal preserves the old pin and permits a supported retry", async () => {
    const x = retained();
    const before = readFileSync(join(x.f.dir, ".env"));
    const custody = x.f.engine.nativeThoughtsCustody;
    x.f.engine.nativeThoughtsCustody = async () => { throw Error("native custody refused"); };
    expect((await actOwned(x.f)).reason).toBe("runner_thoughts_custody_unavailable");
    expect(readFileSync(join(x.f.dir, ".env"))).toEqual(before);
    expect(x.f.engine.calls).not.toContain("composeUp");
    x.f.engine.nativeThoughtsCustody = custody;
    expect(await actOwned(x.f)).toEqual({ state: "done" });
    expect(x.f.engine.calls.filter(call => call === "composeUp")).toHaveLength(1);
  });
  test.each(["latest", `ghcr.io/another-publisher/supervisor@sha256:${"f".repeat(64)}`])("requested saved intent never adopts a foreign or unpinned runtime image: %s", async image => {
    const x = retained();
    x.row.Config.Image = image;
    writeFileSync(join(x.f.dir, ".env"), readFileSync(join(x.f.dir, ".env"), "utf8").replace(/CATALYST_SUPERVISOR_IMAGE=[^\n]+/, `CATALYST_SUPERVISOR_IMAGE=${SUPERVISOR}`), { mode: 0o600 });
    expect((await actOwned(x.f)).reason).toBe("runner_installation_unverified");
    expect(x.f.engine.calls).not.toContain("composeUp");
  });
  test("a matching saved and running pin from another image repository stays unverified", async () => {
    const x = retained();
    const foreign = `ghcr.io/another-publisher/supervisor@sha256:${"f".repeat(64)}`;
    x.row.Config.Image = foreign;
    writeFileSync(join(x.f.dir, ".env"), readFileSync(join(x.f.dir, ".env"), "utf8").replace(/CATALYST_SUPERVISOR_IMAGE=[^\n]+/, `CATALYST_SUPERVISOR_IMAGE=${foreign}`), { mode: 0o600 });
    x.f.engine.enrollment = async () => { throw new Error("must not read enrollment from foreign image"); };
    expect((await x.f.adapter.act!(x.f.ctx, x.f.journal)).reason).toBe("runner_installation_unverified");
    expect(x.f.engine.calls).not.toContain("composeUp");
  });
  test("an unpinned saved image stays unverified", async () => {
    const x = retained();
    writeFileSync(join(x.f.dir, ".env"), readFileSync(join(x.f.dir, ".env"), "utf8").replace(/CATALYST_SUPERVISOR_IMAGE=[^\n]+/, "CATALYST_SUPERVISOR_IMAGE=latest"), { mode: 0o600 });
    expect((await x.f.adapter.act!(x.f.ctx, x.f.journal)).reason).toBe("runner_installation_unverified");
    expect(x.f.engine.calls).not.toContain("composeUp");
  });
  test("an old pin with a different saved runtime identity stays unverified", async () => {
    const x = retained();
    writeFileSync(join(x.f.dir, ".env"), readFileSync(join(x.f.dir, ".env"), "utf8").replace("CATALYST_HOST_NAME=catalyst-laptop", "CATALYST_HOST_NAME=someone-else"), { mode: 0o600 });
    expect((await x.f.adapter.act!(x.f.ctx, x.f.journal)).reason).toBe("runner_installation_unverified");
    expect(x.f.engine.calls).not.toContain("composeUp");
  });
  test("an old pin with a different saved cloud URL stays unverified", async () => {
    const x = retained();
    writeFileSync(join(x.f.dir, ".env"), readFileSync(join(x.f.dir, ".env"), "utf8").replace("CATALYST_MIRROR_URL=https://cloud.example.test", "CATALYST_MIRROR_URL=https://other.example.test"), { mode: 0o600 });
    x.f.engine.enrollment = async () => { throw new Error("must not read enrollment from mismatched cloud"); };
    expect((await x.f.adapter.act!(x.f.ctx, x.f.journal)).reason).toBe("runner_installation_unverified");
    expect(x.f.engine.calls).not.toContain("composeUp");
  });
  test("a missing old container can still be replaced through the verified saved enrollment", async () => {
    const x = retained();
    x.removedOutsideCli();
    expect(await x.f.adapter.act!(x.f.ctx, x.f.journal)).toEqual({ state: "done" });
    expect(x.f.engine.files.get("CATALYST_HOST_CREDENTIAL_FILE")).toBe(x.credential);
    expect(x.f.state.mints).toEqual([]);
    expect(x.f.engine.calls.filter((call) => call === "composeUp")).toHaveLength(1);
  });
  test.each(["uncached target", "native custody refusal"])(
    "refuses %s before reading or changing retained credentials or activating Compose",
    async (kind) => {
      const x = retained();
      x.removedOutsideCli();
      if (kind === "uncached target") x.f.engine.images.delete(SUPERVISOR);
      else
        x.f.engine.nativeThoughtsCustody = async () => {
          throw new Error("native custody refused");
        };
      expect((await x.f.adapter.act!(x.f.ctx, x.f.journal)).state).toBe(
        "waiting",
      );
      expect(x.f.engine.files.get("CATALYST_HOST_CREDENTIAL_FILE")).toBe(
        x.credential,
      );
      expect(x.f.engine.files.get("CATALYST_ORG_KEY_FILE")).toBe(ORG_KEY);
      expect(x.f.state.mints).toEqual([]);
      expect(x.f.state.keyMints).toEqual([]);
      expect(x.f.state.admissionWrites).toEqual([]);
      expect(x.f.engine.calls).not.toContain("composeUp");
      expect(x.f.engine.calls.filter(call => call.startsWith("pull "))).toEqual(
        kind === "uncached target" ? [`pull ${SUPERVISOR}`] : [],
      );
    },
  );
});

describe("installing over an existing catalyst-host project", () => {
  function withOrgKey(f: ReturnType<typeof fixture>) {
    const file = join(f.home, "org-key");
    writeFileSync(file, `${ORG_KEY}\n`, { mode: 0o600 });
    f.ctx.env.CATALYST_RUNNER_ORG_KEY_FILE = file;
  }

  test("a paused project is resumed and adopted before Compose starts", async () => {
    const engine = fakeEngine();
    engine.containers = [
      { service: "supervisor", state: "paused" },
      { service: "watchdog", state: "paused" },
    ];
    const f = fixture({ selected: true, engine });
    withOrgKey(f);
    expect(await run(f)).toMatchObject({ state: "done", evidence: { hostId: "host-1" } });
    expect(engine.calls.indexOf("composeUnpause")).toBeGreaterThan(-1);
    expect(engine.calls.indexOf("composeUnpause")).toBeLessThan(engine.calls.indexOf("composeUp"));
    expect(engine.containers?.every((row) => row.state === "running")).toBe(true);
    expect(f.messages.join("\n")).toContain("Resumed the paused containers (supervisor, watchdog)");
    expect(f.messages.join("\n")).toContain("catalyst-host");
    secretsNowhere(f);
  });

  test("a paused project that cannot resume stops with the exact command, never exit 10", async () => {
    const engine = fakeEngine();
    engine.containers = [{ service: "supervisor", state: "paused" }];
    engine.unpauseFails = true;
    const f = fixture({ selected: true, engine });
    withOrgKey(f);
    const result = await run(f);
    expect(result).toMatchObject({
      state: "waiting",
      reason: "runner_compose_paused",
      evidence: { project: "catalyst-host", services: "supervisor" },
    });
    expect(engine.calls).not.toContain("composeUp");
    if (result.state !== "waiting") throw Error("expected a waiting result");
    const text = onboardReasonText({ id: "runner", ...result, state: result.state });
    expect(text).toContain("docker compose -p catalyst-host unpause");
    expect(text).toContain("supervisor");
    expect(text).toContain("catalyst onboard --runner");
    expect(text).toContain("removed nothing");
    secretsNowhere(f);
  });

  test("a stopped project is adopted with its stopped containers named", async () => {
    const engine = fakeEngine();
    engine.containers = [
      { service: "supervisor", state: "exited" },
      { service: "watchdog", state: "exited" },
    ];
    const f = fixture({ selected: true, engine });
    withOrgKey(f);
    expect(await run(f)).toMatchObject({ state: "done", evidence: { hostId: "host-1" } });
    expect(engine.calls).not.toContain("composeUnpause");
    expect(f.messages.join("\n")).toContain("Starting the existing catalyst-host project's stopped containers (supervisor, watchdog)");
    secretsNowhere(f);
  });

  test("a changed Compose file names the existing containers it replaces", async () => {
    const engine = fakeEngine();
    engine.containers = [{ service: "supervisor", state: "running" }];
    const f = fixture({ selected: true, engine });
    withOrgKey(f);
    mkdirSync(f.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(f.dir, "compose.yaml"), "name: catalyst-host\nservices: {}\n", { mode: 0o644 });
    expect(await f.adapter.act!(f.ctx, f.journal)).toEqual({ state: "done" });
    expect(f.messages.join("\n")).toContain("Replacing the existing catalyst-host project's containers (supervisor)");
    secretsNowhere(f);
  });

  test("a clean machine behaves exactly as today", async () => {
    const engine = fakeEngine();
    engine.containers = [];
    const f = fixture({ selected: true, engine });
    withOrgKey(f);
    expect(await run(f)).toMatchObject({ state: "done", evidence: { hostId: "host-1", capacity: 2 } });
    expect(engine.calls).not.toContain("composeUnpause");
    expect(f.messages.join("\n")).not.toMatch(/existing catalyst-host project/i);
    const legacy = fakeEngine();
    delete legacy.projectContainers;
    delete legacy.composeUnpause;
    const plain = fixture({ selected: true, engine: legacy });
    withOrgKey(plain);
    expect(await run(plain)).toMatchObject({ state: "done", evidence: { hostId: "host-1" } });
    expect(legacy.calls).not.toContain("composeUnpause");
    secretsNowhere(f);
    secretsNowhere(plain);
  });

  test("a Compose failure over a stopped project names the error, the project and the next command", async () => {
    const engine = fakeEngine();
    engine.containers = [{ service: "supervisor", state: "exited" }];
    engine.upError = "Error response from daemon: Cannot start container catalyst-host-supervisor-1: container is paused";
    const f = fixture({ selected: true, engine });
    withOrgKey(f);
    const result = await run(f);
    expect(result).toMatchObject({
      state: "failed",
      reason: "runner_compose_failed",
      evidence: { project: "catalyst-host", composeError: "Error response from daemon: Cannot start container catalyst-host-supervisor-1: container is paused" },
    });
    if (result.state !== "failed") throw Error("expected a failed result");
    const text = onboardReasonText({ id: "runner", ...result, state: result.state });
    expect(text).toContain("runner project catalyst-host");
    expect(text).toContain("container is paused");
    expect(text).toContain("docker compose -p catalyst-host logs");
    expect(text).toContain("catalyst onboard --runner");
    secretsNowhere(f);
  });

  test("a Compose failure without captured output still names the project and the next command", async () => {
    const engine = fakeEngine();
    engine.upError = "";
    const f = fixture({ selected: true, engine });
    withOrgKey(f);
    const result = await run(f);
    expect(result).toMatchObject({
      state: "failed",
      reason: "runner_compose_failed",
      evidence: { project: "catalyst-host" },
    });
    if (result.state !== "failed" || !result.evidence) throw Error("expected a failed result with evidence");
    expect(result.evidence.composeError).toBeUndefined();
    const text = onboardReasonText({ id: "runner", ...result, state: result.state });
    expect(text).toContain("runner project catalyst-host");
    expect(text).toContain("docker compose -p catalyst-host logs");
    secretsNowhere(f);
  });
});

describe("CTC-5929: the Mac's physical disk sample and a zero-slot reason", () => {
  function withOrgKey(f: ReturnType<typeof fixture>) {
    const file = join(f.home, "org-key");
    writeFileSync(file, `${ORG_KEY}\n`, { mode: 0o600 });
    f.ctx.env.CATALYST_RUNNER_ORG_KEY_FILE = file;
  }
  function withSampler(f: ReturnType<typeof fixture>, result: "ready" | "runner_host_disk_sampler_python_missing" = "ready") {
    let installed = false;
    f.engine.installHostDiskSampler = async (dir) => {
      f.engine.calls.push(`installHostDiskSampler ${dir}`);
      installed = result === "ready";
      return result;
    };
    f.engine.hostDiskSamplerStatus = async () => (installed ? "installed" : "missing");
  }
  const envOf = (f: ReturnType<typeof fixture>) => readFileSync(join(f.dir, ".env"), "utf8");

  test("setup installs the sampler before Compose and points the supervisor at its sample", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    withSampler(f);
    expect(await run(f)).toMatchObject({ state: "done", evidence: { capacity: 2 } });
    const calls = f.engine.calls;
    expect(calls.indexOf(`installHostDiskSampler ${f.dir}`)).toBeGreaterThan(-1);
    expect(calls.indexOf(`installHostDiskSampler ${f.dir}`)).toBeLessThan(calls.indexOf("composeUp"));
    expect(envOf(f)).toContain("CATALYST_HOST_DISK_SAMPLE_FILE=/var/lib/catalyst/host-disk/space.json\n");
  });

  test("a sampler that cannot be installed stops setup before the runner starts", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    withSampler(f, "runner_host_disk_sampler_python_missing");
    const result = await run(f);
    expect(result).toMatchObject({ state: "waiting", reason: "runner_host_disk_sampler_python_missing" });
    expect(f.engine.calls).not.toContain("composeUp");
    expect(onboardReasonText({ id: "runner", state: "waiting", reason: result.reason })).toContain("xcode-select --install");
  });

  test("a conflicting agent's recovery names both sample settings with its real values", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.engine.installHostDiskSampler = async () => "runner_host_disk_sampler_conflict";
    f.engine.hostDiskSamplerStatus = async () => "missing";
    mkdirSync(join(f.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(f.home, "Library", "LaunchAgents", "dev.catalystcloud.host-disk.plist"),
      "<array><string>--output</string><string>/Users/a/.local/share/catalyst/host-disk/space.json</string></array>");
    const result = await run(f);
    expect(result).toMatchObject({ state: "waiting", reason: "runner_host_disk_sampler_conflict",
      evidence: { sampleDir: "/Users/a/.local/share/catalyst/host-disk", sampleFile: "/var/lib/catalyst/host-disk/space.json" } });
    const text = onboardReasonText({ id: "runner", state: "waiting", reason: result.reason, evidence: result.evidence });
    expect(text).toContain("CATALYST_HOST_DISK_SAMPLE_DIR=/Users/a/.local/share/catalyst/host-disk");
    expect(text).toContain("CATALYST_HOST_DISK_SAMPLE_FILE=/var/lib/catalyst/host-disk/space.json");
    const bare = onboardReasonText({ id: "runner", state: "waiting", reason: "runner_host_disk_sampler_conflict" });
    expect(bare).toContain("CATALYST_HOST_DISK_SAMPLE_DIR=");
    expect(bare).toContain("CATALYST_HOST_DISK_SAMPLE_FILE=/var/lib/catalyst/host-disk/");
    expect(f.engine.calls).not.toContain("composeUp");
  });

  test("an engine disk setup cannot locate asks for CATALYST_HOST_DISK_PATH, which unattended checks reuse", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    const seen: Array<string | undefined> = [];
    f.engine.installHostDiskSampler = async (_dir, options) => {
      seen.push(options.explicitPath);
      return options.explicitPath ? "ready" : "runner_host_disk_location_unverified";
    };
    f.engine.hostDiskSamplerStatus = async (_dir, options) => { seen.push(options.explicitPath); return options.explicitPath ? "installed" : "missing"; };
    const refused = await run(f);
    expect(refused).toMatchObject({ state: "waiting", reason: "runner_host_disk_location_unverified" });
    expect(onboardReasonText({ id: "runner", state: "waiting", reason: refused.reason })).toContain("CATALYST_HOST_DISK_PATH");
    const named = fixture({ selected: true });
    withOrgKey(named);
    named.engine.installHostDiskSampler = f.engine.installHostDiskSampler;
    named.engine.hostDiskSamplerStatus = f.engine.hostDiskSamplerStatus;
    named.ctx.env.CATALYST_HOST_DISK_PATH = "/Volumes/VMs";
    expect(await run(named)).toMatchObject({ state: "done" });
    expect(readFileSync(join(named.dir, ".env"), "utf8")).toContain("CATALYST_HOST_DISK_PATH=/Volumes/VMs\n");
    delete named.ctx.env.CATALYST_HOST_DISK_PATH;
    seen.length = 0;
    const unattended = onboardRunnerAdapter({ engine: named.engine, sleep: async () => {}, waitMs: 20, pollMs: 10 });
    named.journal.steps = [...named.journal.steps.filter(step => step.id !== "runner"),
      { id: "runner", state: "done", evidence: { selected: true } }] as OnboardJournal["steps"];
    await unattended.check(named.ctx, named.journal);
    expect(seen).toEqual(["/Volumes/VMs"]);
  });

  test("an operator's own sample directory is left to its publisher", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    withSampler(f);
    f.ctx.env.CATALYST_HOST_DISK_SAMPLE_DIR = join(f.home, "operator-samples");
    f.ctx.env.CATALYST_HOST_DISK_SAMPLE_FILE = "/var/lib/catalyst/host-disk/space.json";
    expect(await run(f)).toMatchObject({ state: "done" });
    expect(f.engine.calls.some(call => call.startsWith("installHostDiskSampler"))).toBe(false);
    expect(envOf(f)).toContain(`CATALYST_HOST_DISK_SAMPLE_DIR=${join(f.home, "operator-samples")}\n`);
  });

  test("an unattended check reports a missing sampler instead of repairing it", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    withSampler(f);
    expect(await run(f)).toMatchObject({ state: "done" });
    f.engine.hostDiskSamplerStatus = async () => "missing";
    const unattended = onboardRunnerAdapter({ engine: f.engine, sleep: async () => {}, waitMs: 20, pollMs: 10 });
    f.journal.steps = [...f.journal.steps.filter(step => step.id !== "runner"),
      { id: "runner", state: "done", evidence: { selected: true } }] as OnboardJournal["steps"];
    expect(await unattended.check(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "runner_needs_runner_flag" });
  });

  test.each([
    [{ state: "unmeasured" as const, detail: "physical_host_disk_sample_required" as const, floorGiB: 25 },
      "runner_host_disk_unmeasured", ["no fresh measurement of this Mac's disk", "dev.catalystcloud.host-disk"]],
    [{ state: "below_floor" as const, availableGiB: 15.62, floorGiB: 25 },
      "runner_host_disk_below_floor", ["15.62 GiB of disk is free and it needs 25 GiB", "Free at least 10 GiB"]],
  ])("zero free slots name the disk reason: %o", async (verdict, reason, words) => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.state.capability!.placeableCapacity = 0;
    f.engine.hostDisk = async () => verdict;
    const result = await run(f);
    expect(result).toMatchObject({ state: "waiting", reason, evidence: { capacity: 0, floorGiB: 25 } });
    const text = onboardReasonText({ id: "runner", state: "waiting", reason: result.reason, evidence: result.evidence });
    for (const word of words) expect(text).toContain(word);
    expect(text).not.toContain(reason);
    expect(text).not.toContain("—");
  });

  // CTC-5929 Lima arm64: ready said 34.51 GiB against 60 GiB, but setup printed "no disk sampler",
  // because the saved setup record dropped the disk evidence and setup prints from that record.
  test("the saved setup record keeps a Linux below-floor reason with its numbers", async () => {
    const engine = fakeEngine({ arch: "amd64", vm: false });
    for (const ref of [SUPERVISOR, WATCHDOG, RUNNER]) engine.images.set(ref, "amd64");
    const f = fixture({ selected: true, engine });
    withOrgKey(f);
    f.state.capability!.placeableCapacity = 0;
    f.engine.hostDisk = async () => ({ state: "below_floor", availableGiB: 34.51, floorGiB: 60 });
    const result = await run(f);
    const path = join(f.home, "saved-run.json");
    writeOnboardJournal(path, { schema: 1, steps: [{ id: "runner", state: "waiting", reason: result.reason, evidence: result.evidence }] } as OnboardJournal);
    const saved = readOnboardJournal(path)!.steps[0]!;
    expect(saved.evidence).toMatchObject({ availableGiB: 34.51, floorGiB: 60, vm: false });
    const text = onboardReasonText(saved);
    expect(text).toContain("34.51 GiB of disk is free and it needs 60 GiB");
    expect(text).toContain("the disk that holds Docker's data");
    expect(text).not.toContain("no disk sampler");
    expect(text).not.toContain("Mac");
  });

  test("a below-floor reason without its numbers never claims a missing sampler", () => {
    const text = onboardReasonText({ id: "runner", state: "waiting", reason: "runner_host_disk_below_floor", evidence: { floorGiB: 60 } });
    expect(text).toContain("less than 60 GiB free");
    expect(text).not.toContain("sampler");
  });

  test("zero free slots with a measured disk keep the readiness reason", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.state.capability!.placeableCapacity = 0;
    f.engine.hostDisk = async () => ({ state: "measured", availableGiB: 120, floorGiB: 25 });
    expect(await run(f)).toMatchObject({ state: "waiting", reason: "runner_host_not_ready", evidence: { capacity: 0 } });
  });
});

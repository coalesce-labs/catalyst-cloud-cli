// env-shell.test.ts — CTC-3550: `catalyst env shell [--check]` end to end through main(), against a
// recording Docker port and, for the credential fallback, the fixture cloud. No Docker engine runs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import type { DockerConfigJson, EnvShellDocker, EnvShellServer } from "../src/env/shell-docker";
import type { EnvShellDeps } from "../src/env/shell";
import { RUNNER_HOST_IMAGES } from "../src/onboard-runner";
import { buildFixtureContract, FIXTURE_ROUTE_PREFIX } from "./fixture-contract";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

const IMAGE = RUNNER_HOST_IMAGES.runner;
const SHORT = "ghcr.io/coalesce-labs/catalyst-runner@sha256:a19f7b0859a9…";
const OAKMONT = [
  "[environment]",
  'toolchains = [{ name = "node", version = "22" }, { name = "bun", version = "1.3.14" }]',
  "[[environment.variables]]",
  'name = "DATABASE_URL"',
  "required = true",
  "[[environment.variables]]",
  'name = "STRIPE_SECRET_KEY"',
  "required = true",
  "secret = true",
  "[[environment.variables]]",
  'name = "SENTRY_DSN"',
  "",
].join("\n");
const VALUES = { DATABASE_URL: "postgres://localhost/web-secret", STRIPE_SECRET_KEY: "sk_test_SECRET" };
const RESOLVED: Record<string, string> = { "node@22": "22.23.3", "bun@1.3.14": "1.3.14" };

interface Recorded {
  calls: string[];
  pulls: { ref: string; host: string; config: DockerConfigJson }[];
  runs: { argv: string[]; env: NodeJS.ProcessEnv; mode: "interactive" | "capture" }[];
}

/** What the start script would print in check mode, from the argv and env the CLI built. */
function checkStdout(argv: string[], env: NodeJS.ProcessEnv): string {
  const at = argv.indexOf("catalyst-env-shell");
  const specs = argv.slice(at + 2);
  const names = (argv.find((word) => word.startsWith("CATALYST_ENV_NAMES=")) ?? "CATALYST_ENV_NAMES=")
    .slice("CATALYST_ENV_NAMES=".length)
    .split(" ")
    .filter(Boolean);
  const passed = new Set(argv.flatMap((word, i) => (argv[i - 1] === "-e" && !word.includes("=") ? [word] : [])));
  return [
    ...specs.map((spec) => `toolchain\t${spec}\t${RESOLVED[spec] ?? "1.0.0"}`),
    ...names.map((name) => `variable\t${name}\t${passed.has(name) && env[name] !== undefined ? "set" : "unset"}`),
    "",
  ].join("\n");
}

function recordingPort(
  over: {
    server?: EnvShellServer;
    present?: boolean;
    pulls?: { ok: boolean; detail: string }[];
    runCode?: number;
    endpoint?: Awaited<ReturnType<EnvShellDocker["endpoint"]>>;
  } = {},
): { docker: EnvShellDocker; rec: Recorded } {
  const rec: Recorded = { calls: [], pulls: [], runs: [] };
  let present = over.present ?? true;
  const pulls = [...(over.pulls ?? [{ ok: true, detail: "" }])];
  return {
    rec,
    docker: {
      server: async () => {
        rec.calls.push("server");
        return over.server ?? { state: "ok" };
      },
      endpoint: async () => {
        rec.calls.push("endpoint");
        return over.endpoint ?? { ok: true, host: "unix:///var/run/docker.sock" };
      },
      imagePresent: async () => {
        rec.calls.push("imagePresent");
        return present;
      },
      pull: async (ref, host, config) => {
        rec.calls.push("pull");
        rec.pulls.push({ ref, host, config: structuredClone(config) });
        const answer = pulls.shift() ?? { ok: false, detail: "no more pulls" };
        if (answer.ok) present = true;
        return answer;
      },
      run: async (argv, env, mode) => {
        rec.calls.push(`run:${mode}`);
        rec.runs.push({ argv, env, mode });
        const code = over.runCode ?? 0;
        return { code, stdout: mode === "capture" && code === 0 ? checkStdout(argv, env) : "" };
      },
    },
  };
}

let repo: string;
let home: string;
let ctx: TestCtx;

function writeDeclaration(dir: string, text: string): void {
  mkdirSync(join(dir, ".catalyst"), { recursive: true });
  writeFileSync(join(dir, ".catalyst", "catalyst.toml"), text);
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "catalyst-env-shell-")));
  writeDeclaration(repo, OAKMONT);
  home = tempHome();
  ctx = makeCtx(home, { env: { CATALYST_SKILLS_OFFLINE: "1", PATH: process.env.PATH, ...VALUES } });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function deps(docker: EnvShellDocker, over: Partial<EnvShellDeps> = {}) {
  return {
    env: {
      shell: {
        docker,
        isTty: () => true,
        platform: "darwin" as const,
        uid: 501,
        readRepositoryName: async () => "oakmont-labs/web",
        gitCommonDir: async () => null,
        ...over,
      },
    },
  };
}

const shell = (args: string[], docker: EnvShellDocker, over: Partial<EnvShellDeps> = {}) =>
  main(["env", "shell", "--root", repo, ...args], ctx, deps(docker, over));

describe("catalyst env shell --check", () => {
  test("--check in this repository's own checkout: text report as designed; exit 0", async () => {
    const { docker, rec } = recordingPort();
    const root = realpathSync(".");
    const code = await main(["env", "shell", "--check", "--root", root], ctx, deps(docker, {
      readRepositoryName: async () => "coalesce-labs/catalyst-cloud-cli",
    }));
    expect(ctx.err).toEqual([]);
    expect(code).toBe(0);
    expect(ctx.out).toEqual([
      "Environment for coalesce-labs/catalyst-cloud-cli, from .catalyst/catalyst.toml",
      `  Image: ${SHORT} (already on this computer)`,
      "  Toolchain: node 22 → 22.23.3, bun 1.3.14 → 1.3.14",
      "  Variables: none declared",
      "Ready: catalyst env shell opens this environment.",
    ]);
    expect(rec.calls).toEqual(["server", "imagePresent", "run:capture"]);
    expect(rec.runs[0]!.argv).toContain(`type=bind,src=${root},dst=/workspace`);
  });

  test("the oakmont example: variables set, secret and optional, as designed", async () => {
    const { docker } = recordingPort();
    expect(await shell(["--check"], docker)).toBe(0);
    expect(ctx.out).toEqual([
      "Environment for oakmont-labs/web, from .catalyst/catalyst.toml",
      `  Image: ${SHORT} (already on this computer)`,
      "  Toolchain: node 22 → 22.23.3, bun 1.3.14 → 1.3.14",
      "  Variables: DATABASE_URL set, STRIPE_SECRET_KEY set (secret), SENTRY_DSN not set (optional)",
      "Ready: catalyst env shell opens this environment.",
    ]);
  });

  test("--check --json: exactly one stdout line, the designed object; image.credential 'none'", async () => {
    const { docker } = recordingPort();
    expect(await shell(["--check", "--json"], docker)).toBe(0);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0]!)).toEqual({
      ok: true,
      repository: "oakmont-labs/web",
      declaration: ".catalyst/catalyst.toml",
      image: { reference: IMAGE, source: "present", credential: "none" },
      toolchains: [
        { name: "node", version: "22", resolved: "22.23.3" },
        { name: "bun", version: "1.3.14", resolved: "1.3.14" },
      ],
      variables: [
        { name: "DATABASE_URL", required: true, secret: false, set: true },
        { name: "STRIPE_SECRET_KEY", required: true, secret: true, set: true },
        { name: "SENTRY_DSN", required: false, secret: false, set: false },
      ],
    });
  });

  test("--json without --check is a UsageError that prints env's help", async () => {
    const { docker, rec } = recordingPort();
    expect(await shell(["--json"], docker)).toBe(1);
    expect(ctx.err[0]).toBe("env shell --json needs --check: the shell itself is interactive");
    expect(ctx.err.join("\n")).toContain("shell [--root DIR] [--env-file FILE]... [--image REF] [--check]");
    expect(rec.calls).toEqual([]);
  });

  test("--image must be digest-pinned: a tag-only reference is a UsageError", async () => {
    const { docker, rec } = recordingPort();
    expect(await shell(["--check", "--image", "ghcr.io/acme/env:latest"], docker)).toBe(1);
    expect(ctx.err[0]).toContain("env shell --image needs a digest-pinned reference");
    expect(rec.calls).toEqual([]);
  });

  test("a positional argument is a UsageError", async () => {
    const { docker } = recordingPort();
    expect(await shell(["extra"], docker)).toBe(1);
    expect(ctx.err[0]).toContain("env shell takes no positional arguments");
  });

  test("refusal order: declaration → variables → Docker; a missing required variable never calls the port", async () => {
    const { docker, rec } = recordingPort({ server: { state: "missing" } });
    ctx.env = { PATH: process.env.PATH };
    expect(await shell(["--check"], docker)).toBe(1);
    expect(ctx.err).toEqual([
      "These required variables are not set in this terminal or an --env-file: DATABASE_URL, STRIPE_SECRET_KEY. Set them, then run catalyst env shell again.",
    ]);
    expect(rec.calls).toEqual([]);
    writeDeclaration(repo, '[environment]\ntoolchains = [{ name = "node", version = "^22" }]\n');
    ctx.err.length = 0;
    expect(await shell(["--check"], docker)).toBe(1);
    expect(ctx.err[0]).toContain("is a version range");
    expect(rec.calls).toEqual([]);
  });

  test("the image is downloaded only when absent; source 'downloaded' vs 'present'", async () => {
    const absent = recordingPort({ present: false });
    expect(await shell(["--check", "--json"], absent.docker)).toBe(0);
    expect(absent.rec.calls).toEqual(["server", "imagePresent", "endpoint", "pull", "run:capture"]);
    expect(absent.rec.pulls[0]!.config).toEqual({ auths: { "https://index.docker.io/v1/": {} } });
    expect(JSON.parse(ctx.out[0]!).image).toEqual({ reference: IMAGE, source: "downloaded", credential: "none" });
    expect(ctx.err).toContain("  Downloading it with no credential (about 2.3 GB, once per image)…");

    ctx.out.length = 0;
    const present = recordingPort({ present: true });
    expect(await shell(["--check", "--json"], present.docker)).toBe(0);
    expect(present.rec.calls).not.toContain("pull");
    expect(JSON.parse(ctx.out[0]!).image.source).toBe("present");
  });

  test("works with no customer.json (not signed in) for Catalyst's image", async () => {
    const { docker } = recordingPort({ present: false });
    expect(await shell(["--check"], docker)).toBe(0);
    expect(ctx.out).toEqual([
      "Environment for oakmont-labs/web, from .catalyst/catalyst.toml",
      `  Image: ${SHORT} (not on this computer yet)`,
      "  Downloading it with no credential (about 2.3 GB, once per image)…",
      "  Downloaded.",
      "  Toolchain: node 22 → 22.23.3, bun 1.3.14 → 1.3.14",
      "  Variables: DATABASE_URL set, STRIPE_SECRET_KEY set (secret), SENTRY_DSN not set (optional)",
      "Ready: catalyst env shell opens this environment.",
    ]);
  });
});

describe("refusals", () => {
  const refusal = async (args: string[], docker: EnvShellDocker, over: Partial<EnvShellDeps> = {}) => {
    ctx.out.length = 0;
    ctx.err.length = 0;
    expect(await shell([...args, "--check", "--json"], docker, over)).toBe(1);
    expect(ctx.out).toHaveLength(1);
    const body = JSON.parse(ctx.out[0]!) as { ok: boolean; refusal: { code: string; message: string; names?: string[] } };
    expect(body.ok).toBe(false);
    return body.refusal;
  };

  test("each refusal prints its designed sentence and exits 1; under --json it is {ok:false,refusal:{code,message[,names]}}", async () => {
    const ok = recordingPort().docker;
    const empty = realpathSync(mkdtempSync(join(tmpdir(), "catalyst-env-empty-")));
    ctx.err.length = 0;
    expect(await main(["env", "shell", "--check", "--root", empty], ctx, deps(ok))).toBe(1);
    expect(ctx.err).toEqual([`No .catalyst/catalyst.toml in ${empty}. Draft one with: catalyst env draft --write`]);
    expect(await main(["env", "shell", "--check", "--json", "--root", join(empty, "nope")], ctx, deps(ok))).toBe(1);
    expect(JSON.parse(ctx.out.at(-1)!).refusal.code).toBe("declaration_missing");
    rmSync(empty, { recursive: true, force: true });

    writeDeclaration(repo, '[environment]\n[[environment.variables]]\nname = "1BAD"\n');
    ctx.err.length = 0;
    expect(await shell(["--check"], ok)).toBe(1);
    expect(ctx.err).toEqual([
      ".catalyst/catalyst.toml: environment.variables[0].name is not a valid environment variable name",
      "Fix the file, then run catalyst env check.",
    ]);
    expect((await refusal([], ok)).code).toBe("declaration_invalid");

    writeDeclaration(repo, '[environment]\ntoolchains = [{ name = "node", version = ">=20 <22" }]\n');
    expect(await refusal([], ok)).toEqual({
      code: "toolchain_version_unsupported",
      message: 'node ">=20 <22" is a version range. env shell prepares an exact or prefix version, such as 22 or 22.23.3. Change it in .catalyst/catalyst.toml.',
    });

    writeDeclaration(repo, OAKMONT);
    expect(await refusal(["--env-file", join(repo, "missing.env")], ok)).toEqual({
      code: "env_file_unreadable",
      message: `could not read --env-file ${join(repo, "missing.env")}`,
    });

    ctx.env = { PATH: process.env.PATH, DATABASE_URL: "x" };
    expect(await refusal([], ok)).toEqual({
      code: "variables_missing",
      message: "These required variables are not set in this terminal or an --env-file: STRIPE_SECRET_KEY. Set them, then run catalyst env shell again.",
      names: ["STRIPE_SECRET_KEY"],
    });
    ctx.env = { PATH: process.env.PATH, ...VALUES };

    const comma = realpathSync(mkdtempSync(join(tmpdir(), "catalyst-env-a,b-")));
    writeDeclaration(comma, OAKMONT);
    ctx.out.length = 0;
    expect(await main(["env", "shell", "--check", "--json", "--root", comma], ctx, deps(ok))).toBe(1);
    expect(JSON.parse(ctx.out[0]!).refusal).toEqual({
      code: "repository_path_unsupported",
      message: `env shell cannot mount ${comma}: the path contains a comma.`,
    });
    rmSync(comma, { recursive: true, force: true });

    expect(await refusal([], recordingPort({ server: { state: "missing" } }).docker)).toEqual({
      code: "docker_missing",
      message: "Docker is not installed on this computer. Install Docker Desktop, OrbStack or Docker Engine, then run catalyst env shell again.",
    });
    expect(await refusal([], recordingPort({ server: { state: "not_running" } }).docker)).toEqual({
      code: "docker_not_running",
      message: "Docker is installed but not running. Start Docker Desktop, OrbStack or Docker Engine, then run catalyst env shell again.",
    });
    expect(await refusal([], recordingPort({ server: { state: "not_linux", os: "windows" } }).docker)).toEqual({
      code: "docker_not_linux",
      message: "Docker is running windows containers. Switch it to Linux containers, then run catalyst env shell again.",
    });
    expect(await refusal([], recordingPort({ present: false, endpoint: { ok: false, reason: "conflict" } }).docker)).toEqual({
      code: "docker_endpoint_conflict",
      message: "DOCKER_HOST and DOCKER_CONTEXT are both set. Unset one, then run catalyst env shell again.",
    });
    expect((await refusal([], recordingPort({ present: false, endpoint: { ok: false, reason: "unreadable" } }).docker)).code).toBe(
      "docker_endpoint_unreadable",
    );
    expect(
      await refusal([], recordingPort({ present: false, pulls: [{ ok: false, detail: "Error response from daemon: denied." }] }).docker),
    ).toEqual({
      code: "image_download_refused",
      message: `Could not download ${IMAGE} with no credential: Error response from daemon: denied. If this image needs your workspace's permission, sign in with catalyst login and run this again.`,
    });
    expect(await refusal([], recordingPort({ runCode: 97 }).docker)).toEqual({
      code: "toolchain_not_prepared",
      message: "The shell did not start: a declared toolchain could not be prepared (mise's message above says which). Check the name and version in .catalyst/catalyst.toml, then run catalyst env shell --check.",
    });
    expect((await refusal([], recordingPort({ runCode: 1 }).docker)).code).toBe("check_incomplete");
  });
});

describe("catalyst env shell (interactive)", () => {
  test("shell mode: run(interactive) gets the plan's argv; its exit code 3 is the command's exit code; 97 → toolchain_not_prepared, exit 1", async () => {
    const { docker, rec } = recordingPort({ runCode: 3 });
    expect(await shell([], docker)).toBe(3);
    expect(rec.runs).toHaveLength(1);
    expect(rec.runs[0]!.mode).toBe("interactive");
    const argv = rec.runs[0]!.argv;
    expect(argv.slice(0, 6)).toEqual(["run", "--rm", "--pull", "never", "-i", "-t"]);
    expect(argv.slice(-4)).toEqual(["catalyst-env-shell", "shell", "node@22", "bun@1.3.14"]);
    expect(rec.runs[0]!.env.TERM).toBe("xterm-256color");
    expect(ctx.out).toEqual([
      "Environment for oakmont-labs/web, from .catalyst/catalyst.toml",
      `  Image: ${SHORT} (already on this computer)`,
      "  Toolchain: node 22, bun 1.3.14 (the first start downloads any version the image lacks)",
      "  Variables: DATABASE_URL, STRIPE_SECRET_KEY (secret) set from this terminal; not set: SENTRY_DSN (optional)",
      "  Your repository is at /workspace. Type exit to leave.",
    ]);

    ctx.out.length = 0;
    const failing = recordingPort({ runCode: 97 });
    expect(await shell([], failing.docker)).toBe(1);
    expect(ctx.err.at(-1)).toContain("The shell did not start: a declared toolchain could not be prepared");
  });

  test("the declared values reach the run's env and no output line; undeclared CLOUDFLARE_API_TOKEN reaches neither argv nor -e", async () => {
    const envFile = join(repo, ".env.local");
    writeFileSync(envFile, 'export SENTRY_DSN="https://dsn-secret@example.invalid/1"\nUNDECLARED=nope\n');
    ctx.env = { ...ctx.env, CLOUDFLARE_API_TOKEN: "cf-secret-token", TERM: "screen" };
    const { docker, rec } = recordingPort();
    expect(await shell(["--env-file", envFile], docker)).toBe(0);
    const run = rec.runs[0]!;
    expect(run.env.DATABASE_URL).toBe(VALUES.DATABASE_URL);
    expect(run.env.STRIPE_SECRET_KEY).toBe(VALUES.STRIPE_SECRET_KEY);
    expect(run.env.SENTRY_DSN).toBe("https://dsn-secret@example.invalid/1");
    expect(run.env.UNDECLARED).toBeUndefined();
    expect(run.env.TERM).toBe("screen");
    const passed = run.argv.flatMap((word, i) => (run.argv[i - 1] === "-e" ? [word] : []));
    expect(passed).toContain("SENTRY_DSN");
    expect(passed).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(run.argv.join(" ")).not.toContain("CLOUDFLARE_API_TOKEN");
    for (const secret of [VALUES.DATABASE_URL, VALUES.STRIPE_SECRET_KEY, "dsn-secret", "cf-secret-token"]) {
      expect(run.argv.join("\n")).not.toContain(secret);
      expect([...ctx.out, ...ctx.err].join("\n")).not.toContain(secret);
    }
    expect(ctx.out).toContain(
      `  Variables: DATABASE_URL, STRIPE_SECRET_KEY (secret), SENTRY_DSN set from this terminal and ${envFile}`,
    );
  });

  test("a declared reserved name is skipped with a note and never passed", async () => {
    writeDeclaration(repo, '[environment]\n[[environment.variables]]\nname = "PATH"\n[[environment.variables]]\nname = "DEMO"\n');
    ctx.env = { ...ctx.env, DEMO: "1" };
    const { docker, rec } = recordingPort();
    expect(await shell([], docker, { isTty: () => false })).toBe(0);
    expect(ctx.out).toContain("  Note: env shell sets PATH itself, so the declared value is not used.");
    expect(ctx.out).toContain("  Toolchain: none declared");
    expect(ctx.out).toContain("  Variables: DEMO set from this terminal");
    const argv = rec.runs[0]!.argv;
    expect(argv).not.toContain("-t");
    expect(argv).not.toContain("PATH");
    expect(argv).toContain("DEMO");
  });

  test("Linux with uid 1000 prints the uid note once; darwin and uid 10001 do not", async () => {
    const note = "Note: the shell runs as uid 10001, as Catalyst's agents do. Files here belong to uid 1000, so on Docker Engine for Linux the shell may not be able to write them.";
    expect(await shell([], recordingPort().docker, { platform: "linux", uid: 1000 })).toBe(0);
    expect(ctx.out.filter((line) => line === note)).toHaveLength(1);
    for (const over of [{ platform: "darwin" as const, uid: 1000 }, { platform: "linux" as const, uid: 10001 }]) {
      ctx.out.length = 0;
      expect(await shell([], recordingPort().docker, over)).toBe(0);
      expect(ctx.out.some((line) => line.startsWith("Note: the shell runs as uid"))).toBe(false);
    }
  });

  test("--root defaults to the checkout's top level when run from a subdirectory", async () => {
    const { docker, rec } = recordingPort();
    const asked: string[] = [];
    const code = await main(["env", "shell"], ctx, deps(docker, {
      gitTopLevel: async (cwd) => {
        asked.push(cwd);
        return repo;
      },
    }));
    expect(code).toBe(0);
    expect(asked).toEqual([process.cwd()]);
    expect(rec.runs[0]!.argv).toContain(`type=bind,src=${repo},dst=/workspace`);
  });

  test("real git: run from a subdirectory with no --root, the checkout's top level is mounted", async () => {
    const git = (args: string[]) => spawnSync("git", args, { cwd: repo, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    expect(git(["init", "-q"]).status).toBe(0);
    mkdirSync(join(repo, "packages", "app"), { recursive: true });
    const { docker, rec } = recordingPort();
    const cwd = process.cwd();
    process.chdir(join(repo, "packages", "app"));
    try {
      expect(await main(["env", "shell"], ctx, { env: { shell: { ...deps(docker).env.shell, gitTopLevel: undefined } } })).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(rec.runs[0]!.argv).toContain(`type=bind,src=${repo},dst=/workspace`);
  });

  test("a worktree's git common dir outside the root is mounted; one inside is not", async () => {
    const common = realpathSync(mkdtempSync(join(tmpdir(), "catalyst-env-common-")));
    try {
      const outside = recordingPort();
      expect(await shell([], outside.docker, { gitCommonDir: async () => common })).toBe(0);
      expect(outside.rec.runs[0]!.argv).toContain(`type=bind,src=${common},dst=${common}`);
      const inside = recordingPort();
      mkdirSync(join(repo, ".git"));
      expect(await shell([], inside.docker, { gitCommonDir: async () => join(repo, ".git") })).toBe(0);
      expect(inside.rec.runs[0]!.argv.filter((word) => word === "--mount")).toHaveLength(2);
    } finally {
      rmSync(common, { recursive: true, force: true });
    }
  });
});

describe("signed in, credential fallback", () => {
  let server: FixtureServer;
  const DIGEST = "5e".repeat(32);
  const REF = `registry.catalystcloud.dev/tenant-3/env-web-1a2b3c4d@sha256:${DIGEST}`;
  const PASSWORD = "ctcpull_SECRETVALUE123";
  beforeAll(async () => {
    server = await startMeFixture();
  });
  afterAll(async () => {
    await server.close();
  });

  test("a refused credential-free download asks the contract's route and pulls once with the issued credential", async () => {
    server.writes.length = 0;
    const contract = buildFixtureContract();
    server.contract = {
      ...contract,
      routes: [
        ...contract.routes,
        { method: "POST", path: `${FIXTURE_ROUTE_PREFIX}/registry/pull-credential`, takesWriteBudgetUnit: false, since: "1.0.0" },
      ],
    };
    server.pullCredential = {
      status: 200,
      body: {
        issued: true,
        username: "x-catalyst-pull",
        password: PASSWORD,
        repository: "tenant-3/env-web-1a2b3c4d",
        registry: "registry.catalystcloud.dev",
        expiresAtMs: Date.now() + 3_540_000 + 30_000,
      },
    };
    await seedJoined(home, server);
    const { docker, rec } = recordingPort({
      present: false,
      pulls: [
        { ok: false, detail: "Error response from daemon: unauthorized: authentication required" },
        { ok: true, detail: "" },
      ],
    });
    expect(await shell(["--check", "--json", "--image", REF], docker)).toBe(0);
    expect(JSON.parse(ctx.out[0]!).image).toEqual({ reference: REF, source: "downloaded", credential: "issued" });
    expect(server.writes.map((w) => [w.path, w.body])).toEqual([
      [`${FIXTURE_ROUTE_PREFIX}/registry/pull-credential`, { owner: "oakmont-labs", name: "web" }],
    ]);
    expect(rec.pulls.map((p) => p.config)).toEqual([
      { auths: { "https://index.docker.io/v1/": {} } },
      { auths: { "registry.catalystcloud.dev": { auth: Buffer.from(`x-catalyst-pull:${PASSWORD}`).toString("base64") } } },
    ]);
    expect(ctx.err).toContain("  Downloading it with a short-lived credential your workspace issued (valid for 59 minutes)…");
    expect([...ctx.out, ...ctx.err].join("\n")).not.toContain(PASSWORD);
    server.pullCredential = undefined;
  });
});

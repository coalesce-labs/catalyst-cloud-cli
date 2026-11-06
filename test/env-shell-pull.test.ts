// env-shell-pull.test.ts — CTC-3550: how `catalyst env shell` downloads an image it does not have.
// Credential-free first; only on a refusal, and only for a signed-in person whose contract serves the
// route, it asks the workspace (the fixture cloud) for a short-lived credential, checks it covers the
// image, and pulls once more with it. Docker is a hand-written fake that records every pull.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  CREDENTIAL_FREE_CONFIG,
  credentialCovers,
  downloadImage,
  parsePullCredential,
  pullCredentialRoute,
  registryOf,
} from "../src/env/shell-pull";
import { spawnEnvShellDocker, type DockerConfigJson, type EnvShellDocker } from "../src/env/shell-docker";
import { RUNNER_HOST_IMAGES } from "../src/onboard-runner";
import { buildFixtureContract, FIXTURE_ROUTE_PREFIX } from "./fixture-contract";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

const DIGEST = "5e".repeat(32);
const REF = `registry.catalystcloud.dev/tenant-3/env-web-1a2b3c4d@sha256:${DIGEST}`;
const HOST = "unix:///var/run/docker.sock";
const ROOT = "/work/checkout";
const PASSWORD = "ctcpull_SECRETVALUE123";
const ROUTE_PATH = `${FIXTURE_ROUTE_PREFIX}/registry/pull-credential`;
const EXPECTED_AUTH = Buffer.from(`x-catalyst-pull:${PASSWORD}`).toString("base64");

interface PullCall {
  ref: string;
  host: string;
  config: DockerConfigJson;
}

function fakeDocker(answers: { ok: boolean; detail: string }[]): { docker: EnvShellDocker; pulls: PullCall[] } {
  const pulls: PullCall[] = [];
  const notUsed = (): never => {
    throw new Error("not used");
  };
  const docker: EnvShellDocker = {
    server: async () => notUsed(),
    endpoint: async () => notUsed(),
    imagePresent: async () => notUsed(),
    run: async () => notUsed(),
    pull: async (ref, host, config) => {
      pulls.push({ ref, host, config: structuredClone(config) });
      const next = answers.shift();
      if (!next) throw new Error(`unexpected pull #${pulls.length} of ${ref}`);
      return next;
    },
  };
  return { docker, pulls };
}

const REFUSED_ANONYMOUSLY = { ok: false, detail: "Error response from daemon: unauthorized: authentication required" };

let server: FixtureServer;
let home: string;
let ctx: TestCtx;
let nowMs: number;
let notes: string[];

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  home = tempHome();
  nowMs = Date.now();
  ctx = makeCtx(home, { now: () => new Date(nowMs) });
  notes = [];
  server.requests.length = 0;
  server.writes.length = 0;
  server.contract = buildFixtureContract();
  server.pullCredential = undefined;
});

function issuedBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issued: true,
    username: "x-catalyst-pull",
    password: PASSWORD,
    repository: "tenant-3/env-web-1a2b3c4d",
    registry: "registry.catalystcloud.dev",
    expiresAtMs: nowMs + 59.5 * 60_000,
    ...over,
  };
}

/** Sign in, with the contract serving the credential route (the default) or not. */
async function signIn(opts: { route?: boolean } = {}): Promise<void> {
  if (opts.route !== false) {
    server.contract = {
      ...server.contract,
      routes: [...server.contract.routes, { method: "POST", path: ROUTE_PATH, takesWriteBudgetUnit: false, since: "1.0.0" }],
    };
  }
  await seedJoined(home, server);
  server.requests.length = 0;
}

function download(
  docker: EnvShellDocker,
  opts: { ref?: string; readRepositoryName?: (root: string) => Promise<string | null> } = {},
) {
  return downloadImage({
    ref: opts.ref ?? REF,
    host: HOST,
    root: ROOT,
    ctx,
    docker,
    notify: (line) => notes.push(line),
    readRepositoryName: opts.readRepositoryName ?? (async () => "oakmont-labs/web"),
  });
}

function refusalOf(result: Awaited<ReturnType<typeof downloadImage>>) {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return result.refusal;
}

describe("downloadImage", () => {
  test("Catalyst's image: one credential-free pull; the cloud is never asked; credential 'none'", async () => {
    const { docker, pulls } = fakeDocker([{ ok: true, detail: "" }]);
    const result = await download(docker, { ref: RUNNER_HOST_IMAGES.runner });
    expect(result).toEqual({ ok: true, credential: "none" });
    expect(pulls).toEqual([
      { ref: RUNNER_HOST_IMAGES.runner, host: HOST, config: { auths: { "https://index.docker.io/v1/": {} } } },
    ]);
    expect(pulls[0]?.config).toEqual(CREDENTIAL_FREE_CONFIG);
    expect(notes).toContain("  Downloading it with no credential (about 2.3 GB, once per image)…");
    expect(notes).toContain("  Downloaded.");
    expect(server.requests).toEqual([]);
  });

  test("credential-free refused + not signed in → image_download_refused naming catalyst login; no request sent", async () => {
    const { docker, pulls } = fakeDocker([REFUSED_ANONYMOUSLY]);
    const refusal = refusalOf(await download(docker));
    expect(refusal.code).toBe("image_download_refused");
    expect(refusal.message).toContain(`Could not download ${REF} with no credential`);
    expect(refusal.message).toContain("catalyst login");
    expect(pulls).toHaveLength(1);
    expect(notes).toContain("  Downloading it with no credential…");
    expect(server.requests).toEqual([]);
    expect(server.writes).toEqual([]);
  });

  test("credential-free refused + signed in + no …/registry/pull-credential POST route → image_download_refused 'does not issue'", async () => {
    await signIn({ route: false });
    const { docker, pulls } = fakeDocker([REFUSED_ANONYMOUSLY]);
    const refusal = refusalOf(await download(docker));
    expect(refusal.code).toBe("image_download_refused");
    expect(refusal.message).toContain("does not issue download credentials");
    expect(pulls).toHaveLength(1);
    expect(server.writes).toEqual([]);
  });

  test("refused + route served: POSTs {owner, name} from the checkout's origin to the CONTRACT's path, not a hard-coded one", async () => {
    await signIn();
    server.pullCredential = { status: 200, body: issuedBody() };
    const roots: string[] = [];
    const { docker } = fakeDocker([REFUSED_ANONYMOUSLY, { ok: true, detail: "" }]);
    await download(docker, {
      readRepositoryName: async (root) => {
        roots.push(root);
        return "oakmont-labs/web";
      },
    });
    expect(roots).toEqual([ROOT]);
    expect(ROUTE_PATH.startsWith("/api/v1/agent/")).toBe(false);
    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]?.method).toBe("POST");
    expect(server.writes[0]?.path).toBe(ROUTE_PATH);
    expect(server.writes[0]?.body).toEqual({ owner: "oakmont-labs", name: "web" });
  });

  test("issued and covering the image: second pull carries {auths:{<registry>:{auth: base64('x-catalyst-pull:ctcpull_…')}}}; credential 'issued'", async () => {
    await signIn();
    server.pullCredential = { status: 200, body: issuedBody() };
    const { docker, pulls } = fakeDocker([REFUSED_ANONYMOUSLY, { ok: true, detail: "" }]);
    const result = await download(docker);
    expect(result).toEqual({ ok: true, credential: "issued" });
    expect(pulls).toHaveLength(2);
    expect(pulls[0]?.config).toEqual(CREDENTIAL_FREE_CONFIG);
    expect(pulls[1]).toEqual({
      ref: REF,
      host: HOST,
      config: { auths: { "registry.catalystcloud.dev": { auth: EXPECTED_AUTH } } },
    });
    expect(notes.some((line) => line.includes("valid for 59 minutes"))).toBe(true);
    expect(notes.at(-1)).toBe("  Downloaded.");
  });

  test("issued for another repository → credential_out_of_scope; the second pull never runs", async () => {
    await signIn();
    server.pullCredential = { status: 200, body: issuedBody({ repository: "tenant-3/env-other-00000000" }) };
    const { docker, pulls } = fakeDocker([REFUSED_ANONYMOUSLY]);
    const refusal = refusalOf(await download(docker));
    expect(refusal.code).toBe("credential_out_of_scope");
    expect(refusal.message).toContain("registry.catalystcloud.dev/tenant-3/env-other-00000000");
    expect(refusal.message).toContain("does not cover");
    expect(refusal.message).toContain("Nothing was sent to registry.catalystcloud.dev");
    expect(pulls).toHaveLength(1);
  });

  test("each refusal literal maps to its sentence", async () => {
    await signIn();
    const cases: [string, string][] = [
      ["disabled", "download credentials are not turned on for your workspace."],
      ["not_configured", "download credentials are not turned on for your workspace."],
      ["unknown_repository", "oakmont-labs/web is not a repository in your workspace."],
      ["expired", "the request was refused."],
      ["invalid_checkout", "the request was refused."],
    ];
    for (const [literal, sentence] of cases) {
      server.pullCredential = { status: 200, body: { issued: false, refusal: literal } };
      const { docker, pulls } = fakeDocker([REFUSED_ANONYMOUSLY]);
      const refusal = refusalOf(await download(docker));
      expect(refusal.code, literal).toBe("credential_refused");
      expect(refusal.message, literal).toBe(`Your workspace did not issue a download credential for ${REF}: ${sentence}`);
      expect(pulls, literal).toHaveLength(1);
    }
  });

  test("a malformed answer (missing password, wrong username, expiresAtMs in the past, non-https-host registry) → 'the answer was not understood'", async () => {
    await signIn();
    const { password: _omit, ...withoutPassword } = issuedBody();
    server.pullCredential = { status: 200, body: withoutPassword };
    const { docker, pulls } = fakeDocker([REFUSED_ANONYMOUSLY]);
    const refusal = refusalOf(await download(docker));
    expect(refusal.code).toBe("credential_refused");
    expect(refusal.message).toBe(`Your workspace did not issue a download credential for ${REF}: the answer was not understood.`);
    expect(pulls).toHaveLength(1);

    expect(parsePullCredential(issuedBody(), nowMs).kind).toBe("issued");
    expect(parsePullCredential(withoutPassword, nowMs)).toEqual({ kind: "invalid" });
    expect(parsePullCredential(issuedBody({ username: "AWS" }), nowMs)).toEqual({ kind: "invalid" });
    expect(parsePullCredential(issuedBody({ expiresAtMs: nowMs - 1 }), nowMs)).toEqual({ kind: "invalid" });
    expect(parsePullCredential(issuedBody({ expiresAtMs: nowMs }), nowMs)).toEqual({ kind: "invalid" });
    expect(parsePullCredential(issuedBody({ registry: "https://registry.catalystcloud.dev" }), nowMs)).toEqual({
      kind: "invalid",
    });
    expect(parsePullCredential({ issued: false }, nowMs)).toEqual({ kind: "invalid" });
    expect(parsePullCredential(null, nowMs)).toEqual({ kind: "invalid" });
    expect(parsePullCredential([issuedBody()], nowMs)).toEqual({ kind: "invalid" });
  });

  test("a non-200 answer → 'the request was refused'", async () => {
    await signIn();
    server.pullCredential = { status: 500, body: { error: "internal" } };
    const { docker, pulls } = fakeDocker([REFUSED_ANONYMOUSLY]);
    const refusal = refusalOf(await download(docker));
    expect(refusal.code).toBe("credential_refused");
    expect(refusal.message).toBe(`Your workspace did not issue a download credential for ${REF}: the request was refused.`);
    expect(pulls).toHaveLength(1);
    expect(server.writes).toHaveLength(1);
  });

  test("origin is not GitHub → repository_unknown; no request sent", async () => {
    await signIn();
    server.pullCredential = { status: 200, body: issuedBody() };
    for (const name of [null, "gitlab-group/sub/repo"]) {
      const { docker, pulls } = fakeDocker([REFUSED_ANONYMOUSLY]);
      const refusal = refusalOf(await download(docker, { readRepositoryName: async () => name }));
      expect(refusal.code, String(name)).toBe("repository_unknown");
      expect(refusal.message, String(name)).toContain("not a GitHub repository");
      expect(pulls, String(name)).toHaveLength(1);
    }
    expect(server.writes).toEqual([]);
  });

  test("the password never appears in any notify line or refusal, even when Docker's error echoes it", async () => {
    await signIn();
    server.pullCredential = { status: 200, body: issuedBody() };
    const { docker, pulls } = fakeDocker([
      REFUSED_ANONYMOUSLY,
      { ok: false, detail: `unauthorized: ${PASSWORD} rejected` },
    ]);
    const refusal = refusalOf(await download(docker));
    expect(pulls).toHaveLength(2);
    expect(refusal.code).toBe("image_download_refused");
    expect(refusal.message).toContain("[redacted]");
    expect(refusal.message).not.toContain(PASSWORD);
    expect(JSON.stringify(refusal)).not.toContain(PASSWORD);
    expect(JSON.stringify(refusal)).not.toContain(EXPECTED_AUTH);
    expect(notes.length).toBeGreaterThan(0);
    for (const line of notes) {
      expect(line).not.toContain(PASSWORD);
      expect(line).not.toContain(EXPECTED_AUTH);
    }
  });
});

// CTC-6157 — the same refusal, but through the real docker adapter and a scripted `docker`, so Docker's
// error line goes through `lastLine`'s 400-character cut. The in-process fake above returns its detail
// verbatim and never reaches that cut, which is why the redaction test above could not see the leak.
describe("downloadImage with the real docker adapter (CTC-6157)", () => {
  const LEAD = "Error response from daemon: unauthorized: ";

  /** One error line that holds `secret` at index `at`, so the 400-character cut falls inside it. */
  function straddling(secret: string, at: number): string {
    const line = LEAD + "a".repeat(at - LEAD.length) + secret + " rejected";
    expect(line.indexOf(secret)).toBe(at);
    expect(at + secret.length).toBeGreaterThan(400);
    return line;
  }

  /** `secret` with `gap` after its first half, as Docker might echo it. */
  function broken(secret: string, gap: string): string {
    const at = Math.floor(secret.length / 2);
    return secret.slice(0, at) + gap + secret.slice(at);
  }

  /** No fragment of either secret: not its first 4 characters, and not its last 4 either. None of these
   *  four strings occurs in the refusal's own text (REF, the lead, the notes), so any hit is a credential. */
  function expectNoSecretFragment(text: string) {
    expect(text).not.toContain(PASSWORD.slice(0, 4)); // "ctcp"
    expect(text).not.toContain(PASSWORD.slice(-4)); // "E123"
    expect(text).not.toContain(EXPECTED_AUTH.slice(0, 4)); // "eC1j"
    expect(text).not.toContain(EXPECTED_AUTH.slice(-4)); // "MjM="
  }

  /** The real adapter over a `docker` that prints $FAKE_PULL_ERR to stderr and exits 1. Its env is
   *  PATH and HOME only: never a copy of process.env. */
  function scriptedDocker(pullError: string): EnvShellDocker {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' "$FAKE_PULL_ERR" >&2\nexit 1\n`);
    chmodSync(join(bin, "docker"), 0o755);
    return spawnEnvShellDocker({
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, FAKE_PULL_ERR: pullError },
      tmpdir: () => home,
    });
  }

  test.each([
    ["password at 390", PASSWORD, 390],
    ["auth at 390", EXPECTED_AUTH, 390],
    ["auth at 370", EXPECTED_AUTH, 370],
  ] as const)(
    "Docker echoes the credential across the 400-character cut (%s) → the refusal holds no fragment of it",
    async (_name, secret, at) => {
      const docker = scriptedDocker(`progress line\n${straddling(secret, at)}`);
      await signIn();
      server.pullCredential = { status: 200, body: issuedBody() };
      const refusal = refusalOf(await download(docker));
      expect(refusal.code).toBe("image_download_refused");
      expectNoSecretFragment(refusal.message);
      expectNoSecretFragment(JSON.stringify(refusal));
      expect(
        refusal.message.startsWith(`Could not download ${REF} with the credential your workspace issued: ${LEAD}`),
      ).toBe(true);
      expect(refusal.message).toContain("[redacted]");
      expect(refusal.message.endsWith(".")).toBe(true);
      expect(notes.length).toBeGreaterThan(0);
      for (const line of notes) expectNoSecretFragment(line);
    },
  );

  test.each([
    ["a CRLF in the password", PASSWORD, "\r\n"],
    ["a line feed in the auth value", EXPECTED_AUTH, "\n"],
  ] as const)(
    "Docker breaks the credential up with %s → the refusal holds none of it",
    async (_name, secret, gap) => {
      const docker = scriptedDocker(`progress line\n${LEAD}${broken(secret, gap)} rejected`);
      await signIn();
      server.pullCredential = { status: 200, body: issuedBody() };
      const refusal = refusalOf(await download(docker));
      expect(refusal.code).toBe("image_download_refused");
      expectNoSecretFragment(refusal.message);
      expectNoSecretFragment(JSON.stringify(refusal));
      expect(notes.length).toBeGreaterThan(0);
      for (const line of notes) expectNoSecretFragment(line);
      expect(refusal.message).toBe(
        `Could not download ${REF} with the credential your workspace issued: ${LEAD}[redacted] rejected.`,
      );
    },
  );

  const WITHHELD = [
    ["an ANSI colour sequence", "\x1b[31m"],
    ["an OSC ended by BEL", "\x1b]0;title\x07"],
    ["an OSC ended by ST", "\x1b]0;title\x1b\\"],
    ["an unterminated OSC", "\x1b]0;title"],
    ["a DCS ended by ST", "\x1bPq\x1b\\"],
    ["a charset designation", "\x1b(B"],
    ["an 8-bit CSI", "\x9b31m"],
    ["an 8-bit OSC ended by 0x9C", "\x9d0;title\x9c"],
  ] as const;

  test.each(
    WITHHELD.flatMap(([name, gap]) =>
      ([PASSWORD, EXPECTED_AUTH] as const).flatMap((secret) =>
        ([0, 395 - LEAD.length] as const).map((pad) => [name, secret, gap, pad] as const),
      ),
    ),
  )(
    "CTC-6157: Docker breaks the credential up with %s (secret %#, pad before it %#) → the detail is withheld",
    async (_name, secret, gap, pad) => {
      const docker = scriptedDocker(`progress line\n${LEAD}${"a".repeat(pad)}${broken(secret, gap)} rejected`);
      await signIn();
      server.pullCredential = { status: 200, body: issuedBody() };
      const refusal = refusalOf(await download(docker));
      expect(refusal.code).toBe("image_download_refused");
      expectNoSecretFragment(JSON.stringify(refusal));
      for (const line of notes) expectNoSecretFragment(line);
      expect(refusal.message).toBe(
        `Could not download ${REF} with the credential your workspace issued: docker pull failed.`,
      );
    },
  );

  test("CTC-6157: a low-entropy password and a coloured error that only mentions the word → withheld, not half-redacted", async () => {
    const docker = scriptedDocker("\x1b[31mwrong password for user\x1b[0m");
    await signIn();
    server.pullCredential = { status: 200, body: issuedBody({ password: "password123" }) };
    const refusal = refusalOf(await download(docker));
    expect(refusal.message).toBe(
      `Could not download ${REF} with the credential your workspace issued: docker pull failed.`,
    );
    expect(refusal.message).not.toContain("[redacted]");
  });

  test("CTC-6157: the same password and an escape-free error that mentions the word → shown as it is", async () => {
    const docker = scriptedDocker("wrong password for user");
    await signIn();
    server.pullCredential = { status: 200, body: issuedBody({ password: "password123" }) };
    const refusal = refusalOf(await download(docker));
    expect(refusal.message).toBe(
      `Could not download ${REF} with the credential your workspace issued: wrong password for user.`,
    );
  });
});

describe("registryOf / credentialCovers", () => {
  const digest = `@sha256:${DIGEST}`;
  const credential = { registry: "registry.catalystcloud.dev", repository: "tenant-3/env-web-1a2b3c4d" };

  test("ghcr.io/coalesce-labs/catalyst-runner@sha256:… → ghcr.io; docker.io default for a bare name", () => {
    expect(registryOf(`ghcr.io/coalesce-labs/catalyst-runner${digest}`)).toBe("ghcr.io");
    expect(registryOf(REF)).toBe("registry.catalystcloud.dev");
    expect(registryOf(`localhost:5000/x${digest}`)).toBe("localhost:5000");
    expect(registryOf(`localhost/x${digest}`)).toBe("localhost");
    expect(registryOf(`library/node${digest}`)).toBe("docker.io");
    expect(registryOf(`node${digest}`)).toBe("docker.io");
  });

  test("covers only <registry>/<repository>[:tag]@sha256:…, never a prefix-sharing sibling (…/env-web-1a2b3c4d-evil)", () => {
    expect(credentialCovers(REF, credential)).toBe(true);
    expect(credentialCovers(`registry.catalystcloud.dev/tenant-3/env-web-1a2b3c4d:v1${digest}`, credential)).toBe(true);
    expect(credentialCovers(`registry.catalystcloud.dev/tenant-3/env-web-1a2b3c4d-evil${digest}`, credential)).toBe(false);
    expect(credentialCovers(`registry.catalystcloud.dev/tenant-3/env-web-1a2b3c4d/sub${digest}`, credential)).toBe(false);
    expect(credentialCovers("registry.catalystcloud.dev/tenant-3/env-web-1a2b3c4d:v1", credential)).toBe(false);
    expect(credentialCovers("registry.catalystcloud.dev/tenant-3/env-web-1a2b3c4d", credential)).toBe(false);
    expect(credentialCovers(`other-registry.example.com/tenant-3/env-web-1a2b3c4d${digest}`, credential)).toBe(false);
  });

  test("pullCredentialRoute picks only POST routes ending /registry/pull-credential", () => {
    const base = buildFixtureContract();
    const route = (method: "GET" | "POST", path: string) => ({ method, path, takesWriteBudgetUnit: false, since: "1.0.0" });
    expect(pullCredentialRoute(base)).toBeNull();
    expect(pullCredentialRoute({ ...base, routes: [...base.routes, route("GET", ROUTE_PATH)] })).toBeNull();
    expect(
      pullCredentialRoute({ ...base, routes: [...base.routes, route("POST", `${ROUTE_PATH}-extra`)] }),
    ).toBeNull();
    expect(pullCredentialRoute({ ...base, routes: [...base.routes, route("GET", ROUTE_PATH), route("POST", ROUTE_PATH)] })).toBe(
      ROUTE_PATH,
    );
  });
});

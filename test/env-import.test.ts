// env-import.test.ts — the acceptance for "the values go to the vault in the same run", and the
// `catalyst env import` verb. Requests go to a recording client; the repositories list is injected.
// Every leak assertion is paired with a positive control: the sentinel reached a request body.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { parseEnvAssignments } from "../src/env/parse-env.js";
import type { EnvImportDeps } from "../src/env-import.js";
import { lineSafe, looksLikeCredential } from "../src/env-import.js";
import type { ApiClient, JsonResponse } from "../src/transport";
import { ALL_NAMES, DIRENV_GITHUB_TOKEN, PLAIN_NAMES, SENTINEL, TOKEN_NAMES, valueFor, writeMachine } from "./env-machine-fixture.js";
import { FIXTURE_USER_KEY, startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome } from "./helpers";

const FIXTURE_LINE_RE = /^\s*(?:export\s+)?([^=#\s]+)\s*=(.*)$/;

interface Recorded { path: string; body: Record<string, unknown> }

function recordingClient(options: {
  secretsStatus?: number;
  existing?: string[];
  errors?: Array<{ name: string; reason: string }>;
  varUpdated?: string[];
  varRefused?: Record<string, number>;
  throwOn?: string;
} = {}) {
  const writes: Recorded[] = [];
  const answer = (path: string, body: Record<string, unknown>): { status: number; body: unknown } => {
    if (path === "/me/env-vars" && body.name === options.throwOn) throw new Error("socket hang up");
    writes.push({ path, body });
    if (path === "/me/secrets/import") {
      if (options.secretsStatus !== undefined && options.secretsStatus !== 200) {
        return { status: options.secretsStatus, body: { error: "forbidden", message: "managing the organization's secrets requires an admin or owner role" } };
      }
      const names = String(body.text).split("\n").filter(Boolean).map((line) => line.slice(0, line.indexOf("=")));
      const existing = new Set(options.existing ?? []);
      return {
        status: 200,
        body: {
          created: names.filter((name) => !existing.has(name)),
          rotated: [],
          errors: [...names.filter((name) => existing.has(name)).map((name) => ({ name, reason: "name_exists" })), ...(options.errors ?? [])],
        },
      };
    }
    const refused = options.varRefused?.[String(body.name)];
    if (refused !== undefined) return { status: refused, body: { error: "invalid_value", message: "the value was refused" } };
    return { status: 201, body: { created: !(options.varUpdated ?? []).includes(String(body.name)) } };
  };
  const client: Pick<ApiClient, "postJson"> = {
    postJson: async <T,>(path: string, body: unknown): Promise<JsonResponse<T>> => {
      const reply = answer(path, isRecord(body) ? body : {});
      // The route's reply type is the caller's to name; this fake answers each route's documented shape.
      return { status: reply.status, body: reply.body as T, headers: new Headers() };
    },
  };
  return { client, writes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REPOS = async () => [{ repoId: "repo_1", owner: "acme", name: "app" }];

function importDeps(client: Pick<ApiClient, "postJson">, over: Partial<EnvImportDeps> = {}): EnvImportDeps {
  return { client, repositories: REPOS, repoName: async () => "acme/app", isTty: () => false, ...over };
}

function writeSettings(root: string, toml: string): void {
  mkdirSync(join(root, ".catalyst"), { recursive: true });
  writeFileSync(join(root, ".catalyst/catalyst.toml"), toml);
}

function settingsFor(variables: Array<{ name: string; secret?: boolean }>): string {
  return `[environment]\n${variables.map(({ name, secret }) => `[[environment.variables]]\nname = "${name}"\n${secret ? "secret = true\n" : ""}required = false\n`).join("\n")}`;
}

describe("env import", () => {
  let server: FixtureServer;
  beforeAll(async () => { server = await startMeFixture(); });
  afterAll(async () => { await server.close(); });

  async function signedIn(home: string, contract = false): Promise<void> {
    await seedJoined(home, server, { contract, config: { key: FIXTURE_USER_KEY } });
  }

  describe("Scenario: the values go to the vault in the same run", () => {
    it("env draft --write --import-values: the 44 values are stored — one POST /me/secrets/import with the 13 secret lines {repo:'acme/app', rotateExisting:[], source:'env import: .envrc, direnv environment'} and 31 POST /me/env-vars {scope:'repo', repoId:'repo_1', name, value}", async () => {
      const { root, home } = writeMachine();
      await signedIn(home);
      const ctx = makeCtx(home, { env: { DIRENV_DIR: `-${root}`, GITHUB_TOKEN: DIRENV_GITHUB_TOKEN } });
      const { client, writes } = recordingClient();
      expect(await main(["env", "draft", "--root", root, "--write", "--import-values"], ctx, { env: { import: importDeps(client) } })).toBe(0);

      const secretsCall = writes.filter(({ path }) => path === "/me/secrets/import");
      expect(secretsCall).toHaveLength(1);
      const { text, ...rest } = secretsCall[0]!.body;
      expect(rest).toEqual({ repo: "acme/app", rotateExisting: [], source: "env import: .envrc, direnv environment" });
      const lines = String(text).split("\n").filter(Boolean);
      expect(lines.map((line) => line.slice(0, line.indexOf("=")))).toEqual(TOKEN_NAMES);
      expect(lines).toContain(`GITHUB_TOKEN=${DIRENV_GITHUB_TOKEN}`);

      const varCalls = writes.filter(({ path }) => path === "/me/env-vars");
      expect(varCalls.map(({ body }) => body)).toEqual(PLAIN_NAMES.map((name) => ({ scope: "repo", repoId: "repo_1", name, value: valueFor(name) })));

      const bodies = JSON.stringify(writes);
      for (const name of ALL_NAMES.filter((n) => n !== "GITHUB_TOKEN")) expect(bodies).toContain(valueFor(name));
      expect(bodies).toContain(DIRENV_GITHUB_TOKEN);
      const printed = [...ctx.out, ...ctx.err].join("\n");
      expect(printed).not.toContain(SENTINEL);
      expect(printed).toContain("This computer has values for 44 of the 44 declared names (.envrc and its direnv environment).");
      expect(printed).toContain("Stored 44 values for acme/app: 13 secrets, 31 plain variables.");
      expect(printed).toContain("Every declared name had a value on this computer.");
    });

    it("the output lists each declared name with no value on this computer (GITHUB_TOKEN without direnv, plus a .env.example-only name), with its fix line", async () => {
      const { root, home } = writeMachine();
      writeFileSync(join(root, ".env.example"), "EXAMPLE_ONLY_SETTING=placeholder\n");
      await signedIn(home);
      const ctx = makeCtx(home);
      const { client, writes } = recordingClient();
      expect(await main(["env", "draft", "--root", root, "--write", "--import-values"], ctx, { env: { import: importDeps(client) } })).toBe(0);
      const out = ctx.out.join("\n");
      expect(out).toContain("This computer has values for 43 of the 45 declared names (.envrc).");
      expect(out).toContain("Stored 43 values for acme/app: 12 secrets, 31 plain variables.");
      expect(out).toContain("No value on this computer for 2 declared names (looked in .envrc, its direnv environment and ~/.claude.json):");
      expect(out).toContain("  EXAMPLE_ONLY_SETTING: store it with: catalyst var set EXAMPLE_ONLY_SETTING --repo acme/app");
      expect(out).toContain("  GITHUB_TOKEN: .envrc computes it. Run catalyst env import in a shell where direnv has loaded this repository, or store it with: catalyst secret set GITHUB_TOKEN --repo acme/app");
      expect(JSON.stringify(writes)).not.toContain("GITHUB_TOKEN=");
      expect(out).not.toContain(SENTINEL);
    });

    it("terminal offer: y stores; n, an empty answer, or no terminal stores nothing and prints the `Next: catalyst env import` line", async () => {
      const questions: string[] = [];
      for (const answer of [true, false]) {
        const { root, home } = writeMachine({ claude: null });
        await signedIn(home);
        const ctx = makeCtx(home);
        const { client, writes } = recordingClient();
        const deps = importDeps(client, { isTty: () => true, confirm: async (q) => { questions.push(q); return answer; } });
        expect(await main(["env", "draft", "--root", root, "--write"], ctx, { env: { import: deps } })).toBe(0);
        if (answer) expect(writes.length).toBeGreaterThan(0);
        else {
          expect(writes).toEqual([]);
          expect(ctx.out.join("\n")).toContain("Next: catalyst env import stores this computer's values for these names. It signs in and asks first.");
        }
      }
      expect(questions[0]).toBe("Store them for acme/app now? 12 as secrets, 31 as plain variables. Values go to Catalyst and are never printed. Secrets already stored are kept; plain variables already stored are replaced. [y/N] ");

      const { root, home } = writeMachine({ claude: null });
      await signedIn(home);
      const ctx = makeCtx(home);
      const { client, writes } = recordingClient();
      expect(await main(["env", "draft", "--root", root, "--write"], ctx, { env: { import: importDeps(client, { confirm: async () => { throw new Error("asked without a terminal"); } }) } })).toBe(0);
      expect(writes).toEqual([]);
      expect(ctx.out).toContain("Next: catalyst env import stores this computer's values for these names. It signs in and asks first.");
    });

    it("not signed in: no question, nothing sent, the `sign in with catalyst login` line, and the file is still written", async () => {
      for (const flags of [["--import-values"], []]) {
        const { root, home } = writeMachine({ claude: null });
        const ctx = makeCtx(home);
        const { client, writes } = recordingClient();
        const deps = importDeps(client, { isTty: () => true, confirm: async () => { throw new Error("asked while signed out"); } });
        const code = await main(["env", "draft", "--root", root, "--write", ...flags], ctx, { env: { import: deps } });
        expect(code).toBe(flags.length > 0 ? 1 : 0);
        expect(writes).toEqual([]);
        expect(ctx.out).toContain("To store this computer's values for these names, sign in with catalyst login, then run: catalyst env import");
        expect(readFileSync(join(root, ".catalyst/catalyst.toml"), "utf8")).toContain("PLAIN_SETTING_00");
      }
    });

    it("--import-values without --write is a usage error naming catalyst env import", async () => {
      const { root, home } = writeMachine({ claude: null });
      const ctx = makeCtx(home);
      expect(await main(["env", "draft", "--root", root, "--import-values"], ctx)).toBe(1);
      expect(ctx.err[0]).toBe("--import-values needs --write; for an existing .catalyst/catalyst.toml run: catalyst env import");
    });

    it("--json with --import-values carries the import report in the one JSON object, names only", async () => {
      const { root, home } = writeMachine();
      await signedIn(home);
      const ctx = makeCtx(home);
      const { client } = recordingClient();
      expect(await main(["env", "draft", "--root", root, "--write", "--import-values", "--json"], ctx, { env: { import: importDeps(client) } })).toBe(0);
      expect(ctx.out).toHaveLength(1);
      const body = JSON.parse(ctx.out[0]!) as { written: boolean; import: { state: string; stored: { secrets: string[]; variables: string[] }; noValue: unknown[] } };
      expect(body.written).toBe(true);
      expect(body.import.state).toBe("stored");
      expect(body.import.stored.secrets).toHaveLength(12);
      expect(body.import.stored.variables).toHaveLength(31);
      expect(body.import.noValue).toEqual([{ name: "GITHUB_TOKEN", computed: true }]);
      expect([...ctx.out, ...ctx.err].join("\n")).not.toContain(SENTINEL);

      const plain = writeMachine();
      const plainCtx = makeCtx(plain.home);
      expect(await main(["env", "draft", "--root", plain.root, "--write", "--json"], plainCtx, { env: { import: importDeps(client) } })).toBe(0);
      expect(plainCtx.out).toHaveLength(1);
      expect(plainCtx.err).toContain("Next: catalyst env import stores this computer's values for these names. It signs in and asks first.");
    });

    it("a checkout with no GitHub origin and no --repo names the --repo form instead of storing", async () => {
      const { root, home } = writeMachine({ claude: null });
      await signedIn(home);
      const ctx = makeCtx(home);
      const { client, writes } = recordingClient();
      expect(await main(["env", "draft", "--root", root, "--write", "--import-values"], ctx, { env: { import: importDeps(client, { repoName: async () => null }) } })).toBe(1);
      expect(writes).toEqual([]);
      expect(ctx.out.join("\n")).toContain("run: catalyst env import --repo owner/name");
    });
  });

  describe("catalyst env import", () => {
    it("reads .catalyst/catalyst.toml as the allowlist; its secret flag decides the route", async () => {
      const { root, home } = writeMachine({ envrc: `export PLAIN_TOKEN=${SENTINEL}_a\nexport SECRET_SETTING=${SENTINEL}_b\nexport UNDECLARED=${SENTINEL}_c\n`, claude: null });
      writeSettings(root, settingsFor([{ name: "PLAIN_TOKEN" }, { name: "SECRET_SETTING", secret: true }]));
      await signedIn(home);
      const ctx = makeCtx(home);
      const { client, writes } = recordingClient();
      expect(await main(["env", "import", "--root", root, "--yes"], ctx, { env: { import: importDeps(client) } })).toBe(0);
      expect(writes).toEqual([
        { path: "/me/secrets/import", body: { repo: "acme/app", text: `SECRET_SETTING=${SENTINEL}_b\n`, rotateExisting: [], source: "env import: .envrc" } },
        { path: "/me/env-vars", body: { scope: "repo", repoId: "repo_1", name: "PLAIN_TOKEN", value: `${SENTINEL}_a` } },
      ]);
      expect(ctx.out[0]).toBe("Reading .catalyst/catalyst.toml: 2 declared names (1 secret).");
      // --yes skips the prompt, so each name and its value's source is listed before anything is sent.
      expect(ctx.out).toContain("  PLAIN_TOKEN (plain) from .envrc");
      expect(ctx.out).toContain("  SECRET_SETTING (secret) from .envrc");
      expect(ctx.out.join("\n")).not.toContain(SENTINEL);
    });

    it("needs --yes without a terminal: exit 1, nothing sent, JSON state confirmation_required", async () => {
      const { root, home } = writeMachine({ claude: null });
      writeSettings(root, settingsFor([{ name: "PLAIN_SETTING_00" }]));
      await signedIn(home);
      const { client, writes } = recordingClient();
      const ctx = makeCtx(home);
      expect(await main(["env", "import", "--root", root], ctx, { env: { import: importDeps(client) } })).toBe(1);
      expect(ctx.out).toContain("env import stores values in Catalyst; pass --yes to confirm without a terminal. Nothing was stored.");
      const jsonCtx = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--json"], jsonCtx, { env: { import: importDeps(client) } })).toBe(1);
      expect(JSON.parse(jsonCtx.out[0]!).state).toBe("confirmation_required");
      expect(writes).toEqual([]);
    });

    it("asks in a terminal; a no stores nothing", async () => {
      const { root, home } = writeMachine({ claude: null });
      writeSettings(root, settingsFor([{ name: "PLAIN_SETTING_00" }]));
      await signedIn(home);
      const { client, writes } = recordingClient();
      const ctx = makeCtx(home);
      expect(await main(["env", "import", "--root", root], ctx, { env: { import: importDeps(client, { isTty: () => true, confirm: async () => false }) } })).toBe(0);
      expect(writes).toEqual([]);
      expect(ctx.out.join("\n")).toContain("Nothing was stored.");
    });

    it("--repo overrides the git origin; with neither, a usage error naming --repo", async () => {
      const { root, home } = writeMachine({ claude: null });
      writeSettings(root, settingsFor([{ name: "PLAIN_SETTING_00" }]));
      await signedIn(home);
      const { client, writes } = recordingClient();
      const repos = async () => [{ repoId: "repo_2", owner: "Acme", name: "Other" }];
      const ctx = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes", "--repo", "acme/other"], ctx, { env: { import: importDeps(client, { repositories: repos }) } })).toBe(0);
      expect(writes[0]!.body.repoId).toBe("repo_2");

      const none = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes"], none, { env: { import: importDeps(client, { repoName: async () => null }) } })).toBe(1);
      expect(none.err[0]).toBe("env import needs --repo owner/name: this checkout has no GitHub origin to read it from");

      const bad = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes", "--repo", "not-a-repo"], bad, { env: { import: importDeps(client) } })).toBe(1);
      expect(bad.err[0]).toBe('--repo must be owner/name (got "not-a-repo")');
    });

    it("a repo not in the workspace's contract: exit 1, nothing sent", async () => {
      const { root, home } = writeMachine({ claude: null });
      writeSettings(root, settingsFor([{ name: "PLAIN_SETTING_00" }]));
      await signedIn(home);
      const { client, writes } = recordingClient();
      const ctx = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes", "--repo", "acme/unknown"], ctx, { env: { import: importDeps(client) } })).toBe(1);
      expect(writes).toEqual([]);
      expect(ctx.out).toContain("acme/unknown is not a repository of this workspace; nothing was stored. Register it first with catalyst onboard --team <KEY> --repo acme/unknown");
    });

    it("reads the repositories from the workspace contract by default", async () => {
      const { root, home } = writeMachine({ envrc: "export PUBLIC_URL=https://example.invalid\n", claude: null });
      writeSettings(root, settingsFor([{ name: "PUBLIC_URL" }]));
      await signedIn(home, true);
      const { client, writes } = recordingClient();
      const ctx = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes", "--repo", "hagale/api"], ctx, { env: { import: { client, isTty: () => false } } })).toBe(0);
      expect(writes).toEqual([{ path: "/me/env-vars", body: { scope: "repo", repoId: "repo-api", name: "PUBLIC_URL", value: "https://example.invalid" } }]);
    });

    it("name_exists → kept with the `catalyst secret set` fix; other errors[].reason → notStored with the secret.ts reason text; exit 1 only for notStored", async () => {
      const { root, home } = writeMachine({ claude: null });
      writeSettings(root, settingsFor([{ name: "NPM_TOKEN", secret: true }, { name: "VERCEL_TOKEN", secret: true }]));
      await signedIn(home);
      const kept = recordingClient({ existing: ["NPM_TOKEN"] });
      const ctx = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes"], ctx, { env: { import: importDeps(kept.client) } })).toBe(0);
      expect(ctx.out).toContain("Stored 1 values for acme/app: 1 secrets, 0 plain variables.");
      expect(ctx.out).toContain("Kept 1 secrets already stored for acme/app: NPM_TOKEN (replace one with: catalyst secret set NAME --repo acme/app)");

      const refused = recordingClient({ existing: ["NPM_TOKEN", "VERCEL_TOKEN"], errors: [{ name: "OTHER", reason: "name_taken_by_env_var" }] });
      const refusedCtx = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes"], refusedCtx, { env: { import: importDeps(refused.client) } })).toBe(1);
      expect(refusedCtx.out).toContain("Stored nothing for acme/app.");
      expect(refusedCtx.out).toContain("Not stored: OTHER (already a plain environment variable; a name is a secret or a variable, never both)");
    });

    it("plain variable created:false → listed as updated", async () => {
      const { root, home } = writeMachine({ claude: null });
      writeSettings(root, settingsFor([{ name: "PLAIN_SETTING_00" }, { name: "PLAIN_SETTING_01" }]));
      await signedIn(home);
      const { client } = recordingClient({ varUpdated: ["PLAIN_SETTING_01"] });
      const ctx = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes"], ctx, { env: { import: importDeps(client) } })).toBe(0);
      expect(ctx.out).toContain("Stored 2 values for acme/app: 0 secrets, 2 plain variables.");
      expect(ctx.out).toContain("  updated (were already stored): PLAIN_SETTING_01");
    });

    it("a plain-declared value that looks like a credential (ghp_, github_pat_, glpat-, sk-, sk_live_, xox?-, AKIA…, eyJ….….…, -----BEGIN, scheme://user:pass@) is not sent and is listed", async () => {
      const shapes = [
        "ghp_abcdefghijklmnopqrstuvwxyz0123", "github_pat_11ABCDEFG", "glpat-abcdefghij", "sk-abcdefghijklmnop", "sk_live_abc123",
        "xoxb-1234-5678", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", "-----BEGIN", "postgres://user:pass@db.example.com/app",
      ];
      for (const shape of shapes) expect(looksLikeCredential(shape), shape).toBe(true);
      for (const plain of ["https://example.invalid", "production", "sk-1", "postgres://db.example.com/app"]) expect(looksLikeCredential(plain), plain).toBe(false);

      const { root, home } = writeMachine({ envrc: "export SENTRY_DSN=postgres://user:pass@db.example.com/app\nexport REGION=us-east-1\n", claude: null });
      writeSettings(root, settingsFor([{ name: "SENTRY_DSN" }, { name: "REGION" }]));
      await signedIn(home);
      const { client, writes } = recordingClient();
      const ctx = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes"], ctx, { env: { import: importDeps(client) } })).toBe(1);
      expect(writes.map(({ body }) => body.name)).toEqual(["REGION"]);
      expect(ctx.out).toContain("Not stored: SENTRY_DSN (its value looks like a credential, but the file declares it plain; set secret = true for it and run catalyst env import again)");
      expect(ctx.out.join("\n")).not.toContain("user:pass");
    });

    it("a secret value with a line break, edge spaces, a leading quote or ' #' is not sent and is listed with the secret set fix", async () => {
      for (const bad of ["a\nb", " lead", "trail ", "'quoted", '"quoted', "has #hash", "cr\r"]) expect(lineSafe(bad), JSON.stringify(bad)).toBe(false);
      expect(lineSafe("fine#value")).toBe(true);
      const { root, home } = writeMachine({ envrc: null, claude: null });
      writeSettings(root, settingsFor([{ name: "BAD_TOKEN", secret: true }, { name: "GOOD_TOKEN", secret: true }]));
      await signedIn(home);
      const { client, writes } = recordingClient();
      const ctx = makeCtx(home, { env: { DIRENV_DIR: `-${root}`, BAD_TOKEN: `${SENTINEL} #x`, GOOD_TOKEN: `${SENTINEL}_good` } });
      writeFileSync(join(root, ".envrc"), "export BAD_TOKEN=\"$(cmd)\"\nexport GOOD_TOKEN=\"$(cmd)\"\n");
      expect(await main(["env", "import", "--root", root, "--yes"], ctx, { env: { import: importDeps(client) } })).toBe(1);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.body.text).toBe(`GOOD_TOKEN=${SENTINEL}_good\n`);
      expect(ctx.out.join("\n")).toContain("Not stored: BAD_TOKEN (its value has a line break, spaces at either end, a leading quote or \" #\", which an import line cannot carry; store it with: catalyst secret set BAD_TOKEN --repo acme/app)");
      expect(ctx.out.join("\n")).not.toContain(SENTINEL);
    });

    it("each secret line sent parses back to the same value under both parse-env.ts's parseEnvAssignments and the fixture cloud's regex", async () => {
      const { root, home } = writeMachine({ claude: null });
      writeSettings(root, settingsFor(TOKEN_NAMES.map((name) => ({ name, secret: true }))));
      await signedIn(home);
      const { client, writes } = recordingClient();
      const env = { DIRENV_DIR: `-${root}`, GITHUB_TOKEN: "a=b'c\"d e#f" };
      expect(await main(["env", "import", "--root", root, "--yes"], makeCtx(home, { env }), { env: { import: importDeps(client) } })).toBe(0);
      const text = String(writes[0]!.body.text);
      const expected = new Map(TOKEN_NAMES.map((name) => [name, name === "GITHUB_TOKEN" ? env.GITHUB_TOKEN : valueFor(name)]));
      expect(new Map(parseEnvAssignments(text).map(({ name, value }) => [name, value]))).toEqual(expected);
      const viaFixture = new Map(text.split("\n").flatMap((line) => {
        const m = FIXTURE_LINE_RE.exec(line);
        return m ? [[m[1]!, m[2]!.trim()] as const] : [];
      }));
      expect(viaFixture).toEqual(expected);
    });

    it("a secret-import refusal (non-200) stops before any variable write and prints secret.ts's refusal line", async () => {
      const { root, home } = writeMachine({ claude: null });
      writeSettings(root, settingsFor([{ name: "NPM_TOKEN", secret: true }, { name: "PLAIN_SETTING_00" }]));
      await signedIn(home);
      const { client, writes } = recordingClient({ secretsStatus: 403 });
      const ctx = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes"], ctx, { env: { import: importDeps(client) } })).toBe(1);
      expect(writes.map(({ path }) => path)).toEqual(["/me/secrets/import"]);
      expect(ctx.out).toContain("refused (403): managing the organization's secrets requires an admin or owner role");
    });

    it("a refused plain write is listed as not stored with the cloud's reason", async () => {
      const { root, home } = writeMachine({ claude: null });
      writeSettings(root, settingsFor([{ name: "PLAIN_SETTING_00" }, { name: "PLAIN_SETTING_01" }]));
      await signedIn(home);
      const { client } = recordingClient({ varRefused: { PLAIN_SETTING_00: 422 } });
      const ctx = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes"], ctx, { env: { import: importDeps(client) } })).toBe(1);
      expect(ctx.out).toContain("Not stored: PLAIN_SETTING_00 (the value was refused)");
      expect(ctx.out).toContain("Stored 1 values for acme/app: 0 secrets, 1 plain variables.");
    });

    it("a thrown variable write stops: written names reported, the rest listed as unknown, exit 1", async () => {
      const { root, home } = writeMachine({ claude: null });
      writeSettings(root, settingsFor(["PLAIN_SETTING_00", "PLAIN_SETTING_01", "PLAIN_SETTING_02"].map((name) => ({ name }))));
      await signedIn(home);
      const { client, writes } = recordingClient({ throwOn: "PLAIN_SETTING_01" });
      const ctx = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes", "--json"], ctx, { env: { import: importDeps(client) } })).toBe(1);
      expect(writes.map(({ body }) => body.name)).toEqual(["PLAIN_SETTING_00"]);
      const report = JSON.parse(ctx.out[0]!) as { stored: { variables: string[] }; unknown: string[] };
      expect(report.stored.variables).toEqual(["PLAIN_SETTING_00"]);
      expect(report.unknown).toEqual(["PLAIN_SETTING_01", "PLAIN_SETTING_02"]);
      const human = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes"], human, { env: { import: importDeps(recordingClient({ throwOn: "PLAIN_SETTING_00" }).client) } })).toBe(1);
      expect(human.out).toContain("Stopped: the write did not answer, so these are not confirmed: PLAIN_SETTING_00, PLAIN_SETTING_01, PLAIN_SETTING_02. Run catalyst env import again.");
    });

    it("--json carries names only: no sentinel anywhere in the JSON", async () => {
      const { root, home } = writeMachine();
      writeSettings(root, settingsFor(ALL_NAMES.map((name) => ({ name, secret: TOKEN_NAMES.includes(name) }))));
      await signedIn(home);
      const { client, writes } = recordingClient();
      const ctx = makeCtx(home, { env: { DIRENV_DIR: `-${root}`, GITHUB_TOKEN: DIRENV_GITHUB_TOKEN } });
      expect(await main(["env", "import", "--root", root, "--yes", "--json"], ctx, { env: { import: importDeps(client) } })).toBe(0);
      expect(JSON.stringify(writes)).toContain(DIRENV_GITHUB_TOKEN);
      expect(ctx.out).toHaveLength(1);
      expect(ctx.out[0]).not.toContain(SENTINEL);
      const report = JSON.parse(ctx.out[0]!) as Record<string, unknown>;
      expect(report).toMatchObject({ state: "stored", repo: "acme/app", from: [".envrc", "direnv environment"], updated: [], kept: [], noValue: [], notStored: [] });
    });

    it("missing or invalid .catalyst/catalyst.toml: exit 1 with the env check message, nothing sent", async () => {
      const { root, home } = writeMachine({ claude: null });
      await signedIn(home);
      const { client, writes } = recordingClient();
      const missing = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes"], missing, { env: { import: importDeps(client) } })).toBe(1);
      expect(missing.err).toEqual(["no .catalyst/catalyst.toml found in this repository; draft one with catalyst env draft --write"]);

      writeSettings(root, "[environment]\n[[environment.variables]]\nname = \"BAD NAME\"\n");
      const invalid = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes", "--json"], invalid, { env: { import: importDeps(client) } })).toBe(1);
      expect(JSON.parse(invalid.out[0]!)).toMatchObject({ state: "refused", refusal: ".catalyst/catalyst.toml: environment.variables[0].name is not a valid environment variable name" });

      writeSettings(root, "[project]\nname = \"x\"\n");
      const noTable = makeCtx(home);
      expect(await main(["env", "import", "--root", root, "--yes"], noTable, { env: { import: importDeps(client) } })).toBe(1);
      expect(noTable.err).toEqual(["no [environment] table in .catalyst/catalyst.toml"].map((line) => `.catalyst/catalyst.toml: ${line}`));
      expect(writes).toEqual([]);
    });

    it("not signed in: exit 1, nothing sent", async () => {
      const { root } = writeMachine({ claude: null });
      writeSettings(root, settingsFor([{ name: "PLAIN_SETTING_00" }]));
      const { client, writes } = recordingClient();
      const ctx = makeCtx(tempHome());
      expect(await main(["env", "import", "--root", root, "--yes"], ctx, { env: { import: importDeps(client) } })).toBe(1);
      expect(ctx.err).toEqual(["env import stores values in Catalyst; sign in with catalyst login first. Nothing was stored."]);
      expect(writes).toEqual([]);
    });

    it("no value on this computer for any declared name: nothing is sent and each name is listed", async () => {
      const { root, home } = writeMachine({ envrc: null, claude: null });
      writeSettings(root, settingsFor([{ name: "ABSENT_TOKEN", secret: true }]));
      await signedIn(home);
      const { client, writes } = recordingClient();
      const ctx = makeCtx(home);
      expect(await main(["env", "import", "--root", root], ctx, { env: { import: importDeps(client) } })).toBe(0);
      expect(writes).toEqual([]);
      expect(ctx.out).toContain("This computer has values for 0 of the 1 declared names.");
      expect(ctx.out).toContain("  ABSENT_TOKEN: store it with: catalyst secret set ABSENT_TOKEN --repo acme/app");
    });

    it("takes no positional arguments", async () => {
      const ctx = makeCtx(tempHome());
      expect(await main(["env", "import", "extra"], ctx)).toBe(1);
      expect(ctx.err[0]).toBe("env import takes no positional arguments; use --root DIR");
    });
  });
});

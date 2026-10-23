// secret.test.ts — `catalyst-skills secret set|import` (CTC-3549), against the fixture cloud's repo
// secret store. The fixture keeps each stored value only so a test can assert what landed; every
// test also asserts that no value reached stdout or stderr.
//
// ⛔ Every value here is a placeholder ("placeholder-…"). The `op` in the command scenario is a
// shell script this file writes to a temp dir and puts first on PATH, so the test runs a REAL local
// command through the person's shell, the way the verb does, without a 1Password account.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { runLocalCommand, trimOneNewline } from "../src/secret";
import { FIXTURE_USER_KEY, startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  home = tempHome();
  ctx = makeCtx(home);
  server.writes.length = 0;
  server.secrets = { stored: new Map(), repos: ["acme/app"], declared: null, role: "admin", deployed: true };
  await seedJoined(home, server, { config: { key: FIXTURE_USER_KEY } });
});

const printed = () => [...ctx.out, ...ctx.err].join("\n");
const secretWrites = () => server.writes.filter((w) => w.path.startsWith("/me/secrets"));
const placeholder = (i: number) => `placeholder-value-${String(i).padStart(2, "0")}`;

function envFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "catalyst-secret-"));
  const path = join(dir, ".env");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("Scenario: import a .env file from the CLI", () => {
  test("11 of 13 declared names are stored at repo scope, the 2 missing are listed, and no value is printed", async () => {
    const declared = Array.from({ length: 13 }, (_, i) => `SERVICE_${String(i + 1).padStart(2, "0")}_TOKEN`);
    server.secrets.declared = declared;
    const supplied = declared.slice(0, 11);
    const file = envFile(supplied.map((n, i) => `${n}=${placeholder(i)}`));

    const code = await main(["secret", "import", file, "--repo", "acme/app"], ctx);

    expect(code).toBe(0);
    for (const n of supplied) expect(server.secrets.stored.get(`acme/app:${n}`)?.value).toBe(placeholder(supplied.indexOf(n)));
    expect(server.secrets.stored.size).toBe(11);
    expect(ctx.out[0]).toBe(`stored 11 for acme/app: ${supplied.join(", ")}`);
    expect(ctx.out).toContain(`declared but still without a value (2): ${declared.slice(11).join(", ")}`);
    for (let i = 0; i < supplied.length; i++) expect(printed()).not.toContain(placeholder(i));

    const [write] = secretWrites();
    expect(write?.path).toBe("/me/secrets/import");
    expect(write?.headers.authorization).toBe(`Bearer ${FIXTURE_USER_KEY}`);
    expect(write?.body).toMatchObject({ repo: "acme/app", source: "import: .env", rotateExisting: [] });
  });

  test("--names sends only selected assignment lines and names requested values absent from the file", async () => {
    const selectedValue = placeholder(21);
    const unselectedValue = placeholder(22);
    const file = envFile([`DATABASE_URL=${selectedValue}`, `OTHER_SECRET=${unselectedValue}`]);
    const code = await main(["secret", "import", file, "--repo", "acme/app", "--names", "DATABASE_URL,NOT_PRESENT"], ctx);

    expect(code).toBe(0);
    expect(server.secrets.stored.get("acme/app:DATABASE_URL")?.value).toBe(selectedValue);
    expect(server.secrets.stored.has("acme/app:OTHER_SECRET")).toBe(false);
    expect(ctx.out).toContain("not found in .env: NOT_PRESENT");
    expect(printed()).not.toContain(selectedValue);
    expect(printed()).not.toContain(unselectedValue);
    const body = secretWrites()[0]?.body as { text?: string } | undefined;
    expect(body?.text).toContain("DATABASE_URL");
    expect(body?.text).not.toContain("OTHER_SECRET");
    expect(body?.text).not.toContain(unselectedValue);
  });

  test("a name already set is reported, not replaced, until --rotate names it", async () => {
    server.secrets.stored.set("acme/app:A_TOKEN", { value: placeholder(1), version: 1, source: null });
    const file = envFile([`A_TOKEN=${placeholder(2)}`]);

    expect(await main(["secret", "import", file, "--repo", "acme/app"], ctx)).toBe(1);
    expect(ctx.out).toContain("not stored: A_TOKEN (already set for this repository; pass --rotate <NAME> to replace it)");
    expect(server.secrets.stored.get("acme/app:A_TOKEN")?.value).toBe(placeholder(1));

    ctx.out.length = 0;
    expect(await main(["secret", "import", file, "--repo", "acme/app", "--rotate", "A_TOKEN"], ctx)).toBe(0);
    expect(server.secrets.stored.get("acme/app:A_TOKEN")?.value).toBe(placeholder(2));
    expect(ctx.out).toContain("  replaced: A_TOKEN");
    expect(printed()).not.toContain(placeholder(2));
  });

  test("a repo with no approved declaration says so instead of claiming nothing is missing", async () => {
    const file = envFile([`A_TOKEN=${placeholder(1)}`]);
    expect(await main(["secret", "import", file, "--repo", "acme/app"], ctx)).toBe(0);
    expect(ctx.out).toContain("acme/app has no approved environment declaration, so there is no declared list to check against");
  });
});

describe("Scenario: a secret resolves from a host command", () => {
  test("the stored value is the command's output, and the command text is sent as the audit source", async () => {
    const bin = mkdtempSync(join(tmpdir(), "catalyst-op-"));
    const op = join(bin, "op");
    writeFileSync(
      op,
      '#!/bin/sh\nif [ "$1" = read ] && [ "$2" = "op://Prod/db/url" ]; then printf "placeholder-db-url\\n"; else echo "op: unexpected $*" >&2; exit 3; fi\n',
    );
    chmodSync(op, 0o755);
    ctx = makeCtx(home, { env: { CATALYST_SKILLS_OFFLINE: "1", SHELL: "/bin/sh", PATH: `${bin}:${process.env.PATH ?? ""}` } });

    const code = await main(["secret", "set", "DATABASE_URL", "--repo", "acme/app", "--command", "op read op://Prod/db/url"], ctx);

    expect(code).toBe(0);
    expect(server.secrets.stored.get("acme/app:DATABASE_URL")).toEqual({
      value: "placeholder-db-url",
      version: 1,
      source: "command: op read op://Prod/db/url",
    });
    expect(ctx.out[0]).toBe("stored DATABASE_URL for acme/app (version 1, new; from the command)");
    expect(printed()).not.toContain("placeholder-db-url");
    expect(secretWrites()[0]?.body).toMatchObject({ name: "DATABASE_URL", scope: "repo", repo: "acme/app" });
  });

  test("a command that fails stores nothing and prints none of its output", async () => {
    ctx = makeCtx(home, { env: { CATALYST_SKILLS_OFFLINE: "1", SHELL: "/bin/sh", PATH: process.env.PATH ?? "" } });
    const code = await main(["secret", "set", "DATABASE_URL", "--repo", "acme/app", "--command", "printf placeholder-partial; exit 7"], ctx);
    expect(code).toBe(1);
    expect(ctx.err.join("\n")).toContain("the command exited 7; nothing was stored");
    expect(secretWrites()).toHaveLength(0);
    expect(printed()).not.toContain("placeholder-partial");
  });
});

describe("secret set's other value sources", () => {
  test("a piped value is read from stdin with its trailing newline dropped", async () => {
    const code = await main(["secret", "set", "A_TOKEN", "--repo", "acme/app"], ctx, {
      secret: { isTty: () => false, readStdin: async () => `${placeholder(3)}\n` },
    });
    expect(code).toBe(0);
    expect(server.secrets.stored.get("acme/app:A_TOKEN")).toMatchObject({ value: placeholder(3), source: "stdin" });
    expect(printed()).not.toContain(placeholder(3));
  });

  test("on a terminal the value is asked for with a hidden prompt", async () => {
    const asked: string[] = [];
    const code = await main(["secret", "set", "A_TOKEN", "--repo", "acme/app"], ctx, {
      secret: { isTty: () => true, prompt: async (q) => (asked.push(q), placeholder(4)) },
    });
    expect(code).toBe(0);
    expect(asked).toEqual(["Value for A_TOKEN (input hidden): "]);
    expect(server.secrets.stored.get("acme/app:A_TOKEN")).toMatchObject({ value: placeholder(4), source: "prompt" });
  });

  test("an empty value is refused before anything is sent", async () => {
    const code = await main(["secret", "set", "A_TOKEN", "--repo", "acme/app"], ctx, {
      secret: { isTty: () => false, readStdin: async () => "\n" },
    });
    expect(code).toBe(1);
    expect(secretWrites()).toHaveLength(0);
  });
});

describe("refusals are the cloud's, in words a person can act on", () => {
  test("a non-admin seat is refused with the cloud's message", async () => {
    server.secrets.role = "member";
    const code = await main(["secret", "set", "A_TOKEN", "--repo", "acme/app"], ctx, {
      secret: { isTty: () => false, readStdin: async () => placeholder(5) },
    });
    expect(code).toBe(1);
    expect(ctx.out).toEqual(["refused (403): managing the organization's secrets requires an admin or owner role"]);
    expect(printed()).not.toContain(placeholder(5));
  });

  test("an account key is refused: this is a person's verb", async () => {
    await seedJoined(home, server);
    const code = await main(["secret", "import", envFile(["A_TOKEN=x"]), "--repo", "acme/app"], ctx);
    expect(code).toBe(1);
    expect(ctx.out[0]).toContain("use your personal key");
  });

  test("a cloud that predates CLI secret writes answers 401, and the verb says it needs a newer cloud", async () => {
    server.secrets.deployed = false;
    const code = await main(["secret", "import", envFile(["A_TOKEN=x"]), "--repo", "acme/app"], ctx);
    expect(code).toBe(1);
    expect(ctx.out[0]).toContain("this cloud predates secret writes from the CLI");
  });

  test("a repository outside the tenant is named", async () => {
    const code = await main(["secret", "import", envFile(["A_TOKEN=x"]), "--repo", "someone/else"], ctx);
    expect(code).toBe(1);
    expect(ctx.out[0]).toBe("refused (404): someone/else is not a repository of this workspace. Register it first with catalyst onboard --team <KEY> --repo someone/else");
  });

  test("usage: --repo is required and must be owner/name; NAME must be env-shaped", async () => {
    expect(await main(["secret", "import", envFile(["A=x"])], ctx)).toBe(1);
    expect(ctx.err[0]).toBe("secret import needs --repo <owner/name>");
    expect(await main(["secret", "set", "A_TOKEN", "--repo", "acme"], ctx)).toBe(1);
    expect(await main(["secret", "set", "lower", "--repo", "acme/app"], ctx)).toBe(1);
    expect(secretWrites()).toHaveLength(0);
  });
});

/** A fetch that answers `/me/secrets*` with one forced reply and passes every other call to the
 *  fixture, for the refusal shapes the fixture's store cannot produce on its own. */
function cloudAnswering(status: number, body: unknown): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname.startsWith("/me/secrets")) {
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    return fetch(input, init);
  };
}

describe("a command's output is the value, and only one trailing newline is dropped", () => {
  test("trimOneNewline drops exactly one LF or CRLF and leaves every other byte alone", () => {
    expect(trimOneNewline("value\r\n")).toBe("value");
    expect(trimOneNewline("value\n")).toBe("value");
    expect(trimOneNewline("value\n\n")).toBe("value\n");
    expect(trimOneNewline("value")).toBe("value");
  });

  test("with no SHELL set the command still runs, through /bin/sh", async () => {
    expect(await runLocalCommand("printf placeholder-sh", { SHELL: "", PATH: process.env.PATH ?? "" })).toBe("placeholder-sh");
  });

  test("a command killed by a signal is named by the signal and stores nothing", async () => {
    await expect(runLocalCommand("kill -TERM $$", { SHELL: "/bin/sh", PATH: process.env.PATH ?? "" })).rejects.toThrow(
      "the command was killed by SIGTERM; nothing was stored",
    );
  });

  test("a shell that cannot be started is refused, not treated as an empty value", async () => {
    await expect(runLocalCommand("printf x", { SHELL: join(tmpdir(), "no-such-shell-here"), PATH: "" })).rejects.toThrow(
      /^could not run the command: .*; nothing was stored$/,
    );
  });
});

describe("secret usage errors are caught before anything is sent", () => {
  test.each([
    [["secret"], 'unknown secret subcommand "": set | import'],
    [["secret", "rotate", "A_TOKEN", "--repo", "acme/app"], 'unknown secret subcommand "rotate": set | import'],
    [["secret", "set", "--repo", "acme/app"], "secret set takes one NAME"],
    [["secret", "set", "A_TOKEN", "B_TOKEN", "--repo", "acme/app"], "secret set takes one NAME"],
    [["secret", "import", "--repo", "acme/app"], "secret import takes one file (a .env file)"],
    [["secret", "set", "A_TOKEN", "--repo", "acme/app", "--rotate", "A_TOKEN"], "--rotate belongs to secret import; secret set always replaces the value"],
    [["secret", "set", "A_TOKEN", "--repo", "acme/app", "--command", "   "], "--command is empty"],
    [["secret", "set", "A_TOKEN", "--repo", "acme app/x"], '--repo must be owner/name (got "acme app/x")'],
  ])("%j is refused with its own sentence", async (argv, message) => {
    expect(await main(argv, ctx)).toBe(1);
    expect(ctx.err[0]).toBe(message);
    expect(secretWrites()).toHaveLength(0);
  });

  test("--command beside import is refused, and so is a file that cannot be read", async () => {
    expect(await main(["secret", "import", envFile(["A=x"]), "--repo", "acme/app", "--command", "op read x"], ctx)).toBe(1);
    expect(ctx.err[0]).toBe("--command belongs to secret set");
    const missing = join(tmpdir(), "catalyst-secret-no-such-dir", ".env");
    const again = makeCtx(home);
    expect(await main(["secret", "import", missing, "--repo", "acme/app"], again)).toBe(1);
    expect(again.err[0]).toContain(`could not read ${missing}: ENOENT`);
    expect(secretWrites()).toHaveLength(0);
  });
});

describe("secret set and import in --json, and what a second write says", () => {
  test("set --json prints the name, repo, version and whether it was new, and never the value", async () => {
    const pipe = { isTty: () => false, readStdin: async () => placeholder(6) };
    expect(await main(["secret", "set", "A_TOKEN", "--repo", "acme/app", "--json"], ctx, { secret: pipe })).toBe(0);
    expect(JSON.parse(ctx.out[0] ?? "")).toEqual({ name: "A_TOKEN", repo: "acme/app", version: 1, created: true, declared: null });
    expect(printed()).not.toContain(placeholder(6));
  });

  test("setting the same name again replaces it and says so, at the next version", async () => {
    const pipe = { isTty: () => false, readStdin: async () => placeholder(7) };
    server.secrets.stored.set("acme/app:A_TOKEN", { value: placeholder(1), version: 3, source: null });
    expect(await main(["secret", "set", "A_TOKEN", "--repo", "acme/app"], ctx, { secret: pipe })).toBe(0);
    expect(ctx.out[0]).toBe("stored A_TOKEN for acme/app (version 4, replaced; from stdin)");
    expect(server.secrets.stored.get("acme/app:A_TOKEN")?.value).toBe(placeholder(7));
  });

  test("a refused set --json carries the status and the cloud's own error, and exits 1", async () => {
    server.secrets.role = "member";
    const pipe = { isTty: () => false, readStdin: async () => placeholder(8) };
    expect(await main(["secret", "set", "A_TOKEN", "--repo", "acme/app", "--json"], ctx, { secret: pipe })).toBe(1);
    expect(JSON.parse(ctx.out[0] ?? "")).toEqual({
      status: 403,
      error: "forbidden",
      message: "managing the organization's secrets requires an admin or owner role",
    });
  });

  test("import --json lists created, rotated and refused names, and a refused name exits 1", async () => {
    server.secrets.stored.set("acme/app:OLD_TOKEN", { value: placeholder(1), version: 1, source: null });
    const file = envFile([`NEW_TOKEN=${placeholder(2)}`, `OLD_TOKEN=${placeholder(3)}`]);
    expect(await main(["secret", "import", file, "--repo", "acme/app", "--json"], ctx)).toBe(1);
    expect(JSON.parse(ctx.out[0] ?? "")).toEqual({
      repo: "acme/app",
      created: ["NEW_TOKEN"],
      rotated: [],
      errors: [{ name: "OLD_TOKEN", reason: "name_exists" }],
      declared: null,
    });
    expect(printed()).not.toContain(placeholder(2));
  });

  test("a refused import --json carries the status, with null for what the cloud did not say", async () => {
    server.secrets.deployed = false;
    expect(await main(["secret", "import", envFile(["A_TOKEN=x"]), "--repo", "acme/app", "--json"], ctx)).toBe(1);
    expect(JSON.parse(ctx.out[0] ?? "")).toEqual({ status: 401, error: "unauthorized", message: null });
  });
});

describe("what the declared list says after a write", () => {
  test("a declaration that names no secrets says so", async () => {
    server.secrets.declared = [];
    expect(await main(["secret", "import", envFile(["A_TOKEN=x"]), "--repo", "acme/app"], ctx)).toBe(0);
    expect(ctx.out).toContain("acme/app's approved declaration names no secrets");
  });

  test("once every declared name has a value the count is printed, not an empty missing list", async () => {
    server.secrets.declared = ["A_TOKEN", "B_TOKEN"];
    expect(await main(["secret", "import", envFile(["A_TOKEN=x", "B_TOKEN=y"]), "--repo", "acme/app"], ctx)).toBe(0);
    expect(ctx.out).toEqual(["stored 2 for acme/app: A_TOKEN, B_TOKEN", "every declared secret has a value (2)"]);
  });
});

describe("refusals the fixture store cannot reach, forced on the wire", () => {
  const pipe = { isTty: () => false, readStdin: async () => placeholder(9) };

  test("a cloud whose secret audit is not migrated says nothing was stored and who to tell", async () => {
    const forced = makeCtx(home, { fetch: cloudAnswering(409, { error: "registry_not_migrated" }) });
    expect(await main(["secret", "set", "A_TOKEN", "--repo", "acme/app"], forced, { secret: pipe })).toBe(1);
    expect(forced.out).toEqual(["refused (409): the cloud's secret audit is not set up yet, so nothing was stored. Tell your Catalyst operator."]);
  });

  test("any other 409 falls back to the cloud's error code when it sends no message", async () => {
    const forced = makeCtx(home, { fetch: cloudAnswering(409, { error: "write_conflict" }) });
    expect(await main(["secret", "set", "A_TOKEN", "--repo", "acme/app"], forced, { secret: pipe })).toBe(1);
    expect(forced.out).toEqual(["refused (409): write_conflict"]);
  });

  test("a refusal with no error and no message says no reason was given", async () => {
    const forced = makeCtx(home, { fetch: cloudAnswering(422, {}) });
    expect(await main(["secret", "import", envFile(["A_TOKEN=x"]), "--repo", "acme/app"], forced)).toBe(1);
    expect(forced.out).toEqual(["refused (422): no reason given"]);
  });

  test("each import refusal reason is explained, an unknown one is printed as sent, and a rotation is listed", async () => {
    const forced = makeCtx(home, {
      fetch: cloudAnswering(200, {
        created: [],
        rotated: ["B_TOKEN"],
        errors: [
          { name: "lower", reason: "invalid_name" },
          { name: "EMPTY", reason: "invalid_value" },
          { name: "PLAIN", reason: "name_taken_by_env_var" },
          { name: "CFG", reason: "config_rotation_unconfirmed" },
          { name: "BAD_KEY", reason: "probe_refused" },
          { name: "ODD", reason: "some_future_reason" },
        ],
      }),
    });
    expect(await main(["secret", "import", envFile(["B_TOKEN=x"]), "--repo", "acme/app", "--rotate", "B_TOKEN"], forced)).toBe(1);
    expect(forced.out).toEqual([
      "stored 1 for acme/app: B_TOKEN",
      "  replaced: B_TOKEN",
      "not stored: lower (not an env-style name (A-Z, 0-9 and _, starting with a letter))",
      "not stored: EMPTY (the value is empty)",
      "not stored: PLAIN (already a plain environment variable; a name is a secret or a variable, never both)",
      "not stored: CFG (the existing entry is a plain variable; change it with catalyst var set)",
      "not stored: BAD_KEY (the value failed this kind's check)",
      "not stored: ODD (some_future_reason)",
    ]);
  });

  test("a success body with no version or lists still prints a line instead of crashing", async () => {
    const forced = makeCtx(home, { fetch: cloudAnswering(200, {}) });
    expect(await main(["secret", "set", "A_TOKEN", "--repo", "acme/app"], forced, { secret: pipe })).toBe(0);
    expect(forced.out).toEqual(["stored A_TOKEN for acme/app (version ?, replaced; from stdin)"]);
    const forcedImport = makeCtx(home, { fetch: cloudAnswering(200, {}) });
    expect(await main(["secret", "import", envFile(["A_TOKEN=x"]), "--repo", "acme/app"], forcedImport)).toBe(0);
    expect(forcedImport.out).toEqual(["stored nothing for acme/app"]);
  });
});

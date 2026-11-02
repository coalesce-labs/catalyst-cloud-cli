// lease-holder.test.ts — CTC-8873: the holder details `lease take` and `lease renew` check before
// sending, the credential-shape check copied from the vendored settings bundle (and pinned to it),
// and the labels show and list print from what a cloud returns.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseArgs, verbHelp } from "../src/args";
import { CAPABILITIES, reportCapabilities } from "../src/capabilities";
import { usageText } from "../src/cli";
import {
  CONTACT_HOSTS,
  HOLDER_DETAILS_CONTRACT,
  HOLDER_KINDS,
  SECRET_ASSIGNMENT_RE,
  SECRET_TOKEN_SHAPES,
  SESSION_HOSTS,
  credentialShapeIn,
  detailsDiffer,
  holderLabel,
  httpsHost,
  normalizeDisplayName,
  ownerLabel,
  resolveHolderDetails,
  sanitize,
  secretTokenIn,
  shellWord,
  writeLabel,
} from "../src/lease-holder";

// Synthetic credentials, built at run time so no token-shaped literal sits in the source.
const mixed = (n: number) => "Ab1".repeat(Math.ceil(n / 3)).slice(0, n);
const TOKENS: [string, string][] = [
  [`ghp_${"a1B2".repeat(9)}`, "GitHub token"],
  [`github_pat_${"a1B2_".repeat(5)}`, "GitHub token"],
  [`sk_live_${"a1B2".repeat(4)}`, "Stripe key"],
  [`sk-${mixed(32)}`, "OpenAI-style API key"],
  [`sk-proj-${mixed(40)}`, "OpenAI-style API key"],
  [`sk-ant-api03-${mixed(40)}`, "Anthropic API key"],
  [`xoxb-1${"a".repeat(10)}`, "Slack token"],
  [`AKIA${"A1".repeat(8)}`, "AWS access key"],
  [`AIza${"a".repeat(35)}`, "Google API key"],
  ["-----BEGIN RSA PRIVATE KEY-----", "private key"],
  ["GITHUB_TOKEN=abcd1234", "secret assignment"],
];
const CLEAN = ["s_8f2c", "task-example", "sk-integration-test-runner", "ghp_short", "Example Agent (trial)", "https://example.com/session_01", "AKIAshort", "TOKEN=ab"];

const resolve = (argv: string[], env: NodeJS.ProcessEnv = {}, action: "take" | "renew" = "take") =>
  resolveHolderDetails(parseArgs(["lease", action, "CTC-1", ...argv]), env, action);
const refusal = (argv: string[], env: NodeJS.ProcessEnv = {}, action: "take" | "renew" = "take"): string => {
  try {
    resolve(argv, env, action);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("the credential-shape check matches the vendored one", () => {
  // The vendored bundle exports only its settings validator, so its secret-material section is
  // evaluated alone, in an empty context, from the trusted generated file.
  const source = readFileSync(new URL("../vendor/settings/index.js", import.meta.url), "utf8");
  const start = source.indexOf("// packages/environment/src/secret-material.ts");
  const end = source.indexOf("function secretTokenMessage", start);
  const vendored = runInNewContext(`${source.slice(start, end)}\n({ SECRET_ASSIGNMENT_RE, SECRET_TOKEN_SHAPES, secretTokenIn })`, {}) as {
    SECRET_ASSIGNMENT_RE: RegExp;
    SECRET_TOKEN_SHAPES: unknown;
    secretTokenIn: (value: string) => unknown;
  };

  test("the vendored section is where this test looks for it", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  test("the same token table and assignment pattern", () => {
    expect(JSON.parse(JSON.stringify(vendored.SECRET_TOKEN_SHAPES))).toEqual(JSON.parse(JSON.stringify(SECRET_TOKEN_SHAPES)));
    expect(vendored.SECRET_ASSIGNMENT_RE.source).toBe(SECRET_ASSIGNMENT_RE.source);
    expect(vendored.SECRET_ASSIGNMENT_RE.flags).toBe(SECRET_ASSIGNMENT_RE.flags);
  });

  test("the same answer on every token, embedded token, separator and clean value", () => {
    const values = [
      ...TOKENS.map(([t]) => t), ...CLEAN,
      ...TOKENS.flatMap(([t]) => [`x ${t}`, `x=${t}`, `x/${t}`, `x${t}`, `${CLEAN[0]} ${t}`]),
      `${TOKENS[3]![0]} then ${TOKENS[0]![0]}`,
    ];
    for (const value of values) expect(secretTokenIn(value), value.slice(0, 12)).toEqual(JSON.parse(JSON.stringify(vendored.secretTokenIn(value))));
  });

  test("every synthetic token is found with its kind, and clean near-matches are not", () => {
    for (const [token, kind] of TOKENS) {
      expect(credentialShapeIn(token)).toBe(kind);
      expect(credentialShapeIn(`session ${token}`)).toBe(kind);
    }
    for (const value of CLEAN) expect(credentialShapeIn(value)).toBeNull();
    // The earliest match wins.
    expect(credentialShapeIn(`${TOKENS[7]![0]} ${TOKENS[0]![0]}`)).toBe("AWS access key");
  });
});

describe("resolving holder details", () => {
  test("no flag and no variable declares nothing", () => {
    expect(resolve([])).toBeNull();
    expect(resolve([], { CATALYST_LEASE_HOLDER_KIND: "", CATALYST_LEASE_LINK: "  ", CATALYST_LEASE_EXTERNAL_ID: "" })).toBeNull();
  });

  test("every declarable kind, and never unspecified or catalyst-runner", () => {
    expect(HOLDER_KINDS).toEqual(["catalyst-seat", "claude-code", "codex", "factory", "devin", "cursor", "other"]);
    for (const kind of HOLDER_KINDS) expect(resolve(["--holder-kind", kind])!.details).toEqual({ kind });
    for (const kind of ["unspecified", "catalyst-runner", "Factory", "secret-kind-value"]) {
      const message = refusal(["--holder-kind", kind]);
      expect(message).toBe("--holder-kind is one of catalyst-seat, claude-code, codex, factory, devin, cursor, other");
    }
    expect(refusal([], { CATALYST_LEASE_HOLDER_KIND: "bogus" })).toBe(
      "--holder-kind (from CATALYST_LEASE_HOLDER_KIND) is one of catalyst-seat, claude-code, codex, factory, devin, cursor, other",
    );
  });

  test("session hosts are exact per kind", () => {
    expect(SESSION_HOSTS).toEqual({ "catalyst-seat": ["staging.catalystcloud.dev", "app.catalystcloud.dev"], "claude-code": ["claude.ai"], codex: ["chatgpt.com"] });
    expect(resolve(["--holder-kind", "catalyst-seat", "--link", "https://staging.catalystcloud.dev/r/1"])!.details.sessionUrl).toBe("https://staging.catalystcloud.dev/r/1");
    expect(resolve(["--holder-kind", "catalyst-seat", "--link", "https://app.catalystcloud.dev/r/1"])).not.toBeNull();
    expect(resolve(["--holder-kind", "codex", "--link", "https://chatgpt.com/codex/tasks/t"])).not.toBeNull();
    expect(resolve(["--holder-kind", "claude-code", "--link", "https://CLAUDE.AI/code/s"])).not.toBeNull();
    expect(refusal(["--holder-kind", "catalyst-seat", "--link", "https://evil.catalystcloud.dev/r/1"])).toBe(
      "--link: kind catalyst-seat allows session links on staging.catalystcloud.dev or app.catalystcloud.dev only",
    );
    expect(refusal(["--holder-kind", "claude-code", "--link", "https://claude.ai.example.com/s"])).toBe("--link: kind claude-code allows session links on claude.ai only");
    for (const kind of ["factory", "devin", "cursor", "other"])
      expect(refusal(["--holder-kind", kind, "--link", "https://claude.ai/s"])).toBe(`--link: kind ${kind} allows no session link yet (allowed hosts: none)`);
  });

  test("a malformed session link is refused without its value", () => {
    const shape = "--link must be an https link of at most 2048 characters with no user name, port, query or fragment";
    for (const link of [
      "http://claude.ai/s", "https://claude.ai:443/s", "https://claude.ai:8443/s", "https://user@claude.ai/s", "https://u:p@claude.ai/s",
      "https://claude.ai/s?x=1", "https://claude.ai/s?", "https://claude.ai/s#f", "https://claude.ai/a b", "https://claude.ai\\s",
      "https://cl%61ude.ai/s", "https:/claude.ai/s", "claude.ai/s", "https://", `https://claude.ai/${"a".repeat(2048)}`,
    ]) expect(refusal(["--holder-kind", "claude-code", "--link", link]), link).toBe(shape);
    expect(resolve(["--holder-kind", "claude-code", "--link", `https://claude.ai/${"a".repeat(2048 - "https://claude.ai/".length)}`])).not.toBeNull();
  });

  test("httpsHost reads the authority raw, before a default port is erased", () => {
    expect(httpsHost("https://claude.ai")).toBe("claude.ai");
    expect(httpsHost("https://claude.ai/")).toBe("claude.ai");
    expect(httpsHost("https://claude.ai:443/")).toBeNull();
    expect(httpsHost("https://[::1]/")).toBeNull();
  });

  test("display names: NFC, whitespace collapsed, 1 to 80 characters, no controls or bidi", () => {
    expect(normalizeDisplayName("  Factory \t Droid\n ")).toBe("Factory Droid");
    expect(normalizeDisplayName("Zoë")).toBe("Zoë");
    expect(normalizeDisplayName("é".repeat(80))).toBe("é".repeat(80));
    expect(normalizeDisplayName("é".repeat(81))).toBeNull();
    for (const bad of ["a\u0000b", "a\u0007b", "a\u007fb", "a\u0085b", "a\u202eb", "a\u2066b", "a\u200fb", "a\u061cb"]) expect(normalizeDisplayName(bad)).toBeNull();
    expect(resolve(["--name", "  Agent   1 "])!.details).toEqual({ displayName: "Agent 1" });
    expect(refusal(["--name", "x".repeat(81)])).toBe("--name is 1 to 80 characters with no control or bidi characters");
  });

  test("external ids: 1 to 128 of A-Z a-z 0-9 . _ : -", () => {
    expect(resolve(["--external-id", "s_8f2c:a.b-c"])!.details).toEqual({ externalId: "s_8f2c:a.b-c" });
    expect(resolve(["--external-id", "a".repeat(128)])).not.toBeNull();
    for (const bad of ["a".repeat(129), "a b", "a/b", "é"]) expect(refusal(["--external-id", bad])).toBe("--external-id is 1 to 128 of A-Z, a-z, 0-9, '.', '_', ':' and '-'");
  });

  test("contacts: an https link on three hosts, never an email", () => {
    expect(CONTACT_HOSTS).toEqual(["linear.app", "github.com", "app.slack.com"]);
    for (const contact of ["https://linear.app/x/issue/CTC-1", "https://github.com/o/r/issues/1", "https://app.slack.com/client/T/C"])
      expect(resolve(["--contact", contact])!.details).toEqual({ contact });
    for (const email of ["ryan@example.com", "mailto:ryan@example.com"])
      expect(refusal(["--contact", email])).toBe("--contact must be a link, not an email: an https link on linear.app, github.com or app.slack.com");
    for (const bad of ["http://github.com/x", "https://gist.github.com/x", "https://github.com:443/x", "+1 555 0100", "https://github.com/x?a=1"])
      expect(refusal(["--contact", bad]), bad).toBe("--contact must be an https link on linear.app, github.com or app.slack.com, with no user name, port, query or fragment");
  });

  test("the credential check runs first, on all four fields, and names only the flag", () => {
    for (const [token, kind] of TOKENS) {
      const a = /^[AEIOU]/.test(kind) ? "an" : "a";
      const tail = `looks like ${a} ${kind}. Holder details are visible to every member of the workspace, so they never carry a credential. Send the session's id instead.`;
      for (const [argv, flag] of [
        [["--name", `x ${token}`], "--name"],
        [["--external-id", token], "--external-id"],
        [["--contact", `https://github.com/${token}`], "--contact"],
        [["--holder-kind", "claude-code", "--link", `https://claude.ai/code/${token}`], "--link"],
        // A structural break does not hide a credential.
        [["--link", `ftp://nowhere/${token}`], "--link"],
        [["--holder-kind", "bogus", "--external-id", token], "--external-id"],
      ] as [string[], string][]) {
        const message = refusal(argv);
        expect(message).toBe(`${flag} ${tail}`);
        expect(message).not.toContain(token);
      }
    }
    expect(refusal([], { CATALYST_LEASE_LINK: `https://claude.ai/${TOKENS[0]![0]}` })).toMatch(/^--link \(from CATALYST_LEASE_LINK\) looks like a GitHub token\./);
  });

  test("flags win over the environment; a blank flag is an error; renew reads no kind", () => {
    const env = { CATALYST_LEASE_HOLDER_KIND: "codex", CATALYST_LEASE_LINK: "https://chatgpt.com/c/1", CATALYST_LEASE_EXTERNAL_ID: "env_1" };
    expect(resolve([], env)!.details).toEqual({ kind: "codex", sessionUrl: "https://chatgpt.com/c/1", externalId: "env_1" });
    expect(resolve(["--holder-kind", "claude-code", "--link", "https://claude.ai/s", "--external-id", "flag_1"], env)!.details).toEqual({
      kind: "claude-code", sessionUrl: "https://claude.ai/s", externalId: "flag_1",
    });
    expect(resolve([], env, "renew")).toEqual({ details: { sessionUrl: "https://chatgpt.com/c/1", externalId: "env_1" }, link: { label: "--link (from CATALYST_LEASE_LINK)", host: "chatgpt.com" } });
    expect(resolve([], { CATALYST_LEASE_HOLDER_KIND: "codex" }, "renew")).toBeNull();
    expect(refusal(["--holder-kind", "codex"], {}, "renew")).toBe("--holder-kind is for lease take; a renew keeps the kind its take declared");
    for (const flag of ["--name", "--external-id", "--link", "--contact", "--holder-kind"])
      expect(refusal([`${flag}= `])).toBe(`${flag} needs a value; leave the flag out to send none`);
  });

  test("the contract minimum is 2.65.0", () => {
    expect(HOLDER_DETAILS_CONTRACT).toBe("2.65.0");
  });
});

describe("labels from what a cloud returns", () => {
  test("show labels use the declared name and kind whenever they exist; take labels keep the seat for unspecified", () => {
    const unspecified = { kind: "unspecified", displayName: "agent-1" };
    expect(holderLabel(unspecified, "seat:k:agent-1")).toBe("agent-1 [unspecified]");
    expect(writeLabel(unspecified, "seat:k:agent-1")).toBe("seat:k:agent-1");
    expect(writeLabel({ kind: "factory", displayName: "F" }, "seat:k:f")).toBe("F [factory]");
    expect(holderLabel(null, "seat:k:old")).toBe("seat:k:old");
    expect(holderLabel({ kind: "factory" }, null)).toBe("nobody");
    expect(writeLabel(undefined, "")).toBe("nobody");
  });

  test("owners: a key by name, else its id; a person by name, else a member; never anything guessed", () => {
    expect(ownerLabel({ type: "organization-key", keyId: "key_1", keyName: "factory-trial" })).toBe("organization key factory-trial");
    expect(ownerLabel({ type: "organization-key", keyId: "key_1", keyName: null })).toBe("organization key key_1");
    expect(ownerLabel({ type: "organization-key" })).toBeNull();
    expect(ownerLabel({ type: "person", userId: "u", name: "Sam Example" })).toBe("person Sam Example");
    expect(ownerLabel({ type: "person", userId: "u", name: null, email: "tony@example.com" })).toBe("person (a member of this workspace)");
    expect(ownerLabel({ type: "robot" })).toBeNull();
    expect(ownerLabel("organization key")).toBeNull();
  });

  test("sanitize drops C0, C1 and bidi controls only", () => {
    expect(sanitize("a\u001b[31mb\u009bc\u202ed\u2069e é\u2028\u2029")).toBe("a[31mbcde é");
  });

  test("a declared field the cloud did not keep is a difference", () => {
    expect(detailsDiffer({ kind: "factory", externalId: "s_1" }, { kind: "factory", externalId: "s_1", displayName: "x" })).toBe(false);
    expect(detailsDiffer({ externalId: "s_2" }, { externalId: "s_1" })).toBe(true);
    expect(detailsDiffer({ contact: "https://github.com/x" }, null)).toBe(true);
  });

  test("shell words: bare when safe, single-quoted when printable, ANSI-C quoted otherwise", () => {
    expect(shellWord("eyJzIjoxfQ")).toBe("eyJzIjoxfQ");
    expect(shellWord("eyJzIjoxfQ==")).toBe("eyJzIjoxfQ==");
    expect(shellWord("~abc")).toBe("'~abc'");
    expect(shellWord("=foo")).toBe("'=foo'");
    expect(shellWord("a b;c|d")).toBe("'a b;c|d'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
    expect(shellWord("a\u001bb'\\é😀")).toBe("$'a\\u001bb\\'\\\\\\u00e9\\U0001f600'");
  });
});

describe("help and capability discovery name the new flags and lease list", () => {
  test("lease help carries each flag's sentence and its environment stand-in", () => {
    const help = verbHelp("lease");
    for (const line of [
      "--holder-kind <kind>  take: declare the agent kind (default: unspecified; CATALYST_LEASE_HOLDER_KIND)",
      "--name <name>  take, renew: a display name, 1 to 80 characters; never a credential",
      "--external-id <id>  take, renew: the session's id (CATALYST_LEASE_EXTERNAL_ID); never a credential",
      "--link <https-url>  take, renew: a session link on a host the holder kind allows (CATALYST_LEASE_LINK)",
      "--contact <https-url>  take, renew: a contact link on linear.app, github.com or app.slack.com; never an email",
      "--team <key>", "--state <live|recent>", "--limit <1..200>", "--cursor <token>",
      "list --team <key>",
    ]) expect(help).toContain(line);
    expect(usageText()).toContain("list --team <key>");
  });

  test("lease list is its own capability, so a cloud without the list route keeps the other four", () => {
    const list = CAPABILITIES.find((c) => c.verb === "lease list")!;
    expect(list.routes).toEqual([{ method: "GET", path: "/api/v1/agent/ticket-leases" }]);
    const old = CAPABILITIES.find((c) => c.verb === "lease take|renew|release|show")!;
    expect(old.since).toBe("0.16.30");
    expect(old.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/v1/agent/ticket-lease/take", "POST /api/v1/agent/ticket-lease/renew", "POST /api/v1/agent/ticket-lease/release", "GET /api/v1/agent/ticket-lease",
    ]);
    const served = old.routes.map((r) => ({ ...r, takesWriteBudgetUnit: r.method === "POST", since: "1.0.0" }));
    const report = reportCapabilities(served);
    expect(report.find((c) => c.verb === old.verb)!.availability).toBe("available");
    expect(report.find((c) => c.verb === "lease list")!.availability).toBe("needs_newer_cloud");
    const withList = reportCapabilities([...served, { method: "GET", path: "/api/v1/agent/ticket-leases", takesWriteBudgetUnit: false, since: "2.65.0" }]);
    expect(withList.find((c) => c.verb === "lease list")!.availability).toBe("available");
  });
});

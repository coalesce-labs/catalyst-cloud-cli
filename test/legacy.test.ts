// legacy.test.ts — `catalyst legacy`: leftovers of the old local Catalyst runtime, from a FIXED list,
// found and (only on a yes) removed through the tools that own them. Every test runs against a temp
// HOME and a fake spawner that records the commands, so no real `claude`, `launchctl` or `systemctl`
// is ever touched; current jobs, current plugins and other people's files are never matched.
import { describe, expect, test, beforeEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { readManifest } from "../src/config";
import {
  LEGACY_SOURCE_COMMIT,
  OLD_LAUNCHD_LABELS,
  OLD_USER_UNITS,
  type LegacyRun,
} from "../src/legacy";
import { makeCtx, tempHome, type TestCtx } from "./helpers";

let home: string;
let ctx: TestCtx;
let calls: string[];
let failing: Set<string>;

const write = (rel: string, text = "") => {
  const p = join(home, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};
const registry = () => ({
  marketplaces: JSON.parse(
    readFileSync(
      join(home, ".claude", "plugins", "known_marketplaces.json"),
      "utf8",
    ),
  ) as Record<string, unknown>,
  plugins: (
    JSON.parse(
      readFileSync(
        join(home, ".claude", "plugins", "installed_plugins.json"),
        "utf8",
      ),
    ) as { plugins: Record<string, unknown> }
  ).plugins,
});
/** The fake tools. `claude plugin uninstall|marketplace remove` edit the registry the way the real one does. */
const run: LegacyRun = (cmd, args) => {
  const line = [cmd, ...args].join(" ");
  calls.push(line);
  if (failing.has(line)) return { status: 1, stdout: "", stderr: "boom" };
  if (cmd === "claude" && args[0] === "plugin" && args[1] === "uninstall") {
    const r = registry();
    delete r.plugins[args[2]!];
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: r.plugins }),
    );
  }
  if (
    cmd === "claude" &&
    args[0] === "plugin" &&
    args[1] === "marketplace" &&
    args[2] === "remove"
  ) {
    const r = registry();
    delete r.marketplaces[args[3]!];
    writeFileSync(
      join(home, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify(r.marketplaces),
    );
  }
  return { status: 0, stdout: "", stderr: "" };
};
const deps = (over: Record<string, unknown> = {}) => ({
  legacy: {
    run,
    platform: "darwin" as NodeJS.Platform,
    uid: 501,
    isTty: () => false,
    ...over,
  },
});

function oldMachine(): void {
  write(
    ".claude/plugins/known_marketplaces.json",
    JSON.stringify({
      catalyst: {
        source: { source: "github", repo: "coalesce-labs/catalyst" },
        installLocation: "/x/catalyst",
      },
      "catalyst-dev-skills": {
        source: { source: "github", repo: "coalesce-labs/catalyst-dev-skills" },
        installLocation: "/x/dev",
      },
    }),
  );
  write(
    ".claude/plugins/installed_plugins.json",
    JSON.stringify({
      version: 2,
      plugins: {
        "catalyst-dev@catalyst": { version: "1.0.0" },
        "catalyst-pm-ops@catalyst": { version: "1.0.0" },
        "catalyst-dev@catalyst-dev-skills": { version: "0.4.0" },
        "cloudflare@cloudflare": { version: "1.0.0" },
      },
    }),
  );
  write("Library/LaunchAgents/com.catalyst.agent.plist", "<plist/>");
  write("Library/LaunchAgents/com.catalyst.role.concierge.plist", "<plist/>");
  write(
    "Library/LaunchAgents/dev.catalystcloud.housekeeping.plist",
    "<plist/>",
  );
  write("Library/LaunchAgents/dev.catalyst.sbx-credit-guard.plist", "<plist/>");
  write("Library/LaunchAgents/com.example.other.plist", "<plist/>");
  write(".catalyst/bin/catalyst-stack", "#!/bin/sh");
  write(".local/bin/catalyst-hud", "#!/bin/sh");
  write(".local/bin/catalyst", "#!/bin/sh");
  write(".config/catalyst/config.json", "{}");
  write(".config/catalyst-cloud/customer.json", "{}");
  write(".local/state/catalyst-ledger/ledger.sqlite3", "");
}

beforeEach(() => {
  home = tempHome();
  ctx = makeCtx(home);
  calls = [];
  failing = new Set();
});

describe("the fixed list", () => {
  test("records its source commit, and never names a current job or the current plugin", () => {
    expect(LEGACY_SOURCE_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    for (const l of OLD_LAUNCHD_LABELS)
      expect(l).not.toMatch(/^dev\.catalystcloud\.|^dev\.catalyst\./);
    expect(OLD_LAUNCHD_LABELS).toContain("com.catalyst.agent");
    expect(OLD_LAUNCHD_LABELS).toContain("ai.coalesce.catalyst-stack");
    expect(
      OLD_USER_UNITS.every((u) => /^catalyst[a-z-]*\.(service|timer)$/.test(u)),
    ).toBe(true);
  });
});

describe("a machine with nothing old", () => {
  test("prints one line, exits 0, and the JSON has an empty found list", async () => {
    write(".config/catalyst-cloud/customer.json", "{}");
    write(
      "Library/LaunchAgents/dev.catalystcloud.housekeeping.plist",
      "<plist/>",
    );
    expect(await main(["legacy"], ctx, deps())).toBe(0);
    expect(ctx.out).toEqual([
      "no leftovers of the old local Catalyst runtime on this machine",
    ]);
    ctx.out.length = 0;
    expect(await main(["legacy", "--json"], ctx, deps())).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({
      sourceCommit: LEGACY_SOURCE_COMMIT,
      found: [],
      removed: [],
      remaining: [],
    });
    expect(calls).toEqual([]);
  });
});

describe("current shared data on a fresh installation", () => {
  test("--remove --data without a terminal keeps data and reports the complete retry command", async () => {
    write(".config/catalyst-cloud/replica.db", "saved database");
    expect(await main(["legacy", "--remove", "--data"], ctx, deps())).toBe(1);
    expect(readFileSync(join(home, ".config/catalyst-cloud/replica.db"), "utf8")).toBe("saved database");
    expect(ctx.out.join("\n")).toContain("catalyst legacy --remove --data --yes");
    expect(calls).toEqual([]);
  });

  test("a replaced pidfile after confirmation is rejected before signaling any writer", async () => {
    write(".config/catalyst-cloud/replica.db", "saved database");
    write(".config/catalyst-cloud/replica.db.pid", "424242");
    const stopped: number[] = [];
    expect(await main(["legacy", "--remove", "--data"], ctx, deps({
      isTty: () => true,
      prompt: async () => {
        const pidfile = join(home, ".config/catalyst-cloud/replica.db.pid");
        const replacement = join(home, ".config/catalyst-cloud/replacement");
        writeFileSync(replacement, "313131");
        unlinkSync(pidfile);
        // Keep the new inode distinct from the approved pidfile.
        const { renameSync } = await import("node:fs");
        renameSync(replacement, pidfile);
        return "yes";
      },
      stopWriter: async (pid: number) => { stopped.push(pid); },
    }))).toBe(1);
    expect(stopped).toEqual([]);
    expect(readFileSync(join(home, ".config/catalyst-cloud/replica.db"), "utf8")).toBe("saved database");
  });

  test("a service that removes its pidfile during shutdown still has its local data removed", async () => {
    write("Library/LaunchAgents/ai.coalesce.catalyst-replica-sync.plist", "existing writer");
    write(".config/catalyst-cloud/replica.db", "saved database");
    write(".config/catalyst-cloud/replica.db.pid", "424242");
    expect(await main(["legacy", "--remove", "--data", "--yes"], ctx, deps({
      run: () => {
        unlinkSync(join(home, ".config/catalyst-cloud/replica.db.pid"));
        return { status: 0, stdout: "", stderr: "" };
      },
    }))).toBe(0);
    expect(existsSync(join(home, ".config/catalyst-cloud/replica.db"))).toBe(false);
  });

  test("both the saved custom replica and the newly selected replica are inventoried and removed", async () => {
    const old = join(home, "old", "custom.db");
    const current = join(home, "new", "current.db");
    write("old/custom.db", "old local data");
    write("new/current.db", "new local data");
    write(".config/catalyst-cloud/customer.json", JSON.stringify({ account: "tenant-a", baseUrl: "https://example.test", key: "fixture", replicaDb: old, lastSkillBundleVersion: readManifest().version }));
    ctx.env.CATALYST_REPLICA_DB = current;
    expect(await main(["legacy", "--remove", "--data"], ctx, deps({
      isTty: () => true, prompt: async () => {
        expect(ctx.out.join("\n")).toContain(old);
        expect(ctx.out.join("\n")).toContain(current);
        return "yes";
      },
    }))).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(current)).toBe(false);
  });

  test.each(["customer.json", "contract.json", "settings.json"])("a misconfigured replica path cannot delete protected %s", async (name) => {
    const login = JSON.stringify({ account: "tenant-a", baseUrl: "https://example.test", key: "fixture", lastSkillBundleVersion: readManifest().version });
    write(".config/catalyst-cloud/customer.json", login);
    if (name !== "customer.json") write(`.config/catalyst-cloud/${name}`, "protected bytes");
    const path = join(home, ".config/catalyst-cloud", name);
    const before = readFileSync(path, "utf8");
    ctx.env.CATALYST_REPLICA_DB = path;
    expect(await main(["legacy", "--remove", "--data", "--yes"], ctx, deps())).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("failed writer shutdown keeps the replica DB and WAL", async () => {
    write(".config/catalyst-cloud/replica.db", "saved database");
    write(".config/catalyst-cloud/replica.db-wal", "saved WAL");
    write(".config/catalyst-cloud/replica.db.pid", "424242");
    expect(await main(["legacy", "--remove", "--data", "--yes"], ctx, deps({
      stopWriter: async () => { throw new Error("writer is still running"); },
    }))).toBe(1);
    expect(readFileSync(join(home, ".config/catalyst-cloud/replica.db"), "utf8")).toBe("saved database");
    expect(readFileSync(join(home, ".config/catalyst-cloud/replica.db-wal"), "utf8")).toBe("saved WAL");
  });

  test("--remove --data with a negative confirmation keeps every local sync file", async () => {
    write(".config/catalyst-cloud/replica.db", "saved database");
    write(".config/catalyst-cloud/replica.db-wal", "saved WAL");
    expect(await main(["legacy", "--remove", "--data"], ctx, deps({
      isTty: () => true, prompt: async () => "no",
      stopWriter: async () => { throw new Error("must not stop without approval"); },
    }))).toBe(1);
    expect(calls).toEqual([]);
    expect(readFileSync(join(home, ".config/catalyst-cloud/replica.db"), "utf8")).toBe("saved database");
    expect(readFileSync(join(home, ".config/catalyst-cloud/replica.db-wal"), "utf8")).toBe("saved WAL");
  });

  test("--remove --data previews and removes only local sync files after one confirmation", async () => {
    const login = JSON.stringify({ account: "tenant-a", baseUrl: "https://example.test", key: "fixture", lastSkillBundleVersion: readManifest().version });
    write(".config/catalyst-cloud/customer.json", login);
    write(".config/catalyst-cloud/contract.json", "saved contract");
    write(".config/catalyst/settings.json", "saved settings");
    const localFiles = [
      ".config/catalyst-cloud/replica.db",
      ".config/catalyst-cloud/replica.db-wal",
      ".config/catalyst-cloud/replica.db.writer.lock",
      ".config/catalyst-cloud/replica.db.writer.state",
      ".local/state/catalyst/events/tenant-a/backbone/cursor.json",
      ".local/state/catalyst/events/tenant-a/backbone/2026-10-04.jsonl",
    ];
    for (const file of localFiles) write(file, "local cache bytes");
    write("Library/LaunchAgents/ai.coalesce.catalyst-replica-sync.plist", "old replica writer");
    let confirmations = 0;
    expect(await main(["legacy", "--remove", "--data"], ctx, deps({
      isTty: () => true,
      prompt: async () => {
        confirmations++;
        expect(calls).toEqual([]);
        for (const file of localFiles) {
          expect(existsSync(join(home, file))).toBe(true);
          expect(ctx.out.join("\n")).toContain(join(home, file));
        }
        expect(ctx.out.join("\n")).toContain("17 bytes");
        return "yes";
      },
    }))).toBe(0);
    expect(confirmations).toBe(1);
    expect(calls).toContain("launchctl bootout gui/501/ai.coalesce.catalyst-replica-sync");
    for (const file of localFiles) expect(existsSync(join(home, file))).toBe(false);
    expect(readFileSync(join(home, ".config/catalyst-cloud/customer.json"), "utf8")).toBe(login);
    expect(readFileSync(join(home, ".config/catalyst-cloud/contract.json"), "utf8")).toBe("saved contract");
    expect(readFileSync(join(home, ".config/catalyst/settings.json"), "utf8")).toBe("saved settings");
  });

  test.each([
    { argv: ["legacy"] },
    { argv: ["legacy", "--remove"] },
    { argv: ["legacy", "--remove", "--yes", "--data"] },
  ])(
    "does not label fresh shared roots as old or ask to remove them: %j",
    async ({ argv }) => {
      const roots = [
        ".catalyst",
        ".config/catalyst",
        ".local/state/catalyst",
        ".local/state/catalyst-fleet-runner",
        ".local/state/catalyst-ledger",
      ];
      for (const root of roots)
        write(`${root}/customer-content`, "preserve exact bytes");
      let prompts = 0;
      expect(
        await main(
          [...argv, "--json"],
          ctx,
          deps({
            isTty: () => true,
            prompt: async () => {
              prompts++;
              throw new Error("no legacy cleanup to approve");
            },
          }),
        ),
      ).toBe(0);
      const doc = JSON.parse(ctx.out[0]!);
      expect(doc).toMatchObject({ found: [], removed: [], remaining: [] });
      expect(doc.kept).toHaveLength(5);
      expect(prompts).toBe(0);
      expect(calls).toEqual([]);
      for (const root of roots)
        expect(readFileSync(join(home, root, "customer-content"), "utf8")).toBe(
          "preserve exact bytes",
        );
    },
  );
  test("plain output distinguishes current data while positively identifying a real legacy file", async () => {
    write(".local/state/catalyst/install/log", "current installer state");
    expect(await main(["legacy"], ctx, deps())).toBe(0);
    expect(ctx.out.join("\n")).not.toContain(
      "Leftovers of the old local Catalyst runtime on this machine (",
    );
    expect(ctx.out.join("\n")).toContain(
      "shared current Catalyst data folders are present and kept",
    );
    ctx.out.length = 0;
    write(".local/bin/catalyst-hud", "old executable");
    expect(await main(["legacy"], ctx, deps())).toBe(1);
    expect(ctx.out.join("\n")).toContain(
      "Leftovers of the old local Catalyst runtime on this machine (1)",
    );
    expect(ctx.out.join("\n")).toContain("bin: ~/.local/bin/catalyst-hud");
    expect(calls).toEqual([]);
  });
});

describe("detection", () => {
  test("lists each old piece by kind, name and path; the current plugin, current jobs, other files and current config are never listed", async () => {
    oldMachine();
    expect(await main(["legacy", "--json"], ctx, deps())).toBe(1);
    const doc = JSON.parse(ctx.out[0]!) as {
      found: { kind: string; name: string; path: string; data?: boolean }[];
    };
    const names = doc.found.map((f) => `${f.kind}:${f.name}`);
    expect(names).toEqual([
      "plugin:catalyst-dev@catalyst",
      "plugin:catalyst-pm-ops@catalyst",
      "marketplace:catalyst",
      "job:com.catalyst.agent",
      "job:com.catalyst.role.concierge",
      "bin:~/.local/bin/catalyst-hud",
      "data:~/.catalyst",
      "data:~/.config/catalyst",
      "data:~/.local/state/catalyst-ledger",
    ]);
    expect(doc.found.filter((f) => f.data).map((f) => f.name)).toEqual([
      "~/.catalyst",
      "~/.config/catalyst",
      "~/.local/state/catalyst-ledger",
    ]);
    expect(doc.found.find((f) => f.kind === "job")!.path).toBe(
      join(home, "Library", "LaunchAgents", "com.catalyst.agent.plist"),
    );
    expect(calls).toEqual([]);
    ctx.out.length = 0;
    expect(await main(["legacy"], ctx, deps())).toBe(1);
    const text = ctx.out.join("\n");
    expect(ctx.out[0]).toBe(
      "Leftovers of the old local Catalyst runtime on this machine (6):",
    );
    expect(text).toContain("  plugin: catalyst-dev@catalyst");
    expect(text).toContain("  job: com.catalyst.agent — ");
    expect(text).toContain(
      "  data: ~/.config/catalyst (kept: shared current state)",
    );
    expect(text).toMatch(
      /Remove them: the cloud runtime replaced them, and left in place they can start old jobs or shadow current commands\./,
    );
    expect(text).toContain("catalyst legacy --remove");
    expect(text).not.toContain("housekeeping");
    expect(text).not.toContain("catalyst-dev-skills");
  });

  test("on linux the jobs are user units from the fixed list, and launchd is never consulted", async () => {
    write(".config/systemd/user/catalyst-monitor.service", "[Unit]");
    write(".config/systemd/user/herdr-server.service", "[Unit]");
    write("Library/LaunchAgents/com.catalyst.agent.plist", "<plist/>");
    expect(
      await main(["legacy", "--json"], ctx, deps({ platform: "linux" })),
    ).toBe(1);
    const doc = JSON.parse(ctx.out[0]!) as {
      found: { kind: string; name: string }[];
    };
    expect(doc.found.map((f) => `${f.kind}:${f.name}`)).toEqual([
      "job:catalyst-monitor.service",
    ]);
  });
});

describe("removal", () => {
  test("--remove without a terminal and without --yes removes nothing and says how to", async () => {
    oldMachine();
    expect(await main(["legacy", "--remove"], ctx, deps())).toBe(1);
    expect(calls).toEqual([]);
    expect(
      existsSync(
        join(home, "Library", "LaunchAgents", "com.catalyst.agent.plist"),
      ),
    ).toBe(true);
    expect(ctx.out.at(-1)).toBe(
      "nothing removed: no terminal to ask on; run catalyst legacy --remove --yes to remove these without a question (all data folders are kept)",
    );
  });

  test("--remove --yes removes plugins, then the marketplace, jobs and bins through their own tools, keeps data, re-checks and exits 0", async () => {
    oldMachine();
    expect(await main(["legacy", "--remove", "--yes"], ctx, deps())).toBe(0);
    expect(calls).toEqual([
      "claude plugin uninstall catalyst-dev@catalyst",
      "claude plugin uninstall catalyst-pm-ops@catalyst",
      "claude plugin marketplace remove catalyst",
      "launchctl bootout gui/501/com.catalyst.agent",
      "launchctl bootout gui/501/com.catalyst.role.concierge",
    ]);
    expect(
      existsSync(
        join(home, "Library", "LaunchAgents", "com.catalyst.agent.plist"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          home,
          "Library",
          "LaunchAgents",
          "com.catalyst.role.concierge.plist",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          home,
          "Library",
          "LaunchAgents",
          "dev.catalystcloud.housekeeping.plist",
        ),
      ),
    ).toBe(true);
    expect(existsSync(join(home, ".catalyst", "bin"))).toBe(true);
    expect(existsSync(join(home, ".local", "bin", "catalyst-hud"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "catalyst"))).toBe(true);
    expect(existsSync(join(home, ".config", "catalyst", "config.json"))).toBe(
      true,
    );
    expect(registry().plugins).toHaveProperty(
      "catalyst-dev@catalyst-dev-skills",
    );
    const text = ctx.out.join("\n");
    expect(text).toContain("removed: plugin catalyst-dev@catalyst");
    expect(text).toContain("removed: job com.catalyst.agent");
    expect(text).toContain(
      "kept: data ~/.config/catalyst (shared current state; always kept)",
    );
    expect(ctx.out.at(-1)).toBe(
      "re-checked: nothing of the old runtime remains; all shared data folders were kept",
    );
  });

  test("--remove --yes --data always keeps shared data folders and current config", async () => {
    oldMachine();
    expect(
      await main(["legacy", "--remove", "--yes", "--data"], ctx, deps()),
    ).toBe(0);
    expect(existsSync(join(home, ".config", "catalyst"))).toBe(true);
    expect(existsSync(join(home, ".local", "state", "catalyst-ledger"))).toBe(
      true,
    );
    expect(
      existsSync(join(home, ".config", "catalyst-cloud", "customer.json")),
    ).toBe(true);
    expect(ctx.out.at(-1)).toBe(
      "re-checked: nothing of the old runtime remains; all shared data folders were kept",
    );
  });

  test("a tool that fails leaves the item reported as still present, exit 1, and nothing else is skipped", async () => {
    oldMachine();
    failing.add("launchctl bootout gui/501/com.catalyst.agent");
    expect(await main(["legacy", "--remove", "--yes"], ctx, deps())).toBe(1);
    const text = ctx.out.join("\n");
    expect(text).toContain(
      "still present: job com.catalyst.agent (launchctl bootout failed: boom. Check launchctl print",
    );
    expect(
      existsSync(
        join(home, "Library", "LaunchAgents", "com.catalyst.agent.plist"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          home,
          "Library",
          "LaunchAgents",
          "com.catalyst.role.concierge.plist",
        ),
      ),
    ).toBe(false);
    expect(ctx.out.at(-1)).toMatch(
      /^re-checked: 1 item of the old runtime remains/,
    );
  });

  test("an already-unloaded owned job is retired only after a positive scheduler-domain probe", async () => {
    oldMachine();
    const absentRun: LegacyRun = (cmd, args) => {
      if (cmd === "launchctl" && args[0] === "bootout" && args[1] === "gui/501/com.catalyst.agent")
        return { status: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" };
      if (cmd === "launchctl" && args[0] === "print" && args[1] === "gui/501/com.catalyst.agent")
        return { status: 113, stdout: "", stderr: 'Could not find service "com.catalyst.agent" in domain for user gui: 501' };
      return run(cmd, args);
    };
    expect(await main(["legacy", "--remove", "--yes"], ctx, deps({ run: absentRun }))).toBe(0);
    expect(existsSync(join(home, "Library/LaunchAgents/com.catalyst.agent.plist"))).toBe(false);
    expect(calls).toContain("launchctl print gui/501");
    expect(existsSync(join(home, "Library/LaunchAgents/dev.catalystcloud.housekeeping.plist"))).toBe(true);
    expect(existsSync(join(home, ".config/catalyst/config.json"))).toBe(true);
    expect(await main(["legacy", "--remove", "--yes"], ctx, deps({ run: absentRun }))).toBe(0);
  });

  test("an absent-service message with an inaccessible domain keeps the owned plist", async () => {
    oldMachine();
    const refusedRun: LegacyRun = (cmd, args) => {
      if (cmd === "launchctl" && args[0] === "bootout" && args[1] === "gui/501/com.catalyst.agent")
        return { status: 3, stdout: "", stderr: "No such process" };
      if (cmd === "launchctl" && args[0] === "print")
        return args[1] === "gui/501"
          ? { status: 1, stdout: "", stderr: "Operation not permitted" }
          : { status: 113, stdout: "", stderr: "Could not find service" };
      return run(cmd, args);
    };
    expect(await main(["legacy", "--remove", "--yes"], ctx, deps({ run: refusedRun }))).toBe(1);
    expect(existsSync(join(home, "Library/LaunchAgents/com.catalyst.agent.plist"))).toBe(true);
    expect(ctx.out.join("\n")).toContain("Check launchctl print gui/501/com.catalyst.agent");
  });

  test("on a terminal, --remove asks once; no removes nothing, yes removes", async () => {
    oldMachine();
    const answers: string[] = ["n"];
    const prompt = async (q: string) => {
      expect(q).toContain("Remove");
      return answers.shift() ?? "";
    };
    expect(
      await main(
        ["legacy", "--remove"],
        ctx,
        deps({ isTty: () => true, prompt }),
      ),
    ).toBe(1);
    expect(calls).toEqual([]);
    expect(ctx.out.at(-1)).toContain("nothing removed");
    answers.push("y");
    ctx.out.length = 0;
    expect(
      await main(
        ["legacy", "--remove"],
        ctx,
        deps({ isTty: () => true, prompt }),
      ),
    ).toBe(0);
    expect(calls.length).toBe(5);
  });

  test("on linux, --remove --yes disables the user unit and removes its file", async () => {
    write(".config/systemd/user/catalyst-monitor.service", "[Unit]");
    expect(
      await main(
        ["legacy", "--remove", "--yes"],
        ctx,
        deps({ platform: "linux" }),
      ),
    ).toBe(0);
    expect(calls).toEqual([
      "systemctl --user disable --now catalyst-monitor.service",
    ]);
    expect(
      existsSync(
        join(home, ".config", "systemd", "user", "catalyst-monitor.service"),
      ),
    ).toBe(false);
  });
});

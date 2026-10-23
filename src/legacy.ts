// legacy.ts — `catalyst legacy`: leftovers of the old LOCAL Catalyst runtime (the archived repository
// whose plugin, daemons, scheduled jobs and state folders a machine may still carry), found from a
// FIXED list and removed only on a yes, through the tools that own each piece. The cloud runtime
// replaced all of it; what is left can start old jobs or shadow current commands, so removal is
// recommended, and never automatic: a run with no terminal and no --yes only reports.
//
// The list is fixed on purpose. A prefix match would one day catch a current job (the housekeeping
// job, the sandbox credit guard, jobs a person made); this matches names the old runtime installed,
// read at the source commit below, and nothing else. Shared data folders are always kept;
// --data separately selects the enumerated replica and event-cache files.
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { flagBool, positionals, type ParsedArgs } from "./args.js";
import type { Ctx } from "./config.js";
import { UsageError } from "./errors.js";
import { promptSecret, stdinIsTty } from "./prompt.js";
import { findLocalSyncData, localSyncInventory, removeLocalSyncData, type LocalSyncFile } from "./local-sync-data.js";

/** The archived repository's commit the list below was read at. */
export const LEGACY_SOURCE_COMMIT = "73bc0645252ce8be38f8c87be6b67b950b3f0b56";
/** The old runtime's marketplace source, as Claude Code records it in known_marketplaces.json. */
export const OLD_MARKETPLACE_REPO = "coalesce-labs/catalyst";
const OLD_REPLICA_LABEL = "ai.coalesce.catalyst-replica-sync";
/** launchd labels the old runtime installed under ~/Library/LaunchAgents (macOS). `com.catalyst.role.<name>`
 *  is the old role supervisor's per-role instance, matched by that exact prefix. Never `dev.catalystcloud.*`
 *  (the current housekeeping job and runner jobs) and never `dev.catalyst.*` (the sandbox credit guard). */
export const OLD_LAUNCHD_LABELS: readonly string[] = [
  "com.catalyst.agent",
  "com.catalyst.reaper-watch",
  "com.catalyst.quiet-fleet",
  "com.catalyst.dead-man",
  "com.catalyst.holding-sentinel",
  "com.catalyst.orch-monitor",
  "com.catalyst.role",
  "ai.coalesce.catalyst-stack",
  "ai.coalesce.catalyst-thoughts-sync",
  "ai.coalesce.catalyst-orphan-sweep",
  "ai.coalesce.catalyst-log-shipper",
  "ai.coalesce.catalyst-cloud-sync",
  "ai.coalesce.catalyst-usage-page",
  "ai.coalesce.catalyst-claude-update",
  "ai.coalesce.catalyst-updater",
  OLD_REPLICA_LABEL,
  "ai.coalesce.catalyst-channel-watcher",
  "ai.coalesce.catalyst-event-mirror",
  "ai.coalesce.catalyst-monitor",
];
const OLD_ROLE_PREFIX = "com.catalyst.role.";
/** systemd user units (~/.config/systemd/user) the old runtime's workstation pieces used on Linux. System
 *  units under /etc/systemd/system are a host's, current, and never looked at. */
export const OLD_USER_UNITS: readonly string[] = [
  "catalyst.service",
  "catalyst-monitor.service",
];
/** Command files the old runtime put on the person's PATH. `~/.local/bin/catalyst` is NOT one: that
 *  name belongs to the current CLI wherever npm put it. */
export const OLD_BINS: readonly string[] = [
  ".local/bin/catalyst-events",
  ".local/bin/catalyst-filter",
  ".local/bin/catalyst-hud",
  ".local/bin/catalyst-monitor",
  ".local/bin/catalyst-myown",
];
/** Shared roots also hold current skills, logs, hosts and seats. Never remove these directories. */
export const OLD_DATA_DIRS: readonly string[] = [
  ".catalyst",
  ".config/catalyst",
  ".local/state/catalyst",
  ".local/state/catalyst-fleet-runner",
  ".local/state/catalyst-ledger",
];

export type LegacyKind = "plugin" | "marketplace" | "job" | "bin" | "data";
export interface LegacyItem {
  kind: LegacyKind;
  /** What a person recognises: `name@marketplace`, a label, a unit, or a ~-relative path. */
  name: string;
  path: string;
  /** A shared data folder: always kept. */
  data?: boolean;
  localSync?: boolean;
  size?: number;
}
export type LegacyRun = (
  cmd: string,
  args: string[],
) => { status: number; stdout: string; stderr: string };
export interface LegacyDeps {
  /** Setup with local sync reuses the existing replica. */
  preserveReplica?: boolean;
  /** Process boundary: stop a detached writer and wait for it to exit. */
  stopWriter?: (pid: number) => Promise<void>;
  /** Setup pins the precise file inventory approved by the person. */
  localSyncFiles?: readonly LocalSyncFile[];
  run?: LegacyRun;
  platform?: NodeJS.Platform;
  uid?: number;
  isTty?: () => boolean;
  prompt?: (question: string) => Promise<string>;
}

const RECOMMEND =
  "Remove them: the cloud runtime replaced them, and left in place they can start old jobs or shadow current commands.";

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v !== null && typeof v === "object"
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Marketplaces whose recorded source is the old repository, and the plugins installed from them. */
function findPlugins(home: string): LegacyItem[] {
  const dir = join(home, ".claude", "plugins");
  const marketplaces = readJson(join(dir, "known_marketplaces.json")) ?? {};
  const old = Object.entries(marketplaces)
    .filter(([, v]) => {
      const src = (v as { source?: { repo?: string } } | null)?.source;
      return (
        typeof src?.repo === "string" &&
        src.repo.toLowerCase() === OLD_MARKETPLACE_REPO
      );
    })
    .map(([name]) => name);
  if (old.length === 0) return [];
  const installed =
    (
      (readJson(join(dir, "installed_plugins.json")) ?? {}) as {
        plugins?: Record<string, unknown>;
      }
    ).plugins ?? {};
  const items: LegacyItem[] = [];
  for (const key of Object.keys(installed)) {
    const at = key.lastIndexOf("@");
    if (at > 0 && old.includes(key.slice(at + 1)))
      items.push({
        kind: "plugin",
        name: key,
        path: join(dir, "installed_plugins.json"),
      });
  }
  for (const name of old)
    items.push({
      kind: "marketplace",
      name,
      path: join(dir, "known_marketplaces.json"),
    });
  return items;
}

function findJobs(home: string, platform: NodeJS.Platform): LegacyItem[] {
  if (platform === "darwin") {
    const dir = join(home, "Library", "LaunchAgents");
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      return [];
    }
    return files
      .filter((f) => f.endsWith(".plist"))
      .map((f) => f.slice(0, -".plist".length))
      .filter(
        (label) =>
          OLD_LAUNCHD_LABELS.includes(label) ||
          label.startsWith(OLD_ROLE_PREFIX),
      )
      .sort()
      .map((label) => ({
        kind: "job" as const,
        name: label,
        path: join(dir, `${label}.plist`),
        ...(label === OLD_REPLICA_LABEL || label === "ai.coalesce.catalyst-event-mirror"
          ? { localSync: true, size: lstatSync(join(dir, `${label}.plist`)).size }
          : {}),
      }));
  }
  if (platform === "linux") {
    const dir = join(home, ".config", "systemd", "user");
    return OLD_USER_UNITS.filter((u) => existsSync(join(dir, u))).map((u) => ({
      kind: "job" as const,
      name: u,
      path: join(dir, u),
    }));
  }
  return [];
}

const tilde = (rel: string) => `~/${rel}`;
function findFiles(home: string): LegacyItem[] {
  const bins = OLD_BINS.filter((rel) => existsSync(join(home, rel))).map(
    (rel) => ({
      kind: "bin" as const,
      name: tilde(rel),
      path: join(home, rel),
    }),
  );
  const data = OLD_DATA_DIRS.filter((rel) => existsSync(join(home, rel))).map(
    (rel) => ({
      kind: "data" as const,
      name: tilde(rel),
      path: join(home, rel),
      data: true,
    }),
  );
  return [...bins, ...data];
}

/** Every old piece on this machine, in removal order: plugins, their marketplace, jobs, bins, data. Never writes. */
export function findLegacy(
  home: string,
  platform: NodeJS.Platform,
  options: Pick<LegacyDeps, "preserveReplica"> = {},
): LegacyItem[] {
  return [
    ...findPlugins(home),
    ...findJobs(home, platform),
    ...findFiles(home),
  ].filter(
    (item) =>
      !(options.preserveReplica && "localSync" in item && item.localSync),
  );
}

const defaultRun: LegacyRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000 });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.error ? r.error.message : (r.stderr ?? ""),
  };
};

/** Remove one item through the tool that owns it. Returns null on success, else the reason it is still there. */
function remove(
  item: LegacyItem,
  run: LegacyRun,
  platform: NodeJS.Platform,
  uid: number,
): string | null {
  const tool = (cmd: string, args: string[], what: string): string | null => {
    const r = run(cmd, args);
    return r.status === 0
      ? null
      : `${what} failed: ${(r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.status}`}`;
  };
  try {
    if (item.kind === "plugin")
      return tool(
        "claude",
        ["plugin", "uninstall", item.name],
        "claude plugin uninstall",
      );
    if (item.kind === "marketplace")
      return tool(
        "claude",
        ["plugin", "marketplace", "remove", item.name],
        "claude plugin marketplace remove",
      );
    if (item.kind === "job") {
      const why =
        platform === "darwin"
          ? tool(
              "launchctl",
              ["bootout", `gui/${uid}/${item.name}`],
              "launchctl bootout",
            )
          : tool(
              "systemctl",
              ["--user", "disable", "--now", item.name],
              "systemctl --user disable --now",
            );
      if (why !== null) {
        if (platform !== "darwin") return why;
        // A nonzero bootout may mean the exact owned service was already unloaded.
        // Prove the scheduler domain works before interpreting its absence response.
        const domain = run("launchctl", ["print", `gui/${uid}`]);
        const service = run("launchctl", ["print", `gui/${uid}/${item.name}`]);
        if (
          domain.status !== 0 ||
          service.status !== 113 ||
          !/could not find service|could not find specified service/i.test(service.stderr || service.stdout)
        ) return `${why}. Check launchctl print gui/${uid}/${item.name}, fix the reported scheduler error, then run catalyst legacy --remove.`;
      }
      unlinkSync(item.path);
      return null;
    }
    // CTC-4496: even explicit --data cannot delete shared roots. Unknown directories stay too.
    if (item.data || lstatSync(item.path).isDirectory())
      return "directory kept; shared data is protected";
    unlinkSync(item.path);
    return null;
  } catch (err) {
    return `could not remove: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function cmdLegacy(
  args: ParsedArgs,
  ctx: Ctx,
  deps: LegacyDeps = {},
): Promise<number> {
  if (positionals(args).length > 0)
    throw new UsageError(
      "legacy takes no positional argument; flags are --remove, --data, --yes, --json",
    );
  const wantRemove = flagBool(args, "remove");
  const withData = flagBool(args, "data");
  if (withData && !wantRemove)
    throw new UsageError("--data belongs with --remove");
  const platform = deps.platform ?? process.platform;
  const uid =
    deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const run = deps.run ?? defaultRun;
  const local = deps.preserveReplica ? [] : deps.localSyncFiles ?? await findLocalSyncData(ctx);
  const found: LegacyItem[] = [...findLegacy(ctx.home, platform, deps), ...local];
  const legacy = found.filter((item) => !item.data && (item.kind === "job" || !item.localSync || withData));
  const shared = found.filter((item) => item.data);
  const emit = (body: Record<string, unknown>, lines: string[]) => {
    if (args.json) ctx.stdout(JSON.stringify(body));
    else for (const l of lines) ctx.stdout(l);
  };
  const inventory = localSyncInventory(local);
  if (legacy.length === 0) {
    emit(
      {
        sourceCommit: LEGACY_SOURCE_COMMIT,
        found: local,
        removed: [],
        remaining: [],
        kept: [...shared, ...local],
        ...(local.length ? { requiredFlag: "--remove --data", localSyncFiles: local } : {}),
      },
      [
        "no leftovers of the old local Catalyst runtime on this machine",
        ...(shared.length
          ? ["shared current Catalyst data folders are present and kept"]
          : []),
        ...inventory,
        ...(local.length ? ["Local sync data kept. Run catalyst legacy --remove --data to review and remove it."] : []),
      ],
    );
    return local.length && !wantRemove ? 1 : 0;
  }
  const listLines = [
    `Leftovers of the old local Catalyst runtime on this machine (${legacy.length}):`,
    ...legacy.map(
      (f) => `  ${f.kind}: ${f.name}${f.kind === "job" ? ` — ${f.path} (${lstatSync(f.path).size} bytes)` : ""}`,
    ),
    ...inventory,
    ...(shared.length
      ? [
          "Shared current data folders (kept):",
          ...shared.map(
            (f) => `  ${f.kind}: ${f.name} (kept: shared current state)`,
          ),
        ]
      : []),
  ];
  if (!wantRemove) {
    emit(
      {
        sourceCommit: LEGACY_SOURCE_COMMIT,
        found,
        removed: [],
        remaining: found,
      },
      [
        ...listLines,
        RECOMMEND,
        "Run: catalyst legacy --remove (all data folders are kept)",
      ],
    );
    return 1;
  }
  // the one question, only on a terminal; --yes answers it without asking
  let go = flagBool(args, "yes");
  if (!go) {
    const tty = (deps.isTty ?? stdinIsTty)();
    if (!tty) {
      emit(
        {
          sourceCommit: LEGACY_SOURCE_COMMIT,
          found,
          removed: [],
          remaining: found,
          asked: false,
        },
        [
          ...listLines,
          RECOMMEND,
          withData
            ? "nothing removed: no terminal to ask on; run catalyst legacy --remove --data --yes to remove the listed local sync files (login, contract, settings and shared data folders are kept)"
            : "nothing removed: no terminal to ask on; run catalyst legacy --remove --yes to remove these without a question (all data folders are kept)",
        ],
      );
      return 1;
    }
    for (const l of listLines) ctx.stdout(l);
    ctx.stdout(RECOMMEND);
    const answer = (
      await (deps.prompt ?? ((q: string) => promptSecret(q)))(
        `Remove ${legacy.length} item${legacy.length === 1 ? "" : "s"}${withData && local.length ? ", including the listed local sync files" : ", keeping all data folders"}? [y/N] `,
      )
    )
      .trim()
      .toLowerCase();
    go = answer === "y" || answer === "yes";
    if (!go) {
      emit(
        {
          sourceCommit: LEGACY_SOURCE_COMMIT,
          found,
          removed: [],
          remaining: found,
          asked: true,
        },
        ["nothing removed; run catalyst legacy --remove again when ready"],
      );
      return 1;
    }
  }
  const removed: LegacyItem[] = [];
  const failed: { item: LegacyItem; why: string }[] = [];
  const kept: LegacyItem[] = [];
  const lines: string[] = [];
  for (const item of found) {
    if (item.localSync && item.kind === "data") {
      if (!withData) kept.push(item);
      continue;
    }
    if (item.data) {
      kept.push(item);
      lines.push(
        `kept: ${item.kind} ${item.name} (shared current state; always kept)`,
      );
      continue;
    }
    const why = remove(item, run, platform, uid);
    if (why === null) {
      removed.push(item);
      lines.push(`removed: ${item.kind} ${item.name}`);
    } else {
      failed.push({ item, why });
      lines.push(`still present: ${item.kind} ${item.name} (${why})`);
    }
  }
  if (withData && local.length) {
    try {
      if (failed.some(({ item }) => item.name === OLD_REPLICA_LABEL || item.name === "ai.coalesce.catalyst-event-mirror"))
        throw new Error("local sync service did not stop; local data kept");
      await removeLocalSyncData(local, deps.stopWriter);
      removed.push(...local);
      lines.push(...local.map((item) => `removed: local sync data ${item.path}`));
    } catch (error) {
      kept.push(...local);
      failed.push({ item: local[0], why: error instanceof Error ? error.message : String(error) });
      lines.push("local sync cleanup failed; remaining local data kept");
    }
  }
  // re-check from the same list, so the report says what the machine holds now, not what was attempted
  const remaining = [
    ...findLegacy(ctx.home, platform, deps).filter((f) => !f.data),
    ...(withData ? await findLocalSyncData(ctx) : []),
  ];
  const keptNote = kept.length > 0 ? "; all shared data folders were kept" : "";
  lines.push(
    remaining.length === 0
      ? `re-checked: nothing of the old runtime remains${keptNote}`
      : `re-checked: ${remaining.length} item${remaining.length === 1 ? "" : "s"} of the old runtime remain${remaining.length === 1 ? "s" : ""}${keptNote}: ${remaining.map((r) => `${r.kind} ${r.name}`).join(", ")}`,
  );
  emit(
    {
      sourceCommit: LEGACY_SOURCE_COMMIT,
      found,
      removed,
      remaining: [...remaining, ...kept],
      kept,
      failed,
    },
    lines,
  );
  return remaining.length === 0 && failed.length === 0 ? 0 : 1;
}

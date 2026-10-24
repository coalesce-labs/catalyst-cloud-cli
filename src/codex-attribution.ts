// codex-attribution.ts: the launch hooks `catalyst setup` installs around `catalyst codex-env`, so
// every Codex launch on this machine names the coding account it runs as.
//
//   A terminal launch: one marked block in ~/.zshrc and ~/.bashrc defines a `codex` function. It asks
//   `catalyst codex-env --print` about the Codex home in effect and exports the answer for that one
//   call only.
//   A Dock launch (macOS): the dev.catalystcloud.codex-attribution LaunchAgent runs
//   `catalyst codex-env --apply` at login and whenever the default Codex home's login file changes.
//
// Which rc files: ~/.zshrc ($ZDOTDIR/.zshrc when ZDOTDIR is set) and ~/.bashrc, each only when it
// exists or is the rc file of the login shell ($SHELL). A zsh-only Mac never gains a ~/.bashrc.
// A file that defines `codex` itself (a function or an alias outside the block) is never written,
// and neither is a link to a file outside the home folder. Files are read and written as latin1, so
// every byte outside the block survives exactly, CRLF included.
//
// Nothing is installed when Codex is not on this computer (codexPresence); a later run adds it.
//
// Removal puts each file back byte for byte: the block records inside itself whether setup created
// the file or added a line break before it. It unloads and deletes the agent, and takes back out of
// the launch environment exactly the two attributes `--apply` sets (`codex-env --apply` keeps every
// other pair already there, so removal does too).
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { userInfo } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { ParsedArgs } from "./args.js";
import {
  ACCOUNT_SLOT_ATTRIBUTE,
  HOST_NAME_ATTRIBUTE,
  attrValue,
  defaultCodexHome,
  NO_LOGIN_SLOT,
  readCodexAccountId,
  readCodexAccountsCache,
  resolveSlot,
  UNREGISTERED_SLOT,
} from "./codex-env.js";
import { hasOtel, maskedOtel, otelTables, withOtel, withoutOtel } from "./codex-otel.js";
import { configDirFor, loadConfig, type Ctx } from "./config.js";
import {
  defaultRun,
  scheduledPath,
  writeFileAtomic,
  xml,
  type SchedulerRun,
} from "./runner-auto-update.js";

export const CODEX_ATTRIBUTION_LABEL = "dev.catalystcloud.codex-attribution";
export const BLOCK_BEGIN = "# >>> catalyst codex attribution >>>";
export const BLOCK_END = "# <<< catalyst codex attribution <<<";
/** Written into the block when setup created the file for it, so removal deletes the file again. */
export const CREATED_NOTE =
  "# (setup created this file for the block; removing the block deletes the file)";
/** Written when the file did not end in a line break, so removal takes back the one setup added. */
export const NEWLINE_NOTE =
  "# (setup added the line break before this block; removing the block takes it back)";
const ENV_NAME = "OTEL_RESOURCE_ATTRIBUTES";

export interface CodexAttributionDeps {
  platform?: NodeJS.Platform;
  /** Process boundary for `launchctl`, so tests use a fake. */
  run?: SchedulerRun;
  uid?: number;
  /** The catalyst launcher the agent runs: the one running now, as the runner update agent records it. */
  cli?: string;
  /** PATH for the agent's run: it must find node. */
  path?: string;
  /** This account's own home folder. Under any other HOME, setup leaves rc files and launchd alone. */
  realHome?: () => string;
  /** Where a Codex desktop app may be installed (default: /Applications and ~/Applications). */
  applicationDirs?: string[];
  /** The rc writes and the deletions; tests inject a failing write or record the order. */
  files?: Partial<FileOps>;
}

export interface FileOps {
  writeFile: (
    path: string,
    data: string | Buffer,
    options: { mode: number },
  ) => void;
  rename: (from: string, to: string) => void;
  unlink: (path: string) => void;
}

const defaultFileOps: FileOps = {
  writeFile: (path, data, options) => writeFileSync(path, data, options),
  rename: renameSync,
  unlink: unlinkSync,
};

const fileOps = (deps: CodexAttributionDeps): FileOps => ({
  ...defaultFileOps,
  ...deps.files,
});

/** A temp file beside the target with the target's mode set past the umask, then a rename over the
 *  target (never over a link that names it). A failure removes the temp file, so the target is
 *  either as it was or wholly new. */
export function writeRcAtomic(
  path: string,
  data: string | Buffer,
  mode: number,
  ops: FileOps = defaultFileOps,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    ops.writeFile(temp, data, { mode });
    chmodSync(temp, mode);
    ops.rename(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file was never created.
    }
    throw err;
  }
}

/** The desktop app's bundle name. */
export const CODEX_APP_BUNDLE = "Codex.app";

/** The block, always ending in one line break. The function runs the real codex with `command`. */
export function codexBlock(
  notes: { created?: boolean; newlineAdded?: boolean } = {},
): string {
  return [
    BLOCK_BEGIN,
    ...(notes.created ? [CREATED_NOTE] : []),
    ...(notes.newlineAdded ? [NEWLINE_NOTE] : []),
    "# Added by catalyst setup: each codex launch names the coding account it runs as.",
    "# Remove it with: catalyst setup --remove-codex-attribution",
    "function codex {",
    "  local catalyst_attributes",
    '  catalyst_attributes="$(command catalyst codex-env --print --codex-home "${CODEX_HOME:-$HOME/.codex}" 2>/dev/null)" || catalyst_attributes=""',
    '  if [ -n "$catalyst_attributes" ]; then',
    '    OTEL_RESOURCE_ATTRIBUTES="$catalyst_attributes" command codex "$@"',
    "  else",
    '    command codex "$@"',
    "  fi",
    "}",
    BLOCK_END,
    "",
  ].join("\n");
}

interface Line {
  start: number;
  /** Just past the line's own line break, or the end of the text. */
  end: number;
  /** The line without its line break (`\n` or `\r\n`). */
  text: string;
}

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl + 1;
    out.push({
      start,
      end,
      text: text.slice(start, nl === -1 ? end : nl).replace(/\r$/, ""),
    });
    start = end;
  }
  return out;
}

export interface Block {
  start: number;
  end: number;
  created: boolean;
  newlineAdded: boolean;
}

/** Every complete block in order, or "malformed" when a marker has no partner. */
export function findBlocks(text: string): Block[] | "malformed" {
  const blocks: Block[] = [];
  let open: { start: number; notes: Set<string> } | null = null;
  for (const line of linesOf(text)) {
    if (open === null) {
      if (line.text === BLOCK_BEGIN)
        open = { start: line.start, notes: new Set() };
      else if (line.text === BLOCK_END) return "malformed";
      continue;
    }
    if (line.text === BLOCK_BEGIN) return "malformed";
    if (line.text === BLOCK_END) {
      blocks.push({
        start: open.start,
        end: line.end,
        created: open.notes.has(CREATED_NOTE),
        newlineAdded: open.notes.has(NEWLINE_NOTE),
      });
      open = null;
      continue;
    }
    open.notes.add(line.text);
  }
  return open === null ? blocks : "malformed";
}

function outsideBlocks(text: string, blocks: readonly Block[]): string {
  let out = "";
  let cursor = 0;
  for (const b of blocks) {
    out += text.slice(cursor, b.start);
    cursor = b.end;
  }
  return out + text.slice(cursor);
}

/** `alias codex=…` (zsh's `alias -g` too), `codex()` and `function codex`. Never `codex_helper` or a comment. */
const CODEX_DEFINITIONS = [
  /^\s*alias(?:\s+-\S+)*\s+(?:\S+\s+)*codex=/,
  /^\s*function\s+codex(?:\s*\(\s*\))?(?=[\s{]|$)/,
  /^\s*codex\s*\(\s*\)/,
];

export function definesCodex(text: string): boolean {
  return linesOf(text).some(
    ({ text: line }) =>
      !/^\s*#/.test(line) && CODEX_DEFINITIONS.some((re) => re.test(line)),
  );
}

export interface RcFile {
  shell: "zsh" | "bash";
  path: string;
  /** The file exists (a link counts), or it belongs to the login shell, so setup may create it. */
  wanted: boolean;
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function shellRcFiles(ctx: Ctx): RcFile[] {
  const zdot = ctx.env.ZDOTDIR?.trim();
  const login = basename(ctx.env.SHELL?.trim() ?? "");
  const files: [RcFile["shell"], string][] = [
    ["zsh", join(zdot && isAbsolute(zdot) ? zdot : ctx.home, ".zshrc")],
    ["bash", join(ctx.home, ".bashrc")],
  ];
  return files.map(([shell, path]) => ({
    shell,
    path,
    wanted: present(path) || login === shell,
  }));
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function inside(path: string, home: string): boolean {
  const rel = relative(realOr(home), path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function sameHome(a: string, b: string): boolean {
  return realOr(a) === realOr(b);
}

/** Whether HOME is this account's own home folder. A test or a borrowed HOME is not. */
export function ownsHome(
  home: string,
  deps: CodexAttributionDeps = {},
): boolean {
  return sameHome(home, (deps.realHome ?? (() => userInfo().homedir))());
}

type RcTarget =
  | { kind: "missing" }
  | { kind: "file"; target: string; mode: number }
  | { kind: "skip"; why: string };

/** A link is followed only to a file inside the home folder; the file it names is the one written. */
function rcTarget(path: string, home: string): RcTarget {
  let link: Stats;
  try {
    link = lstatSync(path);
  } catch {
    return { kind: "missing" };
  }
  let target = path;
  if (link.isSymbolicLink()) {
    try {
      target = realpathSync(path);
    } catch {
      return {
        kind: "skip",
        why: "it is a link to a file that does not exist",
      };
    }
    if (!inside(target, home))
      return {
        kind: "skip",
        why: `it is a link to ${target}, outside your home folder, which setup does not write`,
      };
  }
  const stat = statSync(target);
  if (!stat.isFile()) return { kind: "skip", why: "it is not a regular file" };
  return { kind: "file", target, mode: stat.mode & 0o7777 };
}

export type RcOutcome =
  | { path: string; state: "added" | "replaced" | "unchanged" | "removed" }
  | { path: string; state: "skipped"; why: string };

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** What installing the block would do to one file, computed without writing: the outcome, and for a
 *  change the exact bytes, where they go and the block they carry. Null when the file does not exist
 *  and setup has no reason to create it. */
export interface ShellHookPlan {
  outcome: RcOutcome;
  write?: {
    target: string;
    data: Buffer;
    mode: number;
    block: string;
    /** The file was there before, so a change replaces bytes someone may want back. */
    existed: boolean;
  };
}

export function planShellHook(file: RcFile, home: string): ShellHookPlan | null {
  const where = rcTarget(file.path, home);
  if (where.kind === "skip")
    return { outcome: { path: file.path, state: "skipped", why: where.why } };
  if (where.kind === "missing") {
    if (!file.wanted) return null;
    const block = codexBlock({ created: true });
    return {
      outcome: { path: file.path, state: "added" },
      write: { target: file.path, data: Buffer.from(block, "latin1"), mode: 0o644, block, existed: false },
    };
  }
  const before = readFileSync(where.target, "latin1");
  const blocks = findBlocks(before);
  if (blocks === "malformed")
    return {
      outcome: {
        path: file.path,
        state: "skipped",
        why: `it has a "${BLOCK_BEGIN}" or "${BLOCK_END}" line without its partner; fix or delete that line, then run catalyst setup again`,
      },
    };
  if (definesCodex(outsideBlocks(before, blocks)))
    return {
      outcome: {
        path: file.path,
        state: "skipped",
        why: "it already defines codex itself, as a function or an alias. To use the hook, remove that definition and run catalyst setup again",
      },
    };
  let after: string;
  let block: string;
  const first = blocks[0];
  if (first === undefined) {
    const appended = before === "" || before.endsWith("\n");
    block = codexBlock(appended ? {} : { newlineAdded: true });
    after = appended ? before + block : `${before}\n${block}`;
  } else {
    block = codexBlock({ created: first.created, newlineAdded: first.newlineAdded });
    after = before.slice(0, first.start) + block;
    let cursor = first.end;
    for (const b of blocks.slice(1)) {
      after += before.slice(cursor, b.start);
      cursor = b.end;
    }
    after += before.slice(cursor);
  }
  if (after === before) return { outcome: { path: file.path, state: "unchanged" } };
  return {
    outcome: { path: file.path, state: first === undefined ? "added" : "replaced" },
    write: { target: where.target, data: Buffer.from(after, "latin1"), mode: where.mode, block, existed: true },
  };
}

/** One file: add the block, replace it in place (a second copy is dropped), or leave the file alone.
 *  Null when the file does not exist and setup has no reason to create it. */
export function installShellHook(
  file: RcFile,
  home: string,
  ops: FileOps = defaultFileOps,
): RcOutcome | null {
  const plan = planShellHook(file, home);
  if (plan === null) return null;
  if (plan.write) writeRcAtomic(plan.write.target, plan.write.data, plan.write.mode, ops);
  return plan.outcome;
}

/** One file: take every block out. Null when the file has none. */
export function removeShellHook(
  path: string,
  home: string,
  ops: FileOps = defaultFileOps,
): RcOutcome | null {
  let link: Stats;
  try {
    link = lstatSync(path);
  } catch {
    return null;
  }
  let target = path;
  if (link.isSymbolicLink()) {
    try {
      target = realpathSync(path);
    } catch {
      return null;
    }
    if (!inside(target, home)) {
      let text = "";
      try {
        text = readFileSync(target, "latin1");
      } catch {
        return null;
      }
      return text.includes(BLOCK_BEGIN)
        ? {
            path,
            state: "skipped",
            why: `it is a link to ${target}, outside your home folder; remove the block from that file yourself`,
          }
        : null;
    }
  }
  const stat = statSync(target);
  if (!stat.isFile()) return null;
  const before = readFileSync(target, "latin1");
  const blocks = findBlocks(before);
  if (blocks === "malformed")
    return {
      path,
      state: "skipped",
      why: `it has a "${BLOCK_BEGIN}" or "${BLOCK_END}" line without its partner; remove the block yourself`,
    };
  if (blocks.length === 0) return null;
  let after = before;
  let created = false;
  for (const b of [...blocks].reverse()) {
    let start = b.start;
    // The break setup added belongs to the block only while the block still ends the file.
    if (
      b.newlineAdded &&
      b.end === after.length &&
      start > 0 &&
      after[start - 1] === "\n"
    )
      start -= 1;
    after = after.slice(0, start) + after.slice(b.end);
    created ||= b.created;
  }
  if (created && after === "") ops.unlink(target);
  else
    writeRcAtomic(
      target,
      Buffer.from(after, "latin1"),
      stat.mode & 0o7777,
      ops,
    );
  return { path, state: "removed" };
}

function hasBlock(path: string): boolean {
  try {
    const blocks = findBlocks(readFileSync(path, "latin1"));
    return blocks !== "malformed" && blocks.length > 0;
  } catch {
    return false;
  }
}

export function codexAgentPlistPath(home: string): string {
  return join(
    home,
    "Library",
    "LaunchAgents",
    `${CODEX_ATTRIBUTION_LABEL}.plist`,
  );
}

/** The default Codex home's login file: the agent runs again whenever it changes. */
export function codexLoginWatchPath(home: string): string {
  return join(home, ".codex", "auth.json");
}

export function codexAgentPlist(o: {
  cli: string;
  path: string;
  home: string;
}): string {
  const log = join(configDirFor(o.home), "codex-attribution.log");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${CODEX_ATTRIBUTION_LABEL}</string>`,
    `<key>ProgramArguments</key><array>${[o.cli, "codex-env", "--apply"].map((a) => `<string>${xml(a)}</string>`).join("")}</array>`,
    `<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(o.path)}</string><key>HOME</key><string>${xml(o.home)}</string></dict>`,
    "<key>RunAtLoad</key><true/>",
    `<key>WatchPaths</key><array><string>${xml(codexLoginWatchPath(o.home))}</string></array>`,
    "<key>ProcessType</key><string>Background</string>",
    `<key>StandardOutPath</key><string>${xml(log)}</string>`,
    `<key>StandardErrorPath</key><string>${xml(log)}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
}

function resolved(ctx: Ctx, deps: CodexAttributionDeps) {
  const cli = deps.cli ?? resolve(process.argv[1] ?? "catalyst");
  return {
    platform: deps.platform ?? process.platform,
    run: deps.run ?? defaultRun,
    uid: deps.uid ?? process.getuid?.() ?? 0,
    cli,
    path: deps.path ?? scheduledPath(cli, process.execPath, ctx.env.PATH),
  };
}

export type AgentOutcome =
  | { state: "loaded" | "unchanged"; path: string }
  | { state: "failed"; detail: string }
  | { state: "not_macos" }
  | { state: "other_home" };

const readOr = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Write, load and verify the agent, as the runner update agent does. An unchanged, loaded agent is left running. */
export function installCodexAgent(
  ctx: Ctx,
  deps: CodexAttributionDeps = {},
): AgentOutcome {
  const d = resolved(ctx, deps);
  if (d.platform !== "darwin") return { state: "not_macos" };
  if (!ownsHome(ctx.home, deps)) return { state: "other_home" };
  const path = codexAgentPlistPath(ctx.home);
  const text = codexAgentPlist({ cli: d.cli, path: d.path, home: ctx.home });
  const target = `gui/${d.uid}/${CODEX_ATTRIBUTION_LABEL}`;
  const loaded = () => d.run("launchctl", ["print", target]).status === 0;
  const wasLoaded = loaded();
  if (readOr(path) === text && wasLoaded) return { state: "unchanged", path };
  try {
    if (wasLoaded) d.run("launchctl", ["bootout", target]);
    // launchd opens the log itself and starts nothing when its folder is missing.
    mkdirSync(configDirFor(ctx.home), { recursive: true });
    writeFileAtomic(path, text);
  } catch (err) {
    return {
      state: "failed",
      detail: `could not write ${path}: ${message(err)}`,
    };
  }
  const boot = d.run("launchctl", ["bootstrap", `gui/${d.uid}`, path]);
  if (boot.status !== 0)
    return {
      state: "failed",
      detail: `launchctl bootstrap exited ${boot.status}: ${boot.stderr.trim().slice(0, 160)}`,
    };
  if (!loaded())
    return {
      state: "failed",
      detail: `launchd did not keep ${CODEX_ATTRIBUTION_LABEL} loaded`,
    };
  // RunAtLoad already starts it; a busy Mac can hold that start back (runner-auto-update.ts), so ask once more.
  d.run("launchctl", ["kickstart", target]);
  return { state: "loaded", path };
}

/** The value with `--apply`'s two pairs taken out, and whether `--apply` had set them at all. */
export function withoutAppliedAttributes(value: string): {
  applied: boolean;
  rest: string;
} {
  const pairs = value.split(",").filter((pair) => pair.trim() !== "");
  const key = (pair: string) =>
    (pair.includes("=") ? pair.slice(0, pair.indexOf("=")) : pair).trim();
  return {
    applied: pairs.some((pair) => key(pair) === ACCOUNT_SLOT_ATTRIBUTE),
    rest: pairs
      .filter(
        (pair) =>
          key(pair) !== ACCOUNT_SLOT_ATTRIBUTE &&
          key(pair) !== HOST_NAME_ATTRIBUTE,
      )
      .join(","),
  };
}

export type EnvironmentOutcome =
  "unset" | "kept_others" | "untouched" | "failed";

/** A value without the coding-account pair is not ours and stays as it is. */
function undoLaunchEnvironment(run: SchedulerRun): EnvironmentOutcome {
  const read = run("launchctl", ["getenv", ENV_NAME]);
  const { applied, rest } = withoutAppliedAttributes(
    read.status === 0 ? read.stdout.trim() : "",
  );
  if (!applied) return "untouched";
  const done =
    rest === ""
      ? run("launchctl", ["unsetenv", ENV_NAME])
      : run("launchctl", ["setenv", ENV_NAME, rest]);
  return done.status !== 0 ? "failed" : rest === "" ? "unset" : "kept_others";
}

export interface AgentRemoval {
  agent: "removed" | "absent" | "failed" | "not_macos" | "other_home";
  detail?: string;
  environment: EnvironmentOutcome;
}

export function removeCodexAgent(
  ctx: Ctx,
  deps: CodexAttributionDeps = {},
): AgentRemoval {
  const d = resolved(ctx, deps);
  if (d.platform !== "darwin")
    return { agent: "not_macos", environment: "untouched" };
  if (!ownsHome(ctx.home, deps))
    return { agent: "other_home", environment: "untouched" };
  const path = codexAgentPlistPath(ctx.home);
  const target = `gui/${d.uid}/${CODEX_ATTRIBUTION_LABEL}`;
  const loaded = () => d.run("launchctl", ["print", target]).status === 0;
  const was = existsSync(path) || loaded();
  if (was) d.run("launchctl", ["bootout", target]);
  // A loaded agent would set the value again, so the environment waits until it is gone.
  if (loaded())
    return {
      agent: "failed",
      detail: `it is still loaded: run launchctl bootout ${target}`,
      environment: "untouched",
    };
  try {
    if (existsSync(path)) fileOps(deps).unlink(path);
  } catch (err) {
    return {
      agent: "failed",
      detail: `could not delete ${path}: ${message(err)}`,
      environment: undoLaunchEnvironment(d.run),
    };
  }
  return {
    agent: was ? "removed" : "absent",
    environment: undoLaunchEnvironment(d.run),
  };
}

function tilde(path: string, home: string): string {
  const rel = relative(home, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
    ? `~/${rel}`
    : path;
}

function ageText(seconds: number): string {
  const plural = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (seconds < 60) return "under a minute";
  if (seconds < 3600) return plural(Math.floor(seconds / 60), "minute");
  if (seconds < 2 * 86400) return plural(Math.floor(seconds / 3600), "hour");
  return plural(Math.floor(seconds / 86400), "day");
}

/** `catalyst status`'s one line. Read only and offline: the cached account map, never a refresh. */
export function codexAttributionStatusLine(
  ctx: Ctx,
  deps: CodexAttributionDeps = {},
): string {
  const d = resolved(ctx, deps);
  const hooked = shellRcFiles(ctx)
    .filter((file) => hasBlock(file.path))
    .map((file) => tilde(file.path, ctx.home));
  const agent =
    d.platform !== "darwin"
      ? null
      : !existsSync(codexAgentPlistPath(ctx.home))
        ? "not installed"
        : d.run("launchctl", [
              "print",
              `gui/${d.uid}/${CODEX_ATTRIBUTION_LABEL}`,
            ]).status === 0
          ? "loaded"
          : "not loaded";
  const installed = hooked.length > 0 && (agent === null || agent === "loaded");
  let workspace: string | null = null;
  try {
    workspace = loadConfig(ctx.home)?.account ?? null;
  } catch {
    workspace = null;
  }
  const cached = workspace === null ? null : readCodexAccountsCache(ctx.home);
  const cache =
    cached !== null && cached.workspace === workspace ? cached : null;
  const codexHome = defaultCodexHome(ctx);
  const slot = attrValue(resolveSlot(readCodexAccountId(codexHome), cache));
  const fetchedMs = cache === null ? Number.NaN : Date.parse(cache.fetchedAt);
  const age = Number.isFinite(fetchedMs)
    ? `account list cached ${ageText(Math.max(0, Math.floor((ctx.now().getTime() - fetchedMs) / 1000)))} ago`
    : "no account list cached";
  const parts = [
    hooked.length > 0
      ? `shell hook in ${hooked.join(" and ")}`
      : "no shell hook",
    ...(agent === null ? [] : [`login agent ${agent}`]),
  ];
  return `Codex attribution: ${installed ? "installed" : "not installed"} (${parts.join(", ")}); ${tilde(codexHome, ctx.home)} resolves to coding account ${slot}, ${age}.${installed ? "" : " Run catalyst setup to add it."}`;
}

/** How setup knows Codex is on this computer: an executable `codex` on the PATH setup runs with
 *  (the command a terminal launch runs), or the desktop app's bundle (what a Dock launch starts).
 *  A Codex home folder alone does not count: it outlives an uninstalled Codex. Null when neither. */
export function codexPresence(
  ctx: Ctx,
  deps: CodexAttributionDeps = {},
): string | null {
  for (const dir of (ctx.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, "codex");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here; the next PATH entry may have it.
    }
  }
  const apps = deps.applicationDirs ?? [
    "/Applications",
    join(ctx.home, "Applications"),
  ];
  for (const dir of apps) {
    const bundle = join(dir, CODEX_APP_BUNDLE);
    try {
      if (statSync(bundle).isDirectory()) return bundle;
    } catch {
      // Not installed in this folder.
    }
  }
  return null;
}

export const CODEX_ABSENT_LINE = `Codex attribution skipped: Codex is not installed on this computer (no codex command on PATH and no ${CODEX_APP_BUNDLE} in /Applications or ~/Applications). Run catalyst setup again after you install Codex to add it.`;

/** Setup's part: the rc blocks and, on a Mac, the agent. Silent under another HOME, where it changes nothing. */
export function setupCodexAttribution(
  ctx: Ctx,
  deps: CodexAttributionDeps = {},
): string[] {
  if (!ownsHome(ctx.home, deps)) return [];
  // No Codex, no hook: the agent would otherwise set the launch environment for every Dock app.
  if (codexPresence(ctx, deps) === null) return [CODEX_ABSENT_LINE];
  const files = shellRcFiles(ctx).flatMap((file): RcOutcome[] => {
    try {
      const outcome = installShellHook(file, ctx.home, fileOps(deps));
      return outcome === null ? [] : [outcome];
    } catch (err) {
      return [
        {
          path: file.path,
          state: "skipped",
          why: `it could not be read or written (${message(err)})`,
        },
      ];
    }
  });
  const lines: string[] = [];
  const written = files
    .filter((f) => f.state !== "skipped")
    .map((f) => `${tilde(f.path, ctx.home)} (${f.state})`);
  if (written.length > 0)
    lines.push(
      `Codex launches from a terminal name their coding account: the codex function is in ${written.join(" and ")}.`,
    );
  for (const f of files)
    if (f.state === "skipped")
      lines.push(
        `Left ${tilde(f.path, ctx.home)} without the Codex launch hook: ${f.why}.`,
      );
  if (files.length === 0)
    lines.push(
      "No shell rc file got the Codex launch hook: there is no ~/.zshrc or ~/.bashrc, and your login shell is neither zsh nor bash.",
    );
  const agent = installCodexAgent(ctx, deps);
  if (agent.state === "loaded")
    lines.push(
      `Codex launches from the Dock name their coding account: the ${CODEX_ATTRIBUTION_LABEL} LaunchAgent is loaded. A Codex app that is already open picks this up the next time it starts.`,
    );
  else if (agent.state === "unchanged")
    lines.push(
      `The ${CODEX_ATTRIBUTION_LABEL} LaunchAgent is loaded and unchanged.`,
    );
  else if (agent.state === "failed")
    lines.push(
      `Setup could not load the ${CODEX_ATTRIBUTION_LABEL} LaunchAgent (${agent.detail}), so apps started from the Dock do not name their coding account. Run catalyst setup again in Terminal on this Mac's desktop.`,
    );
  return lines;
}

/** The copy `--only codex-attribution` keeps of an rc file before it first changes it. */
export const RC_BACKUP_SUFFIX = ".before-codex-attribution";

export interface CodexAttributionOnly {
  ok: boolean;
  dryRun: boolean;
  files: RcOutcome[];
  /** Each copy kept beside the file it was taken from, and whether this run made it. */
  backups: { path: string; backup: string; kept: "new" | "earlier" }[];
  agent: AgentOutcome | { state: "would_load"; path: string } | { state: "codex_absent" };
  /** Each Codex home named with `--codex-home`, and whether it got the telemetry exporter (CTC-7028). */
  homes: HomeOutcome[];
  lines: string[];
}

export type HomeOutcome =
  | { home: string; state: "added" | "would_add" | "unchanged" | "removed" | "absent" }
  | { home: string; state: "skipped"; why: string };

/** The workspace's coding-account list as this machine cached it, or null when it is for another
 *  workspace, missing, or this machine is logged out. */
function accountsCache(ctx: Ctx) {
  let workspace: string | null;
  try {
    workspace = loadConfig(ctx.home)?.account ?? null;
  } catch {
    workspace = null;
  }
  const cached = workspace === null ? null : readCodexAccountsCache(ctx.home);
  return cached !== null && cached.workspace === workspace ? cached : null;
}

/** Why a named home cannot take the exporter, or null when it can: it is logged in to one of the
 *  workspace's coding accounts and is not the default home the exporter comes from. */
function homeRefusal(ctx: Ctx, home: string): string | null {
  if (resolve(home) === resolve(defaultCodexHome(ctx)))
    return "it is the default Codex home, which the exporter is copied from";
  const slot = resolveSlot(readCodexAccountId(home), accountsCache(ctx));
  if (slot === NO_LOGIN_SLOT) return "there is no Codex login in it";
  if (slot === UNREGISTERED_SLOT)
    return "its Codex login is not one of this workspace's coding accounts (run catalyst codex-env --refresh if it was added just now)";
  return null;
}

/** A home's config.toml as it is now: its text and mode, or why it cannot be changed. */
function readHomeConfig(target: string): { text: string; mode: number; existed: boolean } | { why: string } {
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch {
    return { text: "", mode: 0o600, existed: false };
  }
  if (stat.isSymbolicLink()) return { why: "its config.toml is a link, which setup does not follow" };
  if (!stat.isFile()) return { why: "its config.toml is not a regular file" };
  try {
    return { text: readFileSync(target, "utf8"), mode: stat.mode & 0o7777, existed: true };
  } catch (err) {
    return { why: `its config.toml could not be read (${message(err)})` };
  }
}

/** CTC-7028: each named Codex home gets the default home's exporter, after a copy of its config.toml
 *  is kept beside it. Header values are never printed. */
function exportFromHomes(ctx: Ctx, homes: readonly string[], ops: FileOps, dryRun: boolean, result: CodexAttributionOnly): void {
  if (homes.length === 0) return;
  const sourcePath = join(defaultCodexHome(ctx), "config.toml");
  const source = readOr(sourcePath);
  const block = source === null ? null : otelTables(source);
  for (const raw of homes) {
    const home = resolve(raw);
    const target = join(home, "config.toml");
    const name = tilde(target, ctx.home);
    const skip = (why: string) => {
      result.homes.push({ home, state: "skipped", why });
      result.lines.push(`Left ${tilde(home, ctx.home)} as it is: ${why}.`);
    };
    const refusal = homeRefusal(ctx, home);
    if (refusal !== null) {
      skip(refusal);
      continue;
    }
    const config = readHomeConfig(target);
    if ("why" in config) {
      skip(config.why);
      continue;
    }
    if (hasOtel(config.text)) {
      result.homes.push({ home, state: "unchanged" });
      result.lines.push(`${name} already has a telemetry exporter (unchanged).`);
      continue;
    }
    if (block === null) {
      skip(`${tilde(sourcePath, ctx.home)} has no [otel] exporter to copy`);
      continue;
    }
    const backup = `${target}${RC_BACKUP_SUFFIX}`;
    if (dryRun) {
      result.homes.push({ home, state: "would_add" });
      result.lines.push(
        config.existed
          ? `Would add the telemetry exporter from ${tilde(sourcePath, ctx.home)} to ${name}, after keeping a copy of the file as ${tilde(backup, ctx.home)}${existsSync(backup) ? " (an earlier copy is already there and would be kept)" : ""}. Header values are shown as <hidden>:`
          : `Would create ${name} with the telemetry exporter from ${tilde(sourcePath, ctx.home)}. Header values are shown as <hidden>:`,
        ...maskedOtel(block),
      );
      continue;
    }
    try {
      if (config.existed) {
        if (existsSync(backup)) result.backups.push({ path: target, backup, kept: "earlier" });
        else {
          writeRcAtomic(backup, readFileSync(target), config.mode, ops);
          result.backups.push({ path: target, backup, kept: "new" });
        }
      }
      writeRcAtomic(target, withOtel(config.text, block), config.mode, ops);
    } catch (err) {
      result.ok = false;
      skip(`its config.toml could not be written (${message(err)})`);
      continue;
    }
    result.homes.push({ home, state: "added" });
    const kept = result.backups.find((b) => b.path === target);
    result.lines.push(
      `Codex launches with ${tilde(home, ctx.home)} send their telemetry: the exporter from ${tilde(sourcePath, ctx.home)} is in ${name}.` +
        (kept === undefined
          ? ""
          : kept.kept === "new"
            ? ` The file as it was is kept at ${tilde(kept.backup, ctx.home)}.`
            : ` An earlier copy of the file is kept at ${tilde(kept.backup, ctx.home)}.`),
    );
  }
}

/** `catalyst setup --only codex-attribution`: the hooks setup adds after a full run, and nothing else.
 *  Before it first changes an existing rc file it keeps a byte-for-byte copy beside it, and an earlier
 *  copy is never overwritten, so the copy is what the file was before any hook. `dryRun` writes
 *  nothing and prints the exact block each file would get and the exact agent file. */
export function onlyCodexAttribution(
  ctx: Ctx,
  deps: CodexAttributionDeps = {},
  options: { dryRun?: boolean; codexHomes?: readonly string[] } = {},
): CodexAttributionOnly {
  const dryRun = options.dryRun === true;
  const result: CodexAttributionOnly = {
    ok: true,
    dryRun,
    files: [],
    backups: [],
    agent: { state: "other_home" },
    homes: [],
    lines: [],
  };
  if (!ownsHome(ctx.home, deps)) {
    result.ok = false;
    result.lines.push(
      `HOME (${ctx.home}) is not this account's home folder, so the Codex launch hooks were left alone. Run it as the account that uses Codex.`,
    );
    return result;
  }
  if (codexPresence(ctx, deps) === null) {
    result.agent = { state: "codex_absent" };
    result.lines.push(CODEX_ABSENT_LINE);
    return result;
  }
  const ops = fileOps(deps);
  const verb = { added: "add", replaced: "replace" } as const;
  for (const file of shellRcFiles(ctx)) {
    let plan: ShellHookPlan | null;
    try {
      plan = planShellHook(file, ctx.home);
    } catch (err) {
      plan = { outcome: { path: file.path, state: "skipped", why: `it could not be read (${message(err)})` } };
    }
    if (plan === null) continue;
    const name = tilde(file.path, ctx.home);
    const write = plan.write;
    if (write === undefined) {
      result.files.push(plan.outcome);
      if (plan.outcome.state === "unchanged")
        result.lines.push(`${name} already has the Codex launch hook (unchanged).`);
      else if (plan.outcome.state === "skipped")
        result.lines.push(`Left ${name} without the Codex launch hook: ${plan.outcome.why}.`);
      continue;
    }
    const state = plan.outcome.state === "replaced" ? "replaced" : "added";
    const backup = `${write.target}${RC_BACKUP_SUFFIX}`;
    if (dryRun) {
      result.files.push(plan.outcome);
      result.lines.push(
        write.existed
          ? `Would ${verb[state]} this block in ${name}, after keeping a copy of the file as ${tilde(backup, ctx.home)}${existsSync(backup) ? " (an earlier copy is already there and would be kept)" : ""}:`
          : `Would create ${name} with this block:`,
        ...write.block.replace(/\n$/, "").split("\n"),
      );
      continue;
    }
    try {
      if (write.existed) {
        if (existsSync(backup)) result.backups.push({ path: write.target, backup, kept: "earlier" });
        else {
          writeRcAtomic(backup, readFileSync(write.target), write.mode, ops);
          result.backups.push({ path: write.target, backup, kept: "new" });
        }
      }
      writeRcAtomic(write.target, write.data, write.mode, ops);
    } catch (err) {
      result.ok = false;
      const outcome: RcOutcome = { path: file.path, state: "skipped", why: `it could not be written (${message(err)})` };
      result.files.push(outcome);
      result.lines.push(`Left ${name} without the Codex launch hook: ${outcome.why}.`);
      continue;
    }
    result.files.push(plan.outcome);
    const kept = result.backups.find((b) => b.path === write.target);
    result.lines.push(
      `Codex launches from a terminal name their coding account: the codex function is in ${name} (${state}).` +
        (kept === undefined
          ? ""
          : kept.kept === "new"
            ? ` The file as it was is kept at ${tilde(kept.backup, ctx.home)}.`
            : ` An earlier copy of the file is kept at ${tilde(kept.backup, ctx.home)}.`),
    );
  }
  if (result.files.length === 0)
    result.lines.push(
      "No shell rc file got the Codex launch hook: there is no ~/.zshrc or ~/.bashrc, and your login shell is neither zsh nor bash.",
    );
  exportFromHomes(ctx, options.codexHomes ?? [], ops, dryRun, result);
  const d = resolved(ctx, deps);
  if (d.platform !== "darwin") {
    result.agent = { state: "not_macos" };
    if (dryRun) result.lines.push("Dry run: nothing was changed.");
    return result;
  }
  if (dryRun) {
    const path = codexAgentPlistPath(ctx.home);
    const text = codexAgentPlist({ cli: d.cli, path: d.path, home: ctx.home });
    const loaded = d.run("launchctl", ["print", `gui/${d.uid}/${CODEX_ATTRIBUTION_LABEL}`]).status === 0;
    if (readOr(path) === text && loaded) {
      result.agent = { state: "unchanged", path };
      result.lines.push(`The ${CODEX_ATTRIBUTION_LABEL} LaunchAgent is loaded and unchanged.`);
    } else {
      result.agent = { state: "would_load", path };
      result.lines.push(`Would write ${tilde(path, ctx.home)} and load it:`, ...text.replace(/\n$/, "").split("\n"));
    }
    result.lines.push("Dry run: nothing was changed.");
    return result;
  }
  const agent = installCodexAgent(ctx, deps);
  result.agent = agent;
  if (agent.state === "loaded")
    result.lines.push(
      `Codex launches from the Dock name their coding account: the ${CODEX_ATTRIBUTION_LABEL} LaunchAgent is loaded. A Codex app that is already open picks this up the next time it starts.`,
    );
  else if (agent.state === "unchanged")
    result.lines.push(`The ${CODEX_ATTRIBUTION_LABEL} LaunchAgent is loaded and unchanged.`);
  else if (agent.state === "failed") {
    result.ok = false;
    result.lines.push(
      `Setup could not load the ${CODEX_ATTRIBUTION_LABEL} LaunchAgent (${agent.detail}), so apps started from the Dock do not name their coding account. Run catalyst setup --only codex-attribution again in Terminal on this Mac's desktop.`,
    );
  }
  return result;
}

/** What a full setup run adds after its steps, done or waiting. A dry run, a run scoped with
 *  --only and --no-shell-hook add nothing (`--only codex-attribution` is its own path, above). With --json the lines go to stderr, so stdout keeps its one
 *  document. */
export function codexAttributionAfterSetup(
  args: ParsedArgs,
  ctx: Ctx,
  deps: CodexAttributionDeps = {},
): void {
  if (
    args.flags["dry-run"] === true ||
    args.flags.only !== undefined ||
    args.flags["no-shell-hook"] === true
  )
    return;
  const say = args.json ? ctx.stderr : ctx.stdout;
  for (const line of setupCodexAttribution(ctx, deps)) say(line);
}

export interface CodexAttributionRemoval {
  ok: boolean;
  files: RcOutcome[];
  agent: AgentRemoval;
  homes: HomeOutcome[];
  lines: string[];
}

/** Takes the copied exporter block out of each named home's config.toml. With nothing edited after
 *  setup added it, the file is byte for byte what it was. */
function removeHomeExporters(ctx: Ctx, homes: readonly string[], ops: FileOps): { homes: HomeOutcome[]; lines: string[] } {
  const out: HomeOutcome[] = [];
  const lines: string[] = [];
  for (const raw of homes) {
    const home = resolve(raw);
    const target = join(home, "config.toml");
    const name = tilde(target, ctx.home);
    const config = readHomeConfig(target);
    if ("why" in config) {
      out.push({ home, state: "skipped", why: config.why });
      lines.push(`Left ${tilde(home, ctx.home)} as it is: ${config.why}.`);
      continue;
    }
    const restored = config.existed ? withoutOtel(config.text) : null;
    if (restored === null) {
      out.push({ home, state: "absent" });
      lines.push(`${name} had no telemetry exporter from setup.`);
      continue;
    }
    try {
      writeRcAtomic(target, restored, config.mode, ops);
    } catch (err) {
      const why = `its config.toml could not be written (${message(err)})`;
      out.push({ home, state: "skipped", why });
      lines.push(`Left ${tilde(home, ctx.home)} as it is: ${why}.`);
      continue;
    }
    out.push({ home, state: "removed" });
    lines.push(`Took the copied telemetry exporter out of ${name}; the file is as it was before setup added it.`);
  }
  return { homes: out, lines };
}

/** `catalyst setup --remove-codex-attribution`. Run twice, the second run finds nothing to remove. */
export function removeCodexAttribution(
  ctx: Ctx,
  deps: CodexAttributionDeps = {},
  codexHomes: readonly string[] = [],
): CodexAttributionRemoval {
  const files = shellRcFiles(ctx).flatMap((file): RcOutcome[] => {
    try {
      const outcome = removeShellHook(file.path, ctx.home, fileOps(deps));
      return outcome === null ? [] : [outcome];
    } catch (err) {
      return [
        {
          path: file.path,
          state: "skipped",
          why: `it could not be read or written (${message(err)})`,
        },
      ];
    }
  });
  const agent = removeCodexAgent(ctx, deps);
  const lines: string[] = [];
  for (const f of files)
    lines.push(
      f.state === "skipped"
        ? `Left ${tilde(f.path, ctx.home)} as it is: ${f.why}.`
        : `Removed the Codex launch hook from ${tilde(f.path, ctx.home)}; the file is as it was before setup added it.`,
    );
  if (files.length === 0)
    lines.push("No shell rc file had the Codex launch hook.");
  if (agent.agent === "removed")
    lines.push(
      `Unloaded and deleted the ${CODEX_ATTRIBUTION_LABEL} LaunchAgent.`,
    );
  else if (agent.agent === "absent")
    lines.push(`The ${CODEX_ATTRIBUTION_LABEL} LaunchAgent was not installed.`);
  else if (agent.agent === "failed")
    lines.push(
      `Could not remove the ${CODEX_ATTRIBUTION_LABEL} LaunchAgent: ${agent.detail}.`,
    );
  else if (agent.agent === "other_home")
    lines.push(
      `HOME (${ctx.home}) is not this account's home folder, so the LaunchAgent and the launch environment were left alone.`,
    );
  if (agent.environment === "unset")
    lines.push(
      `Unset ${ENV_NAME} in the launch environment. Apps that are already open keep it until they restart.`,
    );
  else if (agent.environment === "kept_others")
    lines.push(
      `Took the coding account and machine name out of ${ENV_NAME} in the launch environment, and kept the attributes you set there yourself. Apps that are already open keep the old value until they restart.`,
    );
  else if (agent.environment === "failed")
    lines.push(
      `Could not change ${ENV_NAME} in the launch environment. Run launchctl getenv ${ENV_NAME} to see it, and launchctl unsetenv ${ENV_NAME} to clear it.`,
    );
  const homes = removeHomeExporters(ctx, codexHomes, fileOps(deps));
  lines.push(...homes.lines);
  return {
    ok:
      files.every((f) => f.state !== "skipped") &&
      homes.homes.every((h) => h.state !== "skipped") &&
      agent.agent !== "failed" &&
      agent.environment !== "failed",
    files,
    agent,
    homes: homes.homes,
    lines,
  };
}

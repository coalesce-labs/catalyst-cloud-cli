// machine.ts — what this computer adds to `catalyst env draft`: the names the repository's `.envrc`
// exports and Claude Code's HTTP MCP servers. Names and references only; see `scan-envrc.ts` and
// `scan-claude-mcp.ts` for why neither returns a value.
//
// ⛔ `.env` and `.dev.vars` are never opened, even through an `.envrc` that is a link to one: the
// default reader resolves the real path first and refuses those basenames, the same rule the
// repository inventory keeps.
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { isSecretName } from "./draft.js";
import { scanClaudeMcp, type ClaudeMcpScan } from "./scan-claude-mcp.js";
import { scanEnvrc, type EnvrcScan } from "./scan-envrc.js";

const ENVRC_CAP = 1024 * 1024;
const CLAUDE_JSON_CAP = 32 * 1024 * 1024;
const REFUSED_BASENAMES = new Set([".env", ".dev.vars"]);

export interface MachineOptions {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Tests inject this. The default follows a link, requires a regular file and caps its size. */
  readMachineFile?: (path: string, capBytes: number) => string | undefined;
}

export interface MachineScan {
  envrc: EnvrcScan | null;
  claude: ClaudeMcpScan | null;
  names: string[];
  secretNames: string[];
  /** ".envrc" and "~/.claude.json", for the ones that added a name or a server. */
  sources: string[];
  notes: string[];
}

export interface MachineFiles {
  envrcText: string | undefined;
  claudeText: string | undefined;
  repoRoots: string[];
  notes: string[];
}

/** Read `.envrc` and `~/.claude.json` once, through the injected reader or the guarded default. */
export function readMachineFiles(root: string, options: MachineOptions): MachineFiles {
  const notes: string[] = [];
  const read = (path: string, cap: number, label: string): string | undefined => {
    if (options.readMachineFile) return options.readMachineFile(path, cap);
    const result = readGuarded(path, cap);
    if (result.note !== undefined) notes.push(`${label} ${result.note}`);
    return result.text;
  };
  const envrcText = read(join(root, ".envrc"), ENVRC_CAP, ".envrc");
  const claudeText = read(join(options.home, ".claude.json"), CLAUDE_JSON_CAP, "~/.claude.json");
  return { envrcText, claudeText, repoRoots: repoRootsFor(root), notes };
}

export function repoRootsFor(root: string): string[] {
  const roots = [root];
  try {
    const real = realpathSync(root);
    if (real !== root) roots.push(real);
  } catch {
    // An unreadable root has no realpath; the given path is the only key.
  }
  return roots;
}

/** Scan this computer for names. Missing files leave their half null, so the draft is unchanged. */
export function scanMachine(root: string, options: MachineOptions): MachineScan {
  const files = readMachineFiles(root, options);
  const envrc = files.envrcText === undefined ? null : scanEnvrc(files.envrcText);
  const names = new Set<string>();
  const secrets = new Set<string>();
  const sources: string[] = [];
  for (const entry of envrc?.exported ?? []) {
    names.add(entry.name);
    if (isSecretName(entry.name)) secrets.add(entry.name);
  }
  if (envrc !== null && envrc.exported.length > 0) sources.push(".envrc");
  const claude = files.claudeText === undefined ? null : scanClaudeMcp(files.claudeText, files.repoRoots, names);
  for (const server of claude?.servers ?? []) {
    for (const name of server.references) {
      names.add(name);
      secrets.add(name);
    }
  }
  if (claude !== null && claude.servers.length > 0) sources.push("~/.claude.json");
  const sort = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b, "en"));
  return { envrc, claude, names: sort(names), secretNames: sort(secrets), sources, notes: files.notes };
}

function readGuarded(path: string, cap: number): { text?: string; note?: string } {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return {};
  }
  if (REFUSED_BASENAMES.has(basename(real))) return { note: `links to a ${basename(real)} file, which is never read; it was not read` };
  let fd: number;
  try {
    fd = openSync(real, "r");
  } catch {
    return { note: "could not be opened; it was not read" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { note: "is not a regular file; it was not read" };
    if (stat.size > cap) return { note: `is larger than ${Math.round(cap / 1024 / 1024)} MiB; it was not read` };
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const n = readSync(fd, buffer, offset, stat.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return { text: buffer.subarray(0, offset).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

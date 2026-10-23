// repo.ts — `catalyst repo agents-block` and `catalyst repo agent-setup`: a repository's agent setup,
// read and changed in a checkout the person names, never through git and never through the cloud.
//
//   repo agents-block <path> [--write]        the one Catalyst block in AGENTS.md, marker-delimited,
//                                             replaced in place on a rerun (never duplicated)
//   repo agent-setup <path> [--apply] [--with-check]
//                                             what the repository holds for agents, whether it is
//                                             portable, the plan that would make it so, and --apply
//
// Portable means: AGENTS.md is canonical; CLAUDE.md is a thin file that imports it with a line that
// is exactly `@AGENTS.md` plus Claude-only notes; `.agents/skills` and `.agents/rules` are canonical
// and `.claude/skills` and `.claude/rules` are relative symlinks to them. Every write lands in the
// working tree only: committing, branching and the pull request are the person's, in the open.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { flagBool, positionals, type ParsedArgs } from "./args.js";
import type { Ctx } from "./config.js";
import { UsageError } from "./errors.js";
import { cmdRepoStatus } from "./repo-status.js";

export const BLOCK_START = "<!-- catalyst:start -->";
export const BLOCK_END = "<!-- catalyst:end -->";

/** The two skills the block names. ONE place each: the packs are being consolidated, and a rename
 *  lands here, then `repo agents-block --write` brings every repository's block up to date. */
export const BLOCK_PROCESS_SKILL = "whats-happening";
export const BLOCK_DECISION_SKILL = "catalyst-sop";

/** ⭐ THE block, word for word. Harness-agnostic; names the skills, never the process. */
export const CATALYST_AGENTS_BLOCK = [
  BLOCK_START,
  "## Catalyst",
  "",
  `This repository is worked through Catalyst: tickets move through a pipeline of agent-run phases, and pull requests merge through its queue. Before you plan, branch, review or merge here, load the skill that explains the process instead of inferring it from this file: \`${BLOCK_PROCESS_SKILL}\` (how a ticket runs, what each phase produces, why work waits), and \`${BLOCK_DECISION_SKILL}\` when it is installed (what to do when work stalls on a decision). Keep this block as it is; onboarding maintains it.`,
  BLOCK_END,
].join("\n");

export type BlockState = "absent" | "missing" | "current" | "stale";

/** Where the block sits in `text`, or null. Only the FIRST start marker and the first end after it count. */
function locateBlock(text: string): { start: number; end: number } | null {
  const start = text.indexOf(BLOCK_START);
  if (start === -1) return null;
  const endAt = text.indexOf(BLOCK_END, start);
  if (endAt === -1) return null;
  return { start, end: endAt + BLOCK_END.length };
}

/** The block's state in an AGENTS.md text (`null` text = no file). */
export function blockState(text: string | null): BlockState {
  if (text === null) return "absent";
  const at = locateBlock(text);
  if (at === null) return "missing";
  return text.slice(at.start, at.end) === CATALYST_AGENTS_BLOCK ? "current" : "stale";
}

/** The text with the block current: replaced in place, appended after one blank line, or the whole
 *  file. Pure and idempotent: applying it to its own output changes nothing. */
export function withBlock(text: string | null): string {
  if (text === null || text.trim() === "") return `${CATALYST_AGENTS_BLOCK}\n`;
  const at = locateBlock(text);
  if (at !== null) return `${text.slice(0, at.start)}${CATALYST_AGENTS_BLOCK}${text.slice(at.end)}`;
  const body = text.replace(/\s+$/, "");
  return `${body}\n\n${CATALYST_AGENTS_BLOCK}\n`;
}

type LinkState = { kind: "absent" } | { kind: "dir" } | { kind: "file" } | { kind: "symlink"; target: string; resolvesToCanonical: boolean };

export interface RepoSetupReport {
  path: string;
  agentsMd: { present: boolean; lines: number; bytes: number; block: BlockState };
  claudeMd: { present: boolean; importsAgentsMd: boolean; otherLines: number };
  agentsDir: { skills: boolean; rules: boolean };
  claudeDir: { skills: LinkState; rules: LinkState };
  others: string[];
  verdict: "portable" | "convertible" | "needs_hand_merge";
  plan: string[];
  blockers: string[];
}

function linkState(root: string, rel: string, canonicalRel: string): LinkState {
  const p = join(root, rel);
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return { kind: "absent" };
  }
  if (st.isSymbolicLink()) {
    const target = readlinkSync(p);
    const resolved = resolve(dirname(p), target);
    return { kind: "symlink", target, resolvesToCanonical: resolved === resolve(root, canonicalRel) && existsSync(resolved) };
  }
  return st.isDirectory() ? { kind: "dir" } : { kind: "file" };
}

const OTHER_MARKERS = [".codex", ".cursor", ".cursorrules", ".windsurfrules", "GEMINI.md", ".github/copilot-instructions.md"];

/** Read a checkout's agent setup. Never writes. */
export function inspectRepo(root: string): RepoSetupReport {
  const agentsPath = join(root, "AGENTS.md");
  const claudePath = join(root, "CLAUDE.md");
  const agentsText = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : null;
  const claudeText = existsSync(claudePath) ? readFileSync(claudePath, "utf8") : null;
  const claudeLines = claudeText === null ? [] : claudeText.split("\n");
  const importsAgentsMd = claudeLines.some((l) => l.trim() === "@AGENTS.md");
  const otherLines = claudeLines.filter((l) => l.trim() !== "" && l.trim() !== "@AGENTS.md").length;
  const report: RepoSetupReport = {
    path: root,
    agentsMd: { present: agentsText !== null, lines: agentsText === null ? 0 : agentsText.replace(/\n$/, "").split("\n").length, bytes: agentsText === null ? 0 : Buffer.byteLength(agentsText), block: blockState(agentsText) },
    claudeMd: { present: claudeText !== null, importsAgentsMd, otherLines },
    agentsDir: { skills: isDir(join(root, ".agents", "skills")), rules: isDir(join(root, ".agents", "rules")) },
    claudeDir: { skills: linkState(root, ".claude/skills", ".agents/skills"), rules: linkState(root, ".claude/rules", ".agents/rules") },
    others: OTHER_MARKERS.filter((m) => existsSync(join(root, m))),
    verdict: "portable",
    plan: [],
    blockers: [],
  };
  // CLAUDE.md with guidance of its own and no import: its content belongs in AGENTS.md.
  if (report.claudeMd.present && !importsAgentsMd) {
    report.plan.push(report.agentsMd.present
      ? "append CLAUDE.md's content to AGENTS.md and leave CLAUDE.md as the thin importer (`@AGENTS.md` plus Claude-only notes)"
      : "create AGENTS.md from CLAUDE.md's content and leave CLAUDE.md as the thin importer (`@AGENTS.md`)");
  } else if (!report.agentsMd.present && !report.claudeMd.present) {
    report.plan.push("create AGENTS.md (the Catalyst block starts it; add the repository's own guidance there)");
  }
  for (const name of ["skills", "rules"] as const) {
    const c = report.claudeDir[name];
    const canonical = report.agentsDir[name];
    if (c.kind === "dir" && !canonical) report.plan.push(`move .claude/${name} to .agents/${name} and leave .claude/${name} as a relative symlink to it`);
    else if (c.kind === "dir" && canonical) report.blockers.push(`.claude/${name} and .agents/${name} are both real directories: merge them by hand, then leave .claude/${name} as a relative symlink`);
    else if (c.kind === "symlink" && !c.resolvesToCanonical) report.blockers.push(`.claude/${name} is a symlink to ${c.target}, not to .agents/${name}: point it there by hand`);
    else if (c.kind === "absent" && canonical) report.plan.push(`add .claude/${name} as a relative symlink to .agents/${name}`);
    else if (c.kind === "file") report.blockers.push(`.claude/${name} is a file, not a directory: look at it by hand`);
  }
  if (report.blockers.length > 0) report.verdict = "needs_hand_merge";
  else if (report.plan.length > 0) report.verdict = "convertible";
  return report;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const THIN_CLAUDE_MD = "# CLAUDE.md\n\nAll project context for any coding agent is in AGENTS.md, imported below. Only Claude-specific notes belong in this file.\n\n@AGENTS.md\n";

/** Perform a convertible plan in the working tree. Refuses when anything needs a hand merge. */
export function applyPlan(root: string, before: RepoSetupReport): string[] {
  if (before.verdict === "needs_hand_merge") throw new UsageError(`nothing applied: ${before.blockers.join("; ")}`);
  const done: string[] = [];
  const agentsPath = join(root, "AGENTS.md");
  const claudePath = join(root, "CLAUDE.md");
  if (before.claudeMd.present && !before.claudeMd.importsAgentsMd) {
    const claudeText = readFileSync(claudePath, "utf8");
    const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8").replace(/\s+$/, "") : "";
    const merged = existing === "" ? claudeText.replace(/\s+$/, "") + "\n" : `${existing}\n\n${claudeText.replace(/\s+$/, "")}\n`;
    writeFileSync(agentsPath, merged);
    writeFileSync(claudePath, THIN_CLAUDE_MD);
    done.push(before.agentsMd.present ? "appended CLAUDE.md's content to AGENTS.md; CLAUDE.md now imports it" : "created AGENTS.md from CLAUDE.md; CLAUDE.md now imports it");
  } else if (!before.agentsMd.present && !before.claudeMd.present) {
    writeFileSync(agentsPath, withBlock(null));
    done.push("created AGENTS.md holding the Catalyst block");
  }
  for (const name of ["skills", "rules"] as const) {
    const c = before.claudeDir[name];
    const canonicalPath = join(root, ".agents", name);
    const claudeLink = join(root, ".claude", name);
    if (c.kind === "dir" && !before.agentsDir[name]) {
      mkdirSync(join(root, ".agents"), { recursive: true });
      renameSync(claudeLink, canonicalPath);
      symlinkSync(relative(dirname(claudeLink), canonicalPath), claudeLink, "dir");
      done.push(`moved .claude/${name} to .agents/${name} and left a relative symlink`);
    } else if (c.kind === "absent" && before.agentsDir[name]) {
      mkdirSync(join(root, ".claude"), { recursive: true });
      symlinkSync(relative(dirname(claudeLink), canonicalPath), claudeLink, "dir");
      done.push(`added .claude/${name} as a relative symlink to .agents/${name}`);
    }
  }
  return done;
}

/** The lightweight check a customer can run in CI: node only, no dependencies, exit 1 on a finding. */
export const AGENTS_MD_CHECK_SCRIPT = `#!/usr/bin/env node
// agents-md-check.mjs — keeps this repository's agent setup portable. Run it in CI:
//   node scripts/agents-md-check.mjs
// It fails when CLAUDE.md stops importing AGENTS.md, when .claude/skills or .claude/rules stops being
// a relative symlink into .agents/, when AGENTS.md outgrows its budget, or when a repository path
// AGENTS.md cites no longer exists. Budgets: AGENTS_MD_MAX_LINES and AGENTS_MD_MAX_BYTES (env).
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const maxLines = Number(process.env.AGENTS_MD_MAX_LINES ?? 120);
const maxBytes = Number(process.env.AGENTS_MD_MAX_BYTES ?? 16 * 1024);
const findings = [];
const agents = existsSync("AGENTS.md") ? readFileSync("AGENTS.md", "utf8") : null;
if (agents === null) findings.push("AGENTS.md is missing");
else {
  const lines = agents.replace(/\\n$/, "").split("\\n");
  if (lines.length > maxLines) findings.push(\`AGENTS.md is \${lines.length} lines (budget \${maxLines})\`);
  if (Buffer.byteLength(agents) > maxBytes) findings.push(\`AGENTS.md is \${Buffer.byteLength(agents)} bytes (budget \${maxBytes})\`);
  for (const m of agents.matchAll(/\`([\\w.-]+(?:\\/[\\w.-]+)+)\`/g)) {
    const p = m[1];
    if (!existsSync(resolve(root, p))) findings.push(\`AGENTS.md cites \${p}, which does not exist\`);
  }
}
if (existsSync("CLAUDE.md")) {
  const n = readFileSync("CLAUDE.md", "utf8").split("\\n").filter((l) => l.trim() === "@AGENTS.md").length;
  if (n !== 1) findings.push(\`CLAUDE.md must import AGENTS.md on exactly one line reading @AGENTS.md (found \${n})\`);
}
for (const name of ["skills", "rules"]) {
  const link = \`.claude/\${name}\`;
  const canonical = \`.agents/\${name}\`;
  if (!existsSync(canonical) && !existsSync(link)) continue;
  let st;
  try { st = lstatSync(link); } catch { findings.push(\`\${link} is missing; make it a relative symlink to \${canonical}\`); continue; }
  if (!st.isSymbolicLink()) { findings.push(\`\${link} is a real \${st.isDirectory() ? "directory" : "file"}; make \${canonical} canonical and \${link} a relative symlink\`); continue; }
  const target = readlinkSync(link);
  if (target.startsWith("/")) findings.push(\`\${link} is an absolute symlink (\${target}); make it relative\`);
  if (resolve(dirname(link), target) !== resolve(root, canonical)) findings.push(\`\${link} points at \${target}, not \${canonical}\`);
}
for (const f of findings) console.error(\`agents-md-check: \${f}\`);
if (findings.length > 0) process.exit(1);
console.log("agents-md-check: portable");
`;

const describeLink = (s: LinkState): string => (s.kind === "symlink" ? `symlink → ${s.target}${s.resolvesToCanonical ? "" : " (not the canonical directory)"}` : s.kind === "dir" ? "real directory" : s.kind === "file" ? "a file" : "absent");

export function reportLines(r: RepoSetupReport): string[] {
  const lines = [
    `repository: ${r.path}`,
    `AGENTS.md: ${r.agentsMd.present ? `${r.agentsMd.lines} lines, ${r.agentsMd.bytes} bytes; Catalyst block ${r.agentsMd.block}` : "absent"}`,
    `CLAUDE.md: ${r.claudeMd.present ? (r.claudeMd.importsAgentsMd ? `imports AGENTS.md${r.claudeMd.otherLines ? ` plus ${r.claudeMd.otherLines} lines of Claude-only notes` : ""}` : `${r.claudeMd.otherLines} lines of its own guidance, no @AGENTS.md import`) : "absent"}`,
    `.agents/skills: ${r.agentsDir.skills ? "present" : "absent"}; .claude/skills: ${describeLink(r.claudeDir.skills)}`,
    `.agents/rules: ${r.agentsDir.rules ? "present" : "absent"}; .claude/rules: ${describeLink(r.claudeDir.rules)}`,
  ];
  if (r.others.length > 0) lines.push(`also present: ${r.others.join(", ")}`);
  lines.push(`verdict: ${r.verdict === "portable" ? "portable (AGENTS.md canonical, Claude files import or link to it)" : r.verdict === "convertible" ? "convertible; --apply performs this plan in the working tree:" : "needs a hand merge before --apply:"}`);
  for (const p of r.plan) lines.push(`  - ${p}`);
  for (const b of r.blockers) lines.push(`  ⛔ ${b}`);
  if (r.agentsMd.block !== "current") lines.push(`  - the Catalyst block is ${r.agentsMd.block}: catalyst repo agents-block ${r.path} --write`);
  return lines;
}

function checkoutRoot(args: ParsedArgs, sub: string): string {
  const [, path, ...extra] = positionals(args);
  if (!path) throw new UsageError(`repo ${sub} needs the checkout's path`);
  if (extra.length > 0) throw new UsageError(`repo ${sub} takes one path`);
  const root = resolve(path);
  if (!isDir(root)) throw new UsageError(`${path} is not a directory on this machine`);
  return root;
}

export async function cmdRepo(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [sub] = positionals(args);
  if (sub === "status" || sub === "pause" || sub === "resume") return cmdRepoStatus(args, ctx);
  if (sub !== "agents-block" && sub !== "agent-setup") throw new UsageError("repo needs status, pause <owner/name> --reason <text>, resume <owner/name> [--reason <text>], agents-block <path> [--write] or agent-setup <path> [--apply] [--with-check]");
  if (args.flags.reason !== undefined) throw new UsageError("--reason belongs to repo pause or resume");
  const root = checkoutRoot(args, sub);
  const emit = (body: Record<string, unknown>, lines: string[]) => { if (args.json) ctx.stdout(JSON.stringify(body)); else for (const l of lines) ctx.stdout(l); };
  if (sub === "agents-block") {
    if (flagBool(args, "apply") || flagBool(args, "with-check")) throw new UsageError("--apply and --with-check belong to repo agent-setup");
    const file = join(root, "AGENTS.md");
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    const state = blockState(before);
    if (!flagBool(args, "write")) {
      const hint = state === "current" ? "nothing to do" : `run with --write to ${state === "absent" ? "create AGENTS.md with it" : state === "missing" ? "append it" : "bring it up to date"} (in the working tree; commit it on a branch and open a pull request)`;
      emit({ path: root, agentsMd: before !== null, block: state, changed: false }, [`AGENTS.md: Catalyst block ${state} — ${hint}`]);
      return state === "current" ? 0 : 1;
    }
    const after = withBlock(before);
    const changed = after !== before;
    if (changed) writeFileSync(file, after);
    emit({ path: root, agentsMd: true, block: "current", changed, was: state }, [
      changed ? `AGENTS.md: Catalyst block ${state === "absent" ? "written to a new AGENTS.md" : state === "missing" ? "appended" : "updated in place"}; commit it on a branch and open a pull request` : "AGENTS.md: Catalyst block already current; nothing changed",
    ]);
    return 0;
  }
  if (flagBool(args, "write")) throw new UsageError("--write belongs to repo agents-block");
  const before = inspectRepo(root);
  const applied: string[] = [];
  if (flagBool(args, "apply")) applied.push(...applyPlan(root, before));
  if (flagBool(args, "with-check")) {
    const dir = join(root, "scripts");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "agents-md-check.mjs");
    const same = existsSync(target) && readFileSync(target, "utf8") === AGENTS_MD_CHECK_SCRIPT;
    if (!same) writeFileSync(target, AGENTS_MD_CHECK_SCRIPT, { mode: 0o755 });
    applied.push(same ? "scripts/agents-md-check.mjs already current" : "wrote scripts/agents-md-check.mjs (run it in CI: node scripts/agents-md-check.mjs)");
  }
  const after = applied.length > 0 ? inspectRepo(root) : before;
  emit({ ...after, applied }, [...(applied.length ? ["applied:", ...applied.map((a) => `  - ${a}`)] : []), ...reportLines(after)]);
  return after.verdict === "portable" && after.agentsMd.block === "current" ? 0 : 1;
}

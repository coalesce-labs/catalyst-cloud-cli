// capabilities.ts — what this CLI can do on a person's behalf, as a machine-readable table. A setup
// guide reads it instead of carrying its own list of verbs, so when a verb lands here the guide
// stops sending the person to a page for it, and when a verb is missing the guide says "update the
// CLI" rather than inventing a command. Each capability names the role the cloud requires for it
// and the contract routes it rides; availability is judged against the CACHED contract only, so
// this verb never reaches the network and never blocks. Every new setup route gets a row here and a
// guide line that offers it; a page link for a step with a row is a bug.
import type { ParsedArgs } from "./args.js";
import { readManifest, type Ctx } from "./config.js";
import { readContractCache } from "./contract.js";
import type { ContractRoute } from "./contract-types.js";

/** The seat the cloud requires. `member` is any active member of the workspace. */
export type CapabilityRole = "member" | "admin";

export interface Capability {
  /** Explicit support for the bootstrap's state and lock transfer contract. */
  bootstrapHandoff?: boolean;
  /** Revision 2 continues setup with runner flags and a returning workspace review. */
  bootstrapHandoffVersion?: number;
  /** CTC-4625: the install engine's event protocol `setup` speaks; install.sh checks it before use. */
  engineProtocol?: number;
  /** `onboard --headless`: inputs by flag, env or file; no prompt, no browser (CTC-4633). */
  headless?: boolean;
  /** The verb as typed after `catalyst`. */
  verb: string;
  /** One line a guide can say to the person. */
  does: string;
  needs: CapabilityRole;
  /** The agent routes the verb rides; empty when it only reads the tenant's read plane or the local machine. */
  routes: readonly { method: "GET" | "POST"; path: string }[];
  /** The CLI version the verb first shipped in. */
  since: string;
}

const agent = (method: "GET" | "POST", name: string) => ({ method, path: `/api/v1/agent/${name}` }) as const;

/** ⭐ THE ONE PLACE THIS CLI SAYS WHAT IT CAN DO. Keep it in the order a setup walks: the machine,
 *  the person, the workspace, the project, the repository, then work. A new verb is a new row here
 *  in the same change, or `catalyst capabilities` lies to every guide that reads it. */
export const CAPABILITIES: readonly Capability[] = [
  {verb:"hosts",does:"list this account's machines, current use and live capacity",needs:"member",routes:[],since:"0.16.0"},
  {verb:"hosts remove|rename",does:"remove or rename a self-hosted machine in this account",needs:"admin",routes:[],since:"0.16.0"},
  {verb:"runner status|stop|start",does:"stop this machine's self-hosted runner taking work, or start it again with the same registration",needs:"member",routes:[],since:"0.16.16"},
  {verb:"runner uninstall",does:"remove this machine's self-hosted runner and revoke its registration and runner key",needs:"admin",routes:[],since:"0.16.16"},
  // CTC-4680: plain `catalyst setup` runs the onboard flow, so install.sh may hand off to it. install.sh
  // reads this flag rather than `setup --help`, which already exits 0 on 0.15.x.
  { verb: "setup", does: "set up Catalyst step by step, or show install.sh's plan, progress and sign-in in this terminal", needs: "member", routes: [], since: "0.15.0", engineProtocol: 1, bootstrapHandoff: true, bootstrapHandoffVersion: 2 },
  { verb: "onboard", does: "run and resume Catalyst setup with a saved step record", needs: "member", routes: [], since: "0.14.0", bootstrapHandoff: true, headless: true },
  { verb: "status", does: "say whether this machine is connected, as whom, and to which cloud", needs: "member", routes: [], since: "0.1.0" },
  { verb: "me", does: "read the person's seat, role and Linear identity", needs: "member", routes: [], since: "0.1.0" },
  { verb: "ready", does: "read the machine and the workspace's per-project readiness in one verdict", needs: "member", routes: [], since: "0.1.0" },
  { verb: "contract", does: "read the workspace contract this cloud serves", needs: "member", routes: [agent("GET", "contract")], since: "0.1.0" },
  { verb: "capabilities", does: "list what this CLI can do, the role each needs, and whether this cloud serves it", needs: "member", routes: [], since: "0.9.5" },
  { verb: "connections personal linear start|status", does: "start and confirm the person's own Linear connected account (the consent itself is theirs, in a browser)", needs: "member", routes: [], since: "0.9.0" },
  { verb: "connections personal github start|status", does: "start and confirm the person's own GitHub connected account (the consent itself is theirs, in a browser)", needs: "member", routes: [], since: "0.9.0" },
  { verb: "identity linear status|options|set", does: "match the person's Linear identity from the roster", needs: "member", routes: [], since: "0.9.0" },
  { verb: "team list", does: "list the workspace's Linear teams and which are mapped as projects", needs: "member", routes: [agent("GET", "teams")], since: "0.9.5" },
  { verb: "team check", does: "run a project's readiness check now", needs: "admin", routes: [agent("POST", "team-workflow/check")], since: "0.9.5" },
  { verb: "team map", does: "map a project's stages, from a preview the person approves", needs: "admin", routes: [agent("GET", "team-workflow"), agent("POST", "team-workflow/save")], since: "0.9.5" },
  { verb: "team adopt", does: "create Catalyst's stages in a Linear team, from a preview the person approves", needs: "admin", routes: [agent("POST", "team-workflow/adopt")], since: "0.9.5" },
  { verb: "team migrate", does: "move tickets between stages, from a preview the person approves", needs: "admin", routes: [agent("POST", "team-workflow/migrate")], since: "0.9.5" },
  { verb: "team checklist", does: "print what adopting the workflow would do to a team", needs: "admin", routes: [agent("GET", "team-workflow")], since: "0.9.5" },
  { verb: "project wip-limit get", does: "read a project's new-start WIP limit, where it comes from, and its work in progress now", needs: "member", routes: [agent("GET", "team-wip-limit")], since: "0.13.1" },
  { verb: "project wip-limit set", does: "set a project's new-start WIP limit (0 to 9999, or back to the workspace default)", needs: "admin", routes: [agent("POST", "team-wip-limit")], since: "0.13.1" },
  { verb: "repo agents-block", does: "add or refresh the one Catalyst block in a checkout's AGENTS.md, in the working tree, for the person to commit and open as a pull request", needs: "member", routes: [], since: "0.13.1" },
  { verb: "repo agent-setup", does: "read a checkout's agent setup (AGENTS.md, CLAUDE.md, .agents and .claude skills and rules) and, on request, make it portable in the working tree", needs: "member", routes: [], since: "0.13.1" },
  { verb: "legacy", does: "find leftovers of the old local Catalyst runtime on this machine and, on a yes, remove them through their own tools", needs: "member", routes: [], since: "0.13.1" },
  { verb: "environment read", does: "read the workspace-wide environment declaration", needs: "member", routes: [agent("GET", "account-environment")], since: "0.8.0" },
  { verb: "environment propose", does: "propose the workspace-wide environment declaration (names only)", needs: "admin", routes: [agent("POST", "account-environment/propose")], since: "0.8.0" },
  { verb: "environment approve", does: "approve the workspace-wide environment declaration", needs: "admin", routes: [agent("POST", "account-environment/approve")], since: "0.8.0" },
  { verb: "secret set|import", does: "enter a repository secret's value from this terminal, never echoed", needs: "admin", routes: [], since: "0.8.0" },
  { verb: "var set|import", does: "enter plain environment variable values from this terminal, never echoed", needs: "admin", routes: [], since: "0.13.2" },
  { verb: "accounts", does: "read the workspace's coding accounts and which can take work", needs: "member", routes: [], since: "0.5.0" },
  { verb: "explain|running|queue|history", does: "read why a ticket runs or waits, what runs now, and what is queued", needs: "member", routes: [], since: "0.1.0" },
  { verb: "write comment|state|label|create|reaction|attachment|session", does: "act on a ticket as the person, through the agent proxy", needs: "member", routes: [agent("POST", "issue-comment"), agent("POST", "issue-state"), agent("POST", "issue-label"), agent("POST", "issue-create")], since: "0.1.0" },
  { verb: "ask raise|accept|list", does: "raise a decision to a human, or answer one", needs: "member", routes: [agent("POST", "ask"), agent("POST", "ask-accept")], since: "0.1.0" },
  { verb: "release", does: "release a parked ticket or a whole failure class back to work", needs: "admin", routes: [agent("POST", "ticket-release"), agent("POST", "ticket-release-class")], since: "0.6.0" },
  { verb: "mcp add|list|remove", does: "register an MCP server for the workspace by vault-secret name", needs: "admin", routes: [agent("POST", "mcp")], since: "0.9.0" },
];

export type CapabilityAvailability = "available" | "needs_newer_cloud" | "cloud_unread";

export interface CapabilityReport extends Capability {
  availability: CapabilityAvailability;
  /** The routes the cached contract does not serve; empty unless `needs_newer_cloud`. */
  missing: readonly { method: "GET" | "POST"; path: string }[];
}

/** Judge each capability against the routes a contract serves. `null` means no contract is cached,
 *  so nothing that rides a route can be called available; local and read-plane verbs still are. */
export function reportCapabilities(routes: readonly ContractRoute[] | null): CapabilityReport[] {
  return CAPABILITIES.map((c) => {
    if (c.routes.length === 0) return { ...c, availability: "available", missing: [] };
    if (routes === null) return { ...c, availability: "cloud_unread", missing: [] };
    const missing = c.routes.filter((r) => !routes.some((s) => s.method === r.method && s.path === r.path));
    return { ...c, availability: missing.length === 0 ? "available" : "needs_newer_cloud", missing };
  });
}

export async function cmdCapabilities(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const manifest = readManifest();
  const cache = readContractCache(ctx.home);
  const report = reportCapabilities(cache === null ? null : cache.doc.routes);
  if (args.json) {
    ctx.stdout(
      JSON.stringify({
        cli: { name: "catalyst", version: manifest.version },
        contract: cache === null ? null : { version: cache.contractVersion, fetchedAt: cache.fetchedAt },
        capabilities: report,
      }),
    );
    return 0;
  }
  ctx.stdout(
    cache === null
      ? `catalyst ${manifest.version}; no contract cached yet, so nothing that rides a cloud route can be called available: run \`catalyst contract\` after connecting`
      : `catalyst ${manifest.version} against contract ${cache.contractVersion} (cached ${cache.fetchedAt})`,
  );
  const width = Math.max(...report.map((r) => r.verb.length));
  for (const r of report) {
    const why =
      r.availability === "needs_newer_cloud"
        ? ` — this cloud does not serve ${r.missing.map((m) => `${m.method} ${m.path}`).join(", ")}`
        : r.availability === "cloud_unread"
          ? " — rides a cloud route; no contract cached"
          : "";
    ctx.stdout(`${r.verb.padEnd(width)}  ${r.needs.padEnd(6)}  ${r.availability.padEnd(17)}  ${r.does}${why}`);
  }
  return 0;
}

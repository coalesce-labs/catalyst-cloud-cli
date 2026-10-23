// env-machine-fixture.ts — a working machine for the machine-scan tests: a repository whose `.envrc`
// exports 44 names (13 of them tokens, one computed by a command) next to two direnv lines it does
// not follow, and a HOME whose `~/.claude.json` holds 3 HTTP MCP servers and 1 stdio server. Every
// value starts with SENTINEL so a leak test can look for all of them at once.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SENTINEL = "zqvsentinel";

export const TOKEN_NAMES = [
  "ANTHROPIC_API_KEY", "CLOUDFLARE_API_TOKEN", "CONTEXT7_API_KEY", "DB_PASSWORD", "EXA_API_KEY", "GITHUB_TOKEN",
  "LINEAR_API_KEY", "NPM_TOKEN", "OPENAI_API_KEY", "SENTRY_AUTH_TOKEN", "SLACK_BOT_TOKEN", "STRIPE_SECRET_KEY", "VERCEL_TOKEN",
];
export const PLAIN_NAMES = Array.from({ length: 31 }, (_, i) => `PLAIN_SETTING_${String(i).padStart(2, "0")}`);
export const ALL_NAMES = [...TOKEN_NAMES, ...PLAIN_NAMES].sort((a, b) => a.localeCompare(b, "en"));

/** The value `.envrc` (or, for GITHUB_TOKEN, the direnv environment) holds for a name. */
export function valueFor(name: string): string {
  return `${SENTINEL}_${name.toLowerCase()}`;
}
export const DIRENV_GITHUB_TOKEN = `${SENTINEL}_github_token_from_direnv`;
export const STDIO_ENV_VALUE = `${SENTINEL}_stdio_env_value`;

export function envrcText(): string {
  const lines = ["# this repository's environment", "dotenv_if_exists .env.local", "PATH_add bin", 'export GITHUB_TOKEN="$(gh auth token)"'];
  for (const [i, name] of ALL_NAMES.entries()) {
    if (name === "GITHUB_TOKEN") continue;
    const value = valueFor(name);
    lines.push(i % 3 === 0 ? `export ${name}='${value}'` : i % 3 === 1 ? `export ${name}="${value}"` : `export ${name}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

export function claudeJson(root: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    numStartups: 3,
    mcpServers: {
      context7: { type: "http", url: "https://mcp.context7.com/mcp", headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" } },
      exa: { type: "http", url: "https://mcp.exa.ai/mcp", headers: { Authorization: "Bearer ${EXA_API_KEY}" } },
      "local-tool": { type: "stdio", command: "npx", args: ["local-tool"], env: { LOCAL_TOOL_KEY: STDIO_ENV_VALUE } },
      ...extra,
    },
    projects: {
      [root]: { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_API_KEY}" } } } },
    },
  });
}

/** A temp repository and a temp HOME laid out as above. */
export function writeMachine(options: { claude?: string | null; envrc?: string | null } = {}): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "catalyst-machine-repo-"));
  const home = mkdtempSync(join(tmpdir(), "catalyst-machine-home-"));
  mkdirSync(join(home, ".config"), { recursive: true });
  if (options.envrc !== null) writeFileSync(join(root, ".envrc"), options.envrc ?? envrcText());
  if (options.claude !== null) writeFileSync(join(home, ".claude.json"), options.claude ?? claudeJson(root));
  return { root, home };
}

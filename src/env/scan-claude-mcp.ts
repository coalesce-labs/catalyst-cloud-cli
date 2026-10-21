// scan-claude-mcp.ts — Claude Code's HTTP MCP servers (`~/.claude.json`), turned into
// `[[environment.mcp_servers]]` declarations whose every header is a `$NAME` reference.
//
// Two sources are read, in Claude Code's own precedence: the top-level `mcpServers` (its user scope)
// and `projects[<this repository's path>].mcpServers` (its default local scope), the local entry
// winning a name clash. No server is contacted and no `claude` command runs.
//
// ⛔ `scanClaudeMcp` RETURNS NO HEADER VALUE. A header that references `${NAME}` keeps the name; a
// header that holds a literal becomes a new secret variable (`<SERVER>_MCP_TOKEN` and friends) and
// the literal is dropped with the parsed object. `claudeHeaderLiterals` is the one export that hands
// a literal back, and only the import's value resolver (`machine-values.ts`) calls it.
import { validateFullSettings } from "../../vendor/settings/index.js";

const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-_]{0,127}$/;
const REF_RE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))$/;
const UPPER_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_SERVERS = 64;
const MAX_HEADERS = 32;

export interface DraftedMcpServer {
  name: string;
  configName: string;
  scope: "user" | "project";
  url: string;
  /** Values are "$NAME" or "Bearer $NAME" only. */
  headers: Record<string, string>;
  /** Every name the headers reference, derived ones included. Each is declared secret. */
  references: string[];
  derived: Array<{ variable: string; header: string; bearer: boolean }>;
}

export interface ClaudeMcpScan {
  servers: DraftedMcpServer[];
  notDrafted: Array<{ name: string; reason: string }>;
  note?: string;
}

interface ConfigEntry {
  configName: string;
  scope: "user" | "project";
  raw: unknown;
}

type HeaderRead =
  | { kind: "reference"; name: string; bearer: boolean }
  | { kind: "literal"; variable: string; bearer: boolean; literal: string }
  | { kind: "refused"; reason: string };

/** A Catalyst server name: lowercase, `[a-z0-9_-]`, starting with a letter, at most 64 characters. */
function toServerName(configName: string): string | null {
  const name = configName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64);
  return /^[a-z][a-z0-9_-]{0,63}$/.test(name) ? name : null;
}

/** An upper-case variable stem from a server or header name: `my-server` → `MY_SERVER`. */
function toVariableName(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function derivedVariable(serverName: string, header: string, bearer: boolean): string {
  const stem = toVariableName(serverName);
  const prefix = /^[A-Z]/.test(stem) ? stem : `MCP_${stem}`;
  if (header.toLowerCase() === "authorization") return `${prefix}_MCP_${bearer ? "TOKEN" : "AUTHORIZATION"}`;
  return `${prefix}_MCP_${toVariableName(header)}`;
}

export function scanClaudeMcp(text: string | undefined, repoRoots: readonly string[], declared: ReadonlySet<string>): ClaudeMcpScan {
  if (text === undefined) return { servers: [], notDrafted: [], note: "~/.claude.json was not found" };
  const entries = readEntries(text, repoRoots);
  if (typeof entries === "string") return { servers: [], notDrafted: [], note: entries };
  const servers: DraftedMcpServer[] = [];
  const notDrafted: Array<{ name: string; reason: string }> = [];
  const taken = new Set(declared);
  // Reserve explicit references before deriving names, including later servers and headers.
  // Use the effective entries after project overrides, just as the import lookup does.
  for (const entry of entries) {
    const name = toServerName(entry.configName);
    if (name === null || !isRecord(entry.raw) || !isRecord(entry.raw.headers)) continue;
    for (const [header, value] of Object.entries(entry.raw.headers)) {
      if (!HEADER_NAME_RE.test(header) || typeof value !== "string") continue;
      const read = readHeader(name, header, value);
      if (read.kind === "reference") taken.add(read.name);
    }
  }
  const names = new Set<string>();
  for (const entry of entries) {
    const outcome = draftServer(entry, taken);
    if ("reason" in outcome) {
      notDrafted.push({ name: entry.configName, reason: outcome.reason });
      continue;
    }
    if (names.has(outcome.name)) {
      notDrafted.push({ name: entry.configName, reason: `its name becomes ${outcome.name}, which another server already uses` });
      continue;
    }
    if (servers.length >= MAX_SERVERS) {
      notDrafted.push({ name: entry.configName, reason: `more than ${MAX_SERVERS} servers; add it by hand` });
      continue;
    }
    if (!passesSettingsCheck(outcome)) {
      notDrafted.push({ name: entry.configName, reason: "Catalyst's settings check refused it; add it by hand" });
      continue;
    }
    names.add(outcome.name);
    for (const { variable } of outcome.derived) taken.add(variable);
    servers.push(outcome);
  }
  return { servers, notDrafted };
}

/** Import only. The literal (without `Bearer `) behind each requested variable the draft derives. Only
 *  servers the draft itself drafts count, given the same `declared` names it saw (the `.envrc` exports):
 *  a server it refused, or one whose derived name clashed, never supplies a value. */
export function claudeHeaderLiterals(
  text: string,
  repoRoots: readonly string[],
  wanted: ReadonlySet<string>,
  declared: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const values = new Map<string, string>();
  const entries = readEntries(text, repoRoots);
  if (typeof entries === "string") return values;
  const drafted = new Map(scanClaudeMcp(text, repoRoots, declared).servers.map((server) => [server.configName, server]));
  for (const entry of entries) {
    const server = drafted.get(entry.configName);
    if (server === undefined || !isRecord(entry.raw) || !isRecord(entry.raw.headers)) continue;
    const derived = new Set(server.derived.map(({ variable }) => variable));
    for (const [header, value] of Object.entries(entry.raw.headers)) {
      if (typeof value !== "string") continue;
      const read = readHeader(server.name, header, value);
      if (read.kind === "literal" && derived.has(read.variable) && wanted.has(read.variable)) values.set(read.variable, read.literal);
    }
  }
  return values;
}

/** One `[[environment.mcp_servers]]` block. Header keys are JSON-quoted. */
export function mcpServerToml(server: Pick<DraftedMcpServer, "name" | "url" | "headers">): string {
  const headers = Object.entries(server.headers).map(([name, value]) => `${JSON.stringify(name)} = ${JSON.stringify(value)}`);
  return [
    "[[environment.mcp_servers]]",
    `name = ${JSON.stringify(server.name)}`,
    'transport = "http"',
    `url = ${JSON.stringify(server.url)}`,
    `headers = { ${headers.join(", ")} }`,
    "",
  ].join("\n");
}

function readEntries(text: string, repoRoots: readonly string[]): ConfigEntry[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "~/.claude.json is not valid JSON; no MCP server was drafted";
  }
  if (!isRecord(parsed)) return "~/.claude.json does not hold a JSON object; no MCP server was drafted";
  const byName = new Map<string, ConfigEntry>();
  if (isRecord(parsed.mcpServers)) {
    for (const [configName, raw] of Object.entries(parsed.mcpServers)) byName.set(configName, { configName, scope: "user", raw });
  }
  const projects = isRecord(parsed.projects) ? parsed.projects : {};
  // Claude Code keys projects by path as it saw it: on Windows `C:/Users/…` while Node gives
  // `C:\Users\…`. Compare the two spellings, not the exact key.
  const projectKeys = new Map(Object.keys(projects).map((key) => [projectPathKey(key), key]));
  for (const root of new Set(repoRoots.map(projectPathKey))) {
    const key = projectKeys.get(root);
    const project = key === undefined ? undefined : projects[key];
    if (!isRecord(project) || !isRecord(project.mcpServers)) continue;
    for (const [configName, raw] of Object.entries(project.mcpServers)) {
      byName.delete(configName);
      byName.set(configName, { configName, scope: "project", raw });
    }
  }
  return [...byName.values()].sort((a, b) => a.configName.localeCompare(b.configName, "en"));
}

function draftServer(entry: ConfigEntry, taken: ReadonlySet<string>): DraftedMcpServer | { reason: string } {
  const raw = entry.raw;
  if (!isRecord(raw)) return { reason: "its entry is not an object" };
  const type = typeof raw.type === "string" ? raw.type : raw.command !== undefined ? "stdio" : raw.url !== undefined ? "http" : "unknown";
  if (type === "stdio" || raw.command !== undefined) return { reason: "a stdio server runs a command on this computer" };
  if (type === "sse") return { reason: "SSE servers are not drafted" };
  if (type !== "http") return { reason: `${type} servers are not drafted` };
  const urlCheck = checkUrl(raw.url);
  if (urlCheck !== null) return { reason: urlCheck };
  const url = String(raw.url).trim();
  const name = toServerName(entry.configName);
  if (name === null) return { reason: "its name cannot become a Catalyst server name (letters, digits, - and _)" };
  if (!isRecord(raw.headers) || Object.keys(raw.headers).length === 0) {
    return { reason: "no header auth; it likely signs in with OAuth, which phases cannot reuse" };
  }
  const rawHeaders = Object.entries(raw.headers);
  if (rawHeaders.length > MAX_HEADERS) return { reason: `it has more than ${MAX_HEADERS} headers` };
  const headers: Record<string, string> = {};
  const references = new Set<string>();
  const derived: DraftedMcpServer["derived"] = [];
  for (const [header, value] of rawHeaders) {
    if (!HEADER_NAME_RE.test(header)) return { reason: "a header name Catalyst cannot carry" };
    if (typeof value !== "string") return { reason: "a header value is not text" };
    const read = readHeader(name, header, value);
    if (read.kind === "refused") return { reason: read.reason };
    const variable = read.kind === "reference" ? read.name : read.variable;
    if (read.kind === "literal") {
      if (taken.has(variable) || references.has(variable)) {
        return { reason: `its ${header} header held a value, and the name it would get, ${variable}, is already declared; add it by hand` };
      }
      derived.push({ variable, header, bearer: read.bearer });
    }
    references.add(variable);
    headers[header] = read.bearer ? `Bearer $${variable}` : `$${variable}`;
  }
  return {
    name,
    configName: entry.configName,
    scope: entry.scope,
    url,
    headers,
    references: [...references].sort((a, b) => a.localeCompare(b, "en")),
    derived,
  };
}

function readHeader(serverName: string, header: string, value: string): HeaderRead {
  const isAuthorization = header.toLowerCase() === "authorization";
  const bearerMatch = isAuthorization ? /^Bearer\s+(.*)$/i.exec(value) : null;
  const bearer = bearerMatch !== null;
  const body = bearerMatch ? bearerMatch[1]! : value;
  const ref = REF_RE.exec(body);
  if (ref) {
    const name = ref[1] ?? ref[2]!;
    if (!UPPER_NAME_RE.test(name)) return { kind: "refused", reason: "a header references a variable whose name is not upper-case" };
    return { kind: "reference", name, bearer };
  }
  if (body.includes("$")) return { kind: "refused", reason: "a header mixes text and a variable" };
  return { kind: "literal", variable: derivedVariable(serverName, header, bearer), bearer, literal: body };
}

function checkUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return "it has no URL";
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "its URL could not be read";
  }
  if (url.username || url.password || url.search || url.hash || raw.includes("?") || raw.includes("#")) {
    return "its URL carries a query string or sign-in details; add it by hand";
  }
  if (isPrivateHost(url.hostname)) return "it points at this computer or a private network";
  if (url.protocol !== "https:") return "its URL does not use https";
  if (url.pathname.split("/").some(looksLikeKey)) return "its URL path looks like it carries a key; add it by hand";
  if (url.hostname.split(".").some(looksLikeKey)) return "its URL host looks like it carries a key; add it by hand";
  return null;
}

/** A path segment or host label shaped like a key: long, and mixing letters with digits, including
 *  base64's `+` and `=` and percent-escapes. `mcp`, `v1` and `sse` are not. */
function looksLikeKey(segment: string): boolean {
  return segment.length >= 20 && /^[A-Za-z0-9_.~+=%-]+$/.test(segment) && /[A-Za-z]/.test(segment) && /[0-9]/.test(segment);
}

/** One spelling of a project path: forward slashes, a lower-case drive letter, no trailing slash. */
function projectPathKey(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "0.0.0.0") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  if (host.includes(":")) return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  return false;
}

function passesSettingsCheck(server: DraftedMcpServer): boolean {
  const variables = server.references.map((name) => `[[environment.variables]]\nname = ${JSON.stringify(name)}\nsecret = true\nrequired = false\n`);
  const doc = `[project]\nlinear_team = "DRAFT"\n\n[environment]\n${variables.join("\n")}\n${mcpServerToml(server)}`;
  return validateFullSettings(doc).ok;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

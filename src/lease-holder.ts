// lease-holder.ts — CTC-8873: the holder details a seat declares on `lease take` and `lease renew`
// (kind, display name, session link, external id, contact), checked here before anything is sent,
// and the labels `lease show` and `lease list` print from the details a cloud returns.
//
// ⛔ HOLDER DETAILS NEVER CARRY A CREDENTIAL. Every member of the workspace reads them, so the CLI
// runs the cloud's own credential-shape check on the raw name, external id, contact and the whole
// session link (its path included) before any other check, and refuses naming the FLAG, never the
// value. No message in this module interpolates a value a person or the cloud supplied for checking.
//
// The rules mirror the cloud's parser (catalyst CTC-8871, contract 2.65.0); the cloud still enforces
// them, so a value that passes here can still be refused there.
import type { ParsedArgs } from "./args.js";
import { flagString } from "./args.js";
import { CliError, UsageError } from "./errors.js";

/** The contract version whose cloud records holder details; an older cloud drops them silently. */
export const HOLDER_DETAILS_CONTRACT = "2.65.0";

/** The kinds a holder may declare. `unspecified` is what the cloud records when none is sent, and
 *  `catalyst-runner` is the cloud's own; neither is accepted from a seat. */
export const HOLDER_KINDS = ["catalyst-seat", "claude-code", "codex", "factory", "devin", "cursor", "other"] as const;
export type HolderKind = (typeof HOLDER_KINDS)[number];

/** The exact hosts a kind's session link may name. A kind not listed allows no session link yet. */
export const SESSION_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "catalyst-seat": ["staging.catalystcloud.dev", "app.catalystcloud.dev"],
  "claude-code": ["claude.ai"],
  codex: ["chatgpt.com"],
};
/** The exact hosts a contact link may name. */
export const CONTACT_HOSTS: readonly string[] = ["linear.app", "github.com", "app.slack.com"];

const NAME_MAX = 80;
const URL_MAX = 2048;
const EXTERNAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** C0 and C1 controls, DEL, and the bidi marks, embeddings, overrides and isolates. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const CONTROL = new RegExp(CONTROLS.source);

// ── The credential-shape check ─────────────────────────────────────────────────────────────────
// Copied from catalyst's packages/environment/src/secret-material.ts as vendored in
// vendor/settings/index.js (SECRET_ASSIGNMENT_RE, SECRET_TOKEN_SHAPES, secretTokenIn), because the
// vendored bundle exports only its settings validator. test/lease-holder.test.ts evaluates the
// vendored copy and fails when this one drifts from it, in data or in behaviour.
export const SECRET_ASSIGNMENT_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:_TOKEN|_SECRET|_KEY|_PASSWORD|_CREDENTIAL)|TOKEN|SECRET|PASSWORD)=(\S{4,})/;
const TOKEN_START_SEPARATOR_CLASS = `[\\s=:,;"'/?&@]`;
function mixedBody(chars: string, min: number): string {
  return `(?=[${chars}]*[0-9])(?=[${chars}]*[A-Z])[${chars}]{${min},}`;
}
export const SECRET_TOKEN_SHAPES: readonly { kind: string; prefixes: readonly string[]; source: string }[] = [
  { kind: "GitHub token", prefixes: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], source: "(gh[pousr]_)[A-Za-z0-9]{36,}" },
  { kind: "GitHub token", prefixes: ["github_pat_"], source: "(github_pat_)[A-Za-z0-9_]{22,}" },
  { kind: "Stripe key", prefixes: ["sk_live_", "sk_test_"], source: "(sk_(?:live|test)_)[A-Za-z0-9]{16,}" },
  { kind: "OpenAI-style API key", prefixes: ["sk-"], source: `(sk-)${mixedBody("A-Za-z0-9", 32)}` },
  { kind: "OpenAI-style API key", prefixes: ["sk-"], source: `(sk-)(?:proj|svcacct|admin)-${mixedBody("A-Za-z0-9_-", 40)}` },
  { kind: "Anthropic API key", prefixes: ["sk-"], source: `(sk-)ant-(?:api|admin|oat)\\d{2}-${mixedBody("A-Za-z0-9_-", 40)}` },
  { kind: "Slack token", prefixes: ["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-"], source: "(xox[bpars]-)(?=[0-9])[A-Za-z0-9-]{10,}" },
  { kind: "AWS access key", prefixes: ["AKIA", "ASIA"], source: "(AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])" },
  { kind: "Google API key", prefixes: ["AIza"], source: "(AIza)[0-9A-Za-z_-]{35}" },
  { kind: "private key", prefixes: ["-----BEGIN"], source: "(-----BEGIN) [A-Z ]*PRIVATE KEY(?: BLOCK)?-----" },
];
const SECRET_TOKEN_RES = SECRET_TOKEN_SHAPES.map((shape) => ({
  kind: shape.kind,
  re: new RegExp(`(?:^|${TOKEN_START_SEPARATOR_CLASS})${shape.source}`),
}));
/** The earliest known token form in `value`, as the vendored `secretTokenIn` finds it. */
export function secretTokenIn(value: string): { kind: string; prefix: string } | null {
  let best: { kind: string; prefix: string; index: number } | null = null;
  for (const { kind, re } of SECRET_TOKEN_RES) {
    const m = re.exec(value);
    if (m === null || m[1] === undefined) continue;
    const index = m.index + m[0].indexOf(m[1]);
    if (best === null || index < best.index) best = { kind, prefix: m[1], index };
  }
  return best === null ? null : { kind: best.kind, prefix: best.prefix };
}
/** The credential kind `value` looks like, or null: the same check the cloud runs on holder details. */
export function credentialShapeIn(value: string): string | null {
  return secretTokenIn(value)?.kind ?? (SECRET_ASSIGNMENT_RE.test(value) ? "secret assignment" : null);
}

// ── Input: flags, then their environment stand-ins ─────────────────────────────────────────────

/** What a take or renew declares. Absent fields are not sent; the cloud never receives an owner. */
export interface HolderDetailsInput {
  kind?: HolderKind;
  displayName?: string;
  sessionUrl?: string;
  externalId?: string;
  contact?: string;
}

/** A holder detail the CLI refuses before sending: stderr, exit 1, no usage dump. */
export class HolderDetailError extends CliError {
  constructor(message: string) {
    super(message, "holder-detail", 1);
  }
}

type Field = "kind" | "displayName" | "sessionUrl" | "externalId" | "contact";
interface Source {
  flag: string;
  env?: string;
}
const SOURCES: Record<Field, Source> = {
  kind: { flag: "holder-kind", env: "CATALYST_LEASE_HOLDER_KIND" },
  displayName: { flag: "name" },
  sessionUrl: { flag: "link", env: "CATALYST_LEASE_LINK" },
  externalId: { flag: "external-id", env: "CATALYST_LEASE_EXTERNAL_ID" },
  contact: { flag: "contact" },
};
/** The flags that carry holder details, for the actions that refuse them. */
export const HOLDER_FLAGS: readonly string[] = Object.values(SOURCES).map((s) => s.flag);

interface Raw {
  value: string;
  /** How a message names it: the flag, and the environment variable when the value came from one. */
  label: string;
}

function pick(args: ParsedArgs, env: NodeJS.ProcessEnv, field: Field, useEnv: boolean): Raw | undefined {
  const { flag, env: name } = SOURCES[field];
  const given = flagString(args, flag);
  if (given !== undefined) {
    if (given.trim() === "") throw new HolderDetailError(`--${flag} needs a value; leave the flag out to send none`);
    return { value: given, label: `--${flag}` };
  }
  if (!useEnv || name === undefined) return undefined;
  const fromEnv = env[name];
  if (fromEnv === undefined || fromEnv.trim() === "") return undefined;
  return { value: fromEnv, label: `--${flag} (from ${name})` };
}

function article(kind: string): string {
  return /^[AEIOU]/.test(kind) ? "an" : "a";
}
function refuseCredential(raw: Raw | undefined): void {
  if (raw === undefined) return;
  const kind = credentialShapeIn(raw.value);
  if (kind === null) return;
  throw new HolderDetailError(
    `${raw.label} looks like ${article(kind)} ${kind}. Holder details are visible to every member of the workspace, so they never carry a credential. Send the session's id instead.`,
  );
}

/** NFC, whitespace collapsed, 1 to 80 characters and no control or bidi character; null otherwise. */
export function normalizeDisplayName(value: string): string | null {
  const name = value.normalize("NFC").replace(/\s+/g, " ").trim();
  const length = [...name].length;
  if (length < 1 || length > NAME_MAX) return null;
  return CONTROL.test(name) ? null : name;
}

/** The host of an https link with no userinfo, port, query, fragment, whitespace or backslash, at
 *  most 2048 characters; null when the link breaks any of those. The authority is read raw first,
 *  because URL parsing erases a default port (`:443`) and decodes what a percent sign hides. */
export function httpsHost(value: string): string | null {
  if (value.length > URL_MAX || /[\s\\?#]/.test(value)) return null;
  const match = /^https:\/\/([^/]*)(?:\/.*)?$/i.exec(value);
  if (match === null) return null;
  const authority = match[1]!;
  if (authority === "" || /[@%:]/.test(authority)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  return url.hostname;
}

function hostList(hosts: readonly string[]): string {
  return hosts.length <= 1 ? hosts.join("") : `${hosts.slice(0, -1).join(", ")} or ${hosts.at(-1)}`;
}

/** The session-link check against one kind's hosts. Only a take can still declare a kind, so only
 *  a take's refusal suggests --holder-kind. */
export function checkSessionHost(label: string, kind: string, host: string, take = false): void {
  const hosts = SESSION_HOSTS[kind] ?? [];
  if (hosts.includes(host)) return;
  if (hosts.length === 0) {
    const hint = take && kind === "unspecified" ? "; declare the agent kind with --holder-kind" : "";
    throw new HolderDetailError(`${label}: kind ${kind} allows no session link yet (allowed hosts: none)${hint}`);
  }
  throw new HolderDetailError(`${label}: kind ${kind} allows session links on ${hostList(hosts)} only`);
}

/** The holder details a take or renew declares, checked, or null when it declares none.
 *  Take reads all three environment stand-ins; renew reads the link and external id ones and never a
 *  kind, because a renew cannot change it. Every credential check runs before any structural one. */
export function resolveHolderDetails(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
  action: "take" | "renew",
): { details: HolderDetailsInput; link: { label: string; host: string } | null } | null {
  if (action === "renew" && flagString(args, "holder-kind") !== undefined)
    throw new UsageError("--holder-kind is for lease take; a renew keeps the kind its take declared");
  const raw = {
    kind: action === "take" ? pick(args, env, "kind", true) : undefined,
    displayName: pick(args, env, "displayName", false),
    sessionUrl: pick(args, env, "sessionUrl", true),
    externalId: pick(args, env, "externalId", true),
    contact: pick(args, env, "contact", false),
  };
  refuseCredential(raw.displayName);
  refuseCredential(raw.externalId);
  refuseCredential(raw.contact);
  refuseCredential(raw.sessionUrl);

  const details: HolderDetailsInput = {};
  if (raw.kind !== undefined) {
    const wanted = raw.kind.value.trim();
    const kind = HOLDER_KINDS.find((k) => k === wanted);
    if (kind === undefined) throw new HolderDetailError(`${raw.kind.label} is one of ${HOLDER_KINDS.join(", ")}`);
    details.kind = kind;
  }
  if (raw.displayName !== undefined) {
    const name = normalizeDisplayName(raw.displayName.value);
    if (name === null)
      throw new HolderDetailError(`${raw.displayName.label} is 1 to ${NAME_MAX} characters with no control or bidi characters`);
    details.displayName = name;
  }
  if (raw.externalId !== undefined) {
    if (!EXTERNAL_ID.test(raw.externalId.value))
      throw new HolderDetailError(`${raw.externalId.label} is 1 to 128 of A-Z, a-z, 0-9, '.', '_', ':' and '-'`);
    details.externalId = raw.externalId.value;
  }
  if (raw.contact !== undefined) {
    const value = raw.contact.value;
    if (/^(?:mailto:)?[^\s@/]+@[^\s@/]+$/i.test(value))
      throw new HolderDetailError(`${raw.contact.label} must be a link, not an email: an https link on ${hostList(CONTACT_HOSTS)}`);
    const host = httpsHost(value);
    if (host === null || !CONTACT_HOSTS.includes(host))
      throw new HolderDetailError(`${raw.contact.label} must be an https link on ${hostList(CONTACT_HOSTS)}, with no user name, port, query or fragment`);
    details.contact = value;
  }
  let link: { label: string; host: string } | null = null;
  if (raw.sessionUrl !== undefined) {
    const host = httpsHost(raw.sessionUrl.value);
    if (host === null)
      throw new HolderDetailError(`${raw.sessionUrl.label} must be an https link of at most ${URL_MAX} characters with no user name, port, query or fragment`);
    // A take knows its kind (unspecified when none is declared); a renew's comes from the lease.
    if (action === "take") checkSessionHost(raw.sessionUrl.label, details.kind ?? "unspecified", host, true);
    details.sessionUrl = raw.sessionUrl.value;
    link = { label: raw.sessionUrl.label, host };
  }
  return Object.keys(details).length === 0 ? null : { details, link };
}

// ── Output: labels from the details a cloud returns ────────────────────────────────────────────
// Server text is untrusted even when local input passed: every printed string drops control and
// bidi characters. JSON output never comes through here.

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** `value` with every C0, C1 and bidi control, and the line and paragraph separators, removed for
 *  a terminal. */
export function sanitize(value: string): string {
  return value.replace(CONTROLS, "").replace(/[\u2028\u2029]/g, "");
}

/** The fields a printed label reads from a lease row's `holderDetails` or `lastHolderDetails`. */
export interface ReturnedDetails {
  kind: string;
  displayName: string;
  sessionUrl: string | null;
  externalId: string | null;
  contact: string | null;
  owner: unknown;
}

/** Narrow a returned details object; null when it has no usable name and kind (an old row). */
export function returnedDetails(value: unknown): ReturnedDetails | null {
  if (!object(value) || !text(value.kind) || !text(value.displayName)) return null;
  return {
    kind: value.kind,
    displayName: value.displayName,
    sessionUrl: text(value.sessionUrl) ? value.sessionUrl : null,
    externalId: text(value.externalId) ? value.externalId : null,
    contact: text(value.contact) ? value.contact : null,
    owner: value.owner,
  };
}

/** `<displayName> [<kind>]`, sanitized. */
export function detailsLabel(details: ReturnedDetails): string {
  return `${sanitize(details.displayName)} [${sanitize(details.kind)}]`;
}

/** The label show and list print: the declared name and kind whenever the row has them, the seat
 *  label otherwise. */
export function holderLabel(details: unknown, seat: unknown): string {
  const d = returnedDetails(details);
  if (d !== null) return detailsLabel(d);
  return text(seat) ? sanitize(seat) : "nobody";
}

/** The label take, renew and a refused take print: today's seat label when the cloud recorded the
 *  kind `unspecified`, so a script that reads it sees what it saw before holder details existed. */
export function writeLabel(details: unknown, seat: unknown): string {
  const d = returnedDetails(details);
  if (d !== null && d.kind !== "unspecified") return detailsLabel(d);
  return text(seat) ? sanitize(seat) : "nobody";
}

/** `organization key <keyName>` or `person <name>`, never an email and never guessed; null when
 *  the cloud named no owner. */
export function ownerLabel(owner: unknown): string | null {
  if (!object(owner)) return null;
  if (owner.type === "organization-key") {
    const name = text(owner.keyName) ? owner.keyName : text(owner.keyId) ? owner.keyId : null;
    return name === null ? null : `organization key ${sanitize(name)}`;
  }
  if (owner.type === "person") return text(owner.name) ? `person ${sanitize(owner.name)}` : "person (a member of this workspace)";
  return null;
}

/** The optional lines `lease show` prints under the holder, in order: owner, session, external
 *  id, contact. (Last progress comes before them and the previous holder after; the caller adds both.) */
export function detailLines(details: unknown): string[] {
  const d = returnedDetails(details);
  if (d === null) return [];
  const lines: string[] = [];
  const owner = ownerLabel(d.owner);
  if (owner !== null) lines.push(`  owner: ${owner}`);
  if (d.sessionUrl !== null) lines.push(`  session: ${sanitize(d.sessionUrl)}`);
  if (d.externalId !== null) lines.push(`  external id: ${sanitize(d.externalId)}`);
  if (d.contact !== null) lines.push(`  contact: ${sanitize(d.contact)}`);
  return lines;
}

/** True when a declared field differs from what the cloud kept (a same-holder retry keeps the
 *  details its take recorded). */
export function detailsDiffer(declared: HolderDetailsInput, kept: unknown): boolean {
  const k = object(kept) ? kept : {};
  return (Object.keys(declared) as Field[]).some((field) => declared[field] !== k[field]);
}

/** One shell word for `value`: bare when it is plainly safe, single-quoted when it is printable
 *  ASCII, and ANSI-C quoted (`$'…'`) otherwise, so no byte of it reaches the terminal raw. */
export function shellWord(value: string): string {
  // A leading `~` or `=` is expanded by bash or zsh, so only a word that starts otherwise is bare.
  if (/^[A-Za-z0-9._:/+-][A-Za-z0-9._~:/=+-]*$/.test(value)) return value;
  if (/^[\x20-\x7e]*$/.test(value)) return `'${value.replace(/'/g, "'\\''")}'`;
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "'") out += `\\${ch}`;
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return `$'${out}'`;
}

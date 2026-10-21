// scan-envrc.ts — the names a repository's `.envrc` exports, read as text and never run. direnv
// would run the file as shell; this reader only looks at `export` statements, so a name whose value
// a command computes is still listed, and nothing on the line executes.
//
// ⛔ `scanEnvrc` RETURNS NO VALUE. The value half of a line is looked at for two purposes only:
// deciding whether later lines continue it (a quote, a PEM block, a heredoc or a trailing
// backslash, the same idiom as `scan-env-example.ts`), and deciding whether it is a static literal.
// `envrcLiteralValues` is the one export that hands a value back, and only the import's value
// resolver (`machine-values.ts`) calls it.
//
// direnv's own commands (`dotenv`, `source_env`, `PATH_add`, `use`, `layout` and the rest) load
// names from other files or run tools. They are not followed: each is reported as a line not read.

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPORT_RE = /^\s*export\s+(.*)$/;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const BARE_ASSIGN_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const NAMES_ONLY_RE = /^([A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:#.*)?$/;
const HEREDOC_RE = /^<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;
// `#` only starts a comment at the start of a word, so `foo#bar` is one literal.
const UNQUOTED_LITERAL_RE = /^[A-Za-z0-9_./:@%+,=#-]+$/;
// An `export` that is not the line's first word: `[ -n x ] && export D=1`, `A=1; export A`.
const INNER_EXPORT_RE = /(?:^|[\s;&|(){}])export\s/;
const DECLARE_EXPORT_RE = /^\s*(?:declare|typeset)\s+-[A-Za-z]*x/;
const PEM_BEGIN = "-----BEGIN";
const PEM_END = "-----END";

const DIRENV_COMMANDS = new Set([
  "dotenv", "dotenv_if_exists", "source_env", "source_env_if_exists", "source_up", "source_up_if_exists",
  "source_url", "PATH_add", "path_add", "MANPATH_add", "PATH_rm", "path_rm", "use", "layout", "watch_file",
  "watch_dir", "env_vars_required", "load_prefix", "fetchurl", "on_git_branch", "strict_env", "unstrict_env",
]);

/** Settings that describe this computer, not the repository. Exported by many `.envrc` files, never drafted. */
const MACHINE_NAMES = new Set(["PATH", "MANPATH", "HOME", "SHELL", "PWD", "OLDPWD", "TMPDIR", "LANG", "VIRTUAL_ENV"]);
const MACHINE_PREFIXES = ["LC_", "DIRENV_", "DYLD_", "OTEL_"];

export interface EnvrcExport {
  name: string;
  line: number;
  /** True when the value is not a static literal: a command, another variable, or a multi-line value. */
  computed: boolean;
  /** True for `export NAME` with no assignment in the file: direnv passes on the shell's own value. */
  inherited: boolean;
}

export interface EnvrcScan {
  exported: EnvrcExport[];
  skippedNames: string[];
  notRead: Array<{ line: number; reason: string }>;
}

interface ParsedExport extends EnvrcExport {
  literal: string | undefined;
}

function isMachineSetting(name: string): boolean {
  return MACHINE_NAMES.has(name) || MACHINE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The names an `.envrc` exports, sorted, with the line each was last exported on. Never a value. */
export function scanEnvrc(text: string): EnvrcScan {
  const parsed = parseEnvrc(text);
  return {
    exported: parsed.exported.map(({ name, line, computed, inherited }) => ({ name, line, computed, inherited })),
    skippedNames: parsed.skippedNames,
    notRead: parsed.notRead,
  };
}

/** Import only. The static literal each requested name is exported with; a computed value is absent. */
export function envrcLiteralValues(text: string, names: ReadonlySet<string>): Map<string, string> {
  const values = new Map<string, string>();
  for (const entry of parseEnvrc(text).exported) {
    if (names.has(entry.name) && entry.literal !== undefined && entry.literal !== "") values.set(entry.name, entry.literal);
  }
  return values;
}

function parseEnvrc(text: string): { exported: ParsedExport[]; skippedNames: string[]; notRead: Array<{ line: number; reason: string }> } {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const exported = new Map<string, ParsedExport>();
  const bare = new Map<string, string | undefined>();
  const skipped = new Set<string>();
  const notRead: Array<{ line: number; reason: string }> = [];
  // Non-null while a value opened on an earlier line is still open; those lines are value material.
  let open: { kind: "quote"; quote: '"' | "'" } | { kind: "pem" } | { kind: "heredoc"; word: string } | { kind: "backslash" } | null = null;
  let openedOn = 0;

  const record = (name: string, line: number, value: ValueRead | null) => {
    if (isMachineSetting(name)) {
      skipped.add(name);
      return;
    }
    const literal = value === null ? bare.get(name) : value.literal;
    const computed = value === null ? literal === undefined : value.literal === undefined && !value.empty;
    const inherited = value === null && !bare.has(name);
    exported.delete(name);
    exported.set(name, { name, line, computed, inherited, literal });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (open !== null) {
      if (open.kind === "pem") {
        if (line.includes(PEM_END)) open = null;
      } else if (open.kind === "heredoc") {
        if (line.trim() === open.word) open = null;
      } else if (open.kind === "quote") {
        const close = closingIndex(line, open.quote, 0);
        if (close >= 0) {
          open = null;
          // `"…\n…" ; export B=2`: the words after the closing quote are a command this reader skips.
          if (!isTrailingComment(line.slice(close + 1))) notRead.push({ line: lineNo, reason: "a command after a multi-line value" });
        }
      } else if (!line.endsWith("\\")) open = null;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const heredoc = heredocMatch(line);
    const exportMatch = EXPORT_RE.exec(line);
    if (exportMatch) {
      const rest = exportMatch[1]!.trim();
      const assign = ASSIGN_RE.exec(rest);
      if (assign) {
        const value = readValue(assign[2]!);
        if (value.extra) {
          notRead.push({ line: lineNo, reason: "an export this reader does not follow" });
        } else {
          record(assign[1]!, lineNo, value);
        }
        open = heredoc ? { kind: "heredoc", word: heredoc[1]! } : value.open;
        if (open !== null) openedOn = lineNo;
        continue;
      }
      const namesOnly = NAMES_ONLY_RE.exec(rest);
      if (namesOnly) {
        for (const name of namesOnly[1]!.split(/\s+/)) record(name, lineNo, null);
        continue;
      }
      notRead.push({ line: lineNo, reason: "an export this reader does not follow" });
      if (heredoc) open = { kind: "heredoc", word: heredoc[1]! };
      else if (line.endsWith("\\")) open = { kind: "backslash" };
      if (open !== null) openedOn = lineNo;
      continue;
    }
    const command = trimmed.split(/\s+/)[0]!;
    if (DIRENV_COMMANDS.has(command)) {
      notRead.push({ line: lineNo, reason: command });
      continue;
    }
    if (DECLARE_EXPORT_RE.test(line)) {
      notRead.push({ line: lineNo, reason: `${command} -x, which this reader does not follow` });
      continue;
    }
    const bareAssign = BARE_ASSIGN_RE.exec(line);
    if (bareAssign) {
      const value = readValue(bareAssign[2]!);
      bare.set(bareAssign[1]!, value.extra ? undefined : value.literal);
      if (value.extra && INNER_EXPORT_RE.test(line)) notRead.push({ line: lineNo, reason: "an export this reader does not follow" });
      open = heredoc ? { kind: "heredoc", word: heredoc[1]! } : value.open;
      if (open !== null) openedOn = lineNo;
      continue;
    }
    if (INNER_EXPORT_RE.test(line)) notRead.push({ line: lineNo, reason: "an export this reader does not follow" });
    if (heredoc) open = { kind: "heredoc", word: heredoc[1]! };
    else if (line.endsWith("\\")) open = { kind: "backslash" };
    if (open !== null) openedOn = lineNo;
  }
  if (open !== null && open.kind !== "backslash") {
    // An unclosed quote, PEM block or heredoc swallowed every later line; say so instead of a short list.
    notRead.push({ line: openedOn, reason: "a value that never closes; the lines after it were not read" });
  }

  return {
    exported: [...exported.values()].filter((entry) => NAME_RE.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, "en")),
    skippedNames: [...skipped].sort((a, b) => a.localeCompare(b, "en")),
    notRead,
  };
}

interface ValueRead {
  /** The static value, or undefined when the shell would compute it or it continues on later lines. */
  literal: string | undefined;
  empty: boolean;
  /** True when more shell words follow the value on the same line (`export A=1 B=2`). */
  extra: boolean;
  open: { kind: "quote"; quote: '"' | "'" } | { kind: "pem" } | { kind: "backslash" } | null;
}

/** Find a heredoc operator outside quotes and comments. Substitutions have their own quote state. */
function heredocMatch(line: string): RegExpExecArray | null {
  const stack: Array<{ quote: "'" | '"' | null; end: ")" | "`" | null }> = [{ quote: null, end: null }];
  for (let i = 0; i < line.length; i++) {
    const state = stack.at(-1);
    if (state === undefined) return null;
    const char = line[i];
    if (state.quote === "'") {
      if (char === "'") state.quote = null;
      continue;
    }
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === '"') {
      state.quote = state.quote === '"' ? null : '"';
      continue;
    }
    if (char === "$" && line[i + 1] === "(") {
      stack.push({ quote: null, end: ")" });
      i++;
      continue;
    }
    if (char === "`") {
      if (state.end === "`" && state.quote === null) stack.pop();
      else stack.push({ quote: null, end: "`" });
      continue;
    }
    if (state.quote !== null) continue;
    if (char === "'") state.quote = "'";
    else if (char === "#" && (i === 0 || /[\s;|&()<>]/.test(line[i - 1] ?? ""))) return null;
    else if (char === "(" && state.end === ")") stack.push({ quote: null, end: ")" });
    else if (char === ")" && state.end === ")") stack.pop();
    else if (char === "<" && line[i - 1] !== "<" && line[i + 2] !== "<") {
      const match = HEREDOC_RE.exec(line.slice(i));
      if (match) return match;
    }
  }
  return null;
}

function readValue(raw: string): ValueRead {
  if (raw.includes(PEM_BEGIN) && !raw.includes(PEM_END)) return { literal: undefined, empty: false, extra: false, open: { kind: "pem" } };
  const first = raw[0];
  if (first === "'" || first === '"') {
    const close = closingIndex(raw, first, 1);
    if (close < 0) return { literal: undefined, empty: false, extra: false, open: { kind: "quote", quote: first } };
    const inner = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    const computed = first === '"' && /[$`\\]/.test(inner);
    if (!isTrailingComment(rest)) {
      return computed ? { literal: undefined, empty: false, extra: false, open: null } : { literal: undefined, empty: false, extra: true, open: null };
    }
    return { literal: computed ? undefined : inner, empty: inner === "", extra: false, open: null };
  }
  if (raw.endsWith("\\")) return { literal: undefined, empty: false, extra: false, open: { kind: "backslash" } };
  const space = raw.search(/\s/);
  const word = space < 0 ? raw : raw.slice(0, space);
  const rest = space < 0 ? "" : raw.slice(space);
  if (word === "") return { literal: undefined, empty: isTrailingComment(rest), extra: !isTrailingComment(rest), open: null };
  const literal = UNQUOTED_LITERAL_RE.test(word) && !word.startsWith("~") ? word : undefined;
  if (!isTrailingComment(rest)) {
    // `$(gh auth token)` and backticks carry spaces of their own: still one computed value.
    return /\$\(|`/.test(raw) ? { literal: undefined, empty: false, extra: false, open: null } : { literal: undefined, empty: false, extra: true, open: null };
  }
  return { literal, empty: false, extra: false, open: null };
}

function isTrailingComment(rest: string): boolean {
  const t = rest.trim();
  return t === "" || (t.startsWith("#") && /^\s/.test(rest));
}

/** Index of the quote that closes a value opened before `from`, or -1. A double quote honours `\"`. */
function closingIndex(text: string, quote: '"' | "'", from: number): number {
  for (let i = from; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

// codex-otel.ts — CTC-7028. A Codex home named with `--codex-home` sends its telemetry.
//
// Codex reads its exporter from the `[otel]` tables of its home's config.toml. A second home (a second
// Codex login on the same machine) starts with none, so its launches send nothing, and the coding
// account `catalyst setup --only codex-attribution` resolves for it never reaches a row. Setup copies
// the default home's `[otel]` and `[otel.*]` tables, verbatim, into each named home that is logged in
// to one of the workspace's coding accounts and has no exporter of its own.
//
// ⛔ HEADER VALUES CARRY THE COLLECTOR CREDENTIAL. They are copied file to file and never printed,
// logged or put in argv. TOML can spell a header many ways (a headers table, an inline table, a
// dotted or quoted key), so a dry run shows only an allow-list of plain values and hides the rest.
//
// The copy goes in as one marked block at the end of the file, so `--remove-codex-attribution` can
// take it out again and leave the file byte for byte as it was.

export const OTEL_BEGIN = "# >>> catalyst codex-attribution: telemetry exporter copied from the default Codex home >>>";
/** The same marker when setup also had to end the file's last line before the block. */
export const OTEL_BEGIN_NEWLINE = `${OTEL_BEGIN} (line break added)`;
export const OTEL_END = "# <<< catalyst codex-attribution <<<";
export const HIDDEN = "<hidden>";

const TABLE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const OTEL_NAME = /^"?otel"?(\.|$)/;
const KEY = /^(\s*[^=\s][^=]*?)\s*=\s*(.*)$/;
/** The only values a dry run shows. Everything else under otel (headers in any spelling, inline
 *  tables, unknown keys) can carry the collector credential, so it is shown as <hidden>. */
const SHOWN = new Set(["endpoint", "protocol", "environment", "exporter", "log_user_prompt"]);

function lines(text: string): string[] {
  return text.split("\n");
}

/** How far a value opens brackets, counting none inside quoted strings or after a comment. */
function depth(value: string): number {
  const bare = value.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "").replace(/#.*$/, "");
  let d = 0;
  for (const ch of bare) d += ch === "[" || ch === "{" ? 1 : ch === "]" || ch === "}" ? -1 : 0;
  return d;
}

type Line =
  | { kind: "table"; name: string }
  | { kind: "key"; key: string; value: string }
  /** A line inside a multi-line array or inline table, which is never a table header. */
  | { kind: "continued" }
  | { kind: "other" };

/** Each line of a config.toml, read well enough to tell a table header from a value line. */
function classify(text: string): Line[] {
  let open = 0;
  return lines(text).map((line): Line => {
    if (open > 0) {
      open += depth(line);
      return { kind: "continued" };
    }
    const table = TABLE.exec(line);
    if (table) return { kind: "table", name: table[1] ?? "" };
    const key = KEY.exec(line);
    if (key && !line.trim().startsWith("#")) {
      open = Math.max(0, depth(key[2] ?? ""));
      return { kind: "key", key: key[1] ?? "", value: key[2] ?? "" };
    }
    return { kind: "other" };
  });
}

/** The `[otel]` and `[otel.*]` tables of a config.toml, each with the lines up to the next table, in
 *  file order; null when there is none. */
export function otelTables(text: string): string | null {
  const out: string[] = [];
  const all = lines(text);
  let inOtel = false;
  classify(text).forEach((line, i) => {
    if (line.kind === "table") inOtel = OTEL_NAME.test(line.name);
    if (inOtel) out.push(all[i] ?? "");
  });
  while (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
  return out.length === 0 ? null : `${out.join("\n")}\n`;
}

/** True when the file already configures any exporter: an otel table, an `otel` key, or our block. */
export function hasOtel(text: string): boolean {
  let inTable = false;
  const all = lines(text);
  return classify(text).some((line, i) => {
    if (all[i] === OTEL_BEGIN || all[i] === OTEL_BEGIN_NEWLINE) return true;
    if (line.kind === "table") {
      inTable = true;
      return OTEL_NAME.test(line.name);
    }
    return !inTable && line.kind === "key" && /^\s*"?otel"?\s*(\.|$)/.test(line.key);
  });
}

/** The block for display. Table headers, comments and the values of the keys in SHOWN are as they
 *  are; every other value, any value under a headers table, and every continued line is <hidden>. */
export function maskedOtel(block: string): string[] {
  let headers = false;
  const all = lines(block.replace(/\n$/, ""));
  return classify(all.join("\n")).map((line, i) => {
    const raw = all[i] ?? "";
    if (line.kind === "table") {
      headers = /(^|\.)\s*"?headers"?$/.test(line.name);
      return raw;
    }
    if (line.kind === "continued") return `  ${HIDDEN}`;
    if (line.kind === "other") return raw.trim() === "" || raw.trim().startsWith("#") ? raw : HIDDEN;
    const name = line.key.trim().replace(/^"|"$/g, "");
    const plain = !/[{[]/.test(line.value);
    return !headers && plain && SHOWN.has(name) ? raw : `${line.key} = ${HIDDEN}`;
  });
}

/** The file with the block appended. A file that does not end its last line gets one line break first,
 *  and the marker records it, so taking the block out restores the file byte for byte. */
export function withOtel(original: string, block: string): string {
  const open = original === "" || original.endsWith("\n");
  return `${original}${open ? "" : "\n"}${open ? OTEL_BEGIN : OTEL_BEGIN_NEWLINE}\n${block}${OTEL_END}\n`;
}

/** The file without our block, or null when it has none (or only half of one, which is left alone). */
export function withoutOtel(text: string): string | null {
  let start = lineAt(text, OTEL_BEGIN);
  let addedBreak = false;
  if (start < 0) {
    start = lineAt(text, OTEL_BEGIN_NEWLINE);
    addedBreak = true;
  }
  if (start < 0) return null;
  const endAt = text.indexOf(`\n${OTEL_END}\n`, start);
  if (endAt < 0) return null;
  const before = text.slice(0, start);
  return (addedBreak && before.endsWith("\n") ? before.slice(0, -1) : before) + text.slice(endAt + OTEL_END.length + 2);
}

/** Where the line that is exactly `line` starts, or -1. */
function lineAt(text: string, line: string): number {
  if (text.startsWith(`${line}\n`)) return 0;
  const at = text.indexOf(`\n${line}\n`);
  return at < 0 ? -1 : at + 1;
}

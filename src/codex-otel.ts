// codex-otel.ts — CTC-7028. A Codex home named with `--codex-home` sends its telemetry.
//
// Codex reads its exporter from the `[otel]` tables of its home's config.toml. A second home (a second
// Codex login on the same machine) starts with none, so its launches send nothing, and the coding
// account `catalyst setup --only codex-attribution` resolves for it never reaches a row. Setup copies
// the default home's `[otel]` and `[otel.*]` tables, verbatim, into each named home that is logged in
// to one of the workspace's coding accounts and has no exporter of its own.
//
// ⛔ HEADER VALUES CARRY THE COLLECTOR CREDENTIAL. They are copied file to file and never printed,
// logged or put in argv: a dry run shows every value under a `*.headers` table, or of a `headers` key,
// as <hidden>.
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

function lines(text: string): string[] {
  return text.split("\n");
}

/** The `[otel]` and `[otel.*]` tables of a config.toml, each with the lines up to the next table, in
 *  file order; null when there is none. */
export function otelTables(text: string): string | null {
  const out: string[] = [];
  let inOtel = false;
  for (const line of lines(text)) {
    const table = TABLE.exec(line);
    if (table) inOtel = OTEL_NAME.test(table[1] ?? "");
    if (inOtel) out.push(line);
  }
  while (out.length > 0 && out[out.length - 1]?.trim() === "") out.pop();
  return out.length === 0 ? null : `${out.join("\n")}\n`;
}

/** True when the file already configures any exporter: an otel table, an `otel` key, or our block. */
export function hasOtel(text: string): boolean {
  let inTable = false;
  for (const line of lines(text)) {
    if (line === OTEL_BEGIN || line === OTEL_BEGIN_NEWLINE) return true;
    const table = TABLE.exec(line);
    if (table) {
      if (OTEL_NAME.test(table[1] ?? "")) return true;
      inTable = true;
      continue;
    }
    if (!inTable && /^\s*"?otel"?\s*(=|\.)/.test(line)) return true;
  }
  return false;
}

/** The block for display: each value under a headers table, or of a `headers` key, is <hidden>. */
export function maskedOtel(block: string): string[] {
  let secret = false;
  return lines(block.replace(/\n$/, "")).map((line) => {
    const table = TABLE.exec(line);
    if (table) {
      secret = /(^|\.)"?headers"?$/.test(table[1] ?? "");
      return line;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) return line;
    const key = /^(\s*[^=]+?)\s*=/.exec(line);
    if (key === null) return secret ? `  ${HIDDEN}` : line;
    return secret || /(^|\.)"?headers"?\s*$/.test(key[1]?.trim() ?? "") ? `${key[1]} = ${HIDDEN}` : line;
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

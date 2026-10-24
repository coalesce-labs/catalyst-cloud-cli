// codex-otel.test.ts: the config.toml text work behind `--codex-home` (CTC-7028): which tables are
// the exporter, when a file already has one, what a dry run may show, and that the block comes out
// byte for byte.
import { describe, expect, test } from "vitest";
import { HIDDEN, OTEL_BEGIN, OTEL_END, hasOtel, maskedOtel, otelTables, withOtel, withoutOtel } from "../src/codex-otel";

describe("the exporter tables of a config.toml", () => {
  test("every [otel] and [otel.*] table is taken, in order, and nothing else", () => {
    const text = 'a = 1\n[otel]\nx = 1\n\n[mcp.x]\ny = 2\n[otel.exporter.otlp-http]\nendpoint = "e"\n[tui]\nz = 3\n';
    expect(otelTables(text)).toBe('[otel]\nx = 1\n\n[otel.exporter.otlp-http]\nendpoint = "e"\n');
  });

  test("POSITIVE CONTROL: a file with no otel table has none", () => {
    expect(otelTables('a = 1\n[tui]\nz = 3\n')).toBeNull();
    expect(otelTables('[otel]\nx = 1\n')).not.toBeNull();
  });

  test.each([
    ["an [otel] table", "[otel]\nx = 1\n", true],
    ["an otel sub-table", "[otel.exporter.otlp-http]\nendpoint = \"e\"\n", true],
    ["a top-level otel key", "otel.environment = \"dev\"\n", true],
    ["our block", `${OTEL_BEGIN}\n${OTEL_END}\n`, true],
    ["an otel key inside another table", "[mcp]\notel = 1\n", false],
    ["no otel at all", "a = 1\n", false],
  ])("%s counts as an exporter: %s", (_label, text, expected) => {
    expect(hasOtel(text)).toBe(expected);
  });

  test("a dry run hides every header value, and a headers key in another table", () => {
    const block = '[otel.exporter.otlp-http]\nendpoint = "e"\nheaders = { "a" = "s1" }\n[otel.exporter.otlp-http.headers]\n"x-key" = "s2"\nauthorization = "s3"\n';
    const shown = maskedOtel(block).join("\n");
    for (const secret of ["s1", "s2", "s3"]) expect(shown).not.toContain(secret);
    expect(shown).toContain(`headers = ${HIDDEN}`);
    expect(shown).toContain(`"x-key" = ${HIDDEN}`);
    expect(shown).toContain('endpoint = "e"');
  });

  test.each([
    ["an inline exporter table", '[otel]\nexporter = { otlp-http = { endpoint = "e", headers = { "k" = "SEKRET" } } }\n'],
    ["a dotted headers key", '[otel.exporter."otlp-http"]\nendpoint = "e"\nheaders.x-otlp-api-key = "SEKRET"\n'],
    ["a quoted headers key", '[otel.exporter.otlp-http]\n"headers"."authorization" = "SEKRET"\n'],
    ["a multi-line inline value", '[otel.exporter.otlp-http]\nheaders = {\n  "k" = "SEKRET" }\n'],
    ["an unknown key", '[otel]\napi_token = "SEKRET"\n'],
  ])("a dry run never shows a credential spelled as %s", (_label, block) => {
    const shown = maskedOtel(block).join("\n");
    expect(shown).not.toContain("SEKRET");
    expect(shown).toContain(HIDDEN);
  });

  test("POSITIVE CONTROL: the endpoint, protocol and environment are shown as they are", () => {
    const shown = maskedOtel('[otel]\nenvironment = "dev"\n[otel.exporter.otlp-http]\nendpoint = "https://c/v1"\nprotocol = "binary"\n');
    expect(shown).toEqual(['[otel]', 'environment = "dev"', '[otel.exporter.otlp-http]', 'endpoint = "https://c/v1"', 'protocol = "binary"']);
  });

  test("a line of a multi-line array is never read as a table, so the copied tables stay whole", () => {
    const text = '[otel]\nresource = [\n  [ "a", "b" ],\n  "c",\n]\nenvironment = "dev"\n[tui]\nz = 1\n';
    expect(otelTables(text)).toBe('[otel]\nresource = [\n  [ "a", "b" ],\n  "c",\n]\nenvironment = "dev"\n');
    expect(hasOtel('a = [\n  "[otel]",\n]\n')).toBe(false);
  });

  test.each([["x = 1\n"], ["x = 1"], [""], ["a = 1\n\n"]])("the block comes out of %j byte for byte", (original) => {
    const block = "[otel]\nx = 1\n";
    expect(withoutOtel(withOtel(original, block))).toBe(original);
  });

  test("a file without the block, or with only its first marker, is left alone", () => {
    expect(withoutOtel("x = 1\n")).toBeNull();
    expect(withoutOtel(`x = 1\n${OTEL_BEGIN}\n[otel]\n`)).toBeNull();
  });
});

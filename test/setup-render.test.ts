// setup-render.test.ts — CTC-4625: what `catalyst setup` looks like on a terminal and in a pipe.
// The renderer decides colour, marks, links and width once, from the stream and the environment,
// and never lets a decoration reach a pipe.
import { describe, expect, test } from "vitest";
import {
  createSetupRenderer,
  terminalTraits,
  type SetupStream,
} from "../src/setup-render.js";

const ESC = "\u001b";
const ANSI = /\u001b\[[0-9;]*m/;
const OSC8 = /\u001b\]8;;/;

function sink(
  tty: boolean,
  columns?: number,
): SetupStream & { text(): string } {
  const chunks: string[] = [];
  return {
    isTTY: tty,
    columns,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(""),
  };
}

const tty = { TERM: "xterm-256color", LANG: "en_US.UTF-8" };

describe("terminalTraits", () => {
  test("a pipe is plain: no colour, ASCII marks, no links, 80 columns", () => {
    expect(terminalTraits(sink(false), tty)).toEqual({
      color: false,
      unicode: false,
      links: false,
      columns: 80,
    });
  });

  test("a pipe takes COLUMNS when it is a number", () => {
    expect(
      terminalTraits(sink(false), { ...tty, COLUMNS: "100" }).columns,
    ).toBe(100);
    expect(
      terminalTraits(sink(false), { ...tty, COLUMNS: "wide" }).columns,
    ).toBe(80);
  });

  test("a UTF-8 terminal gets colour and marks, and its own width", () => {
    const traits = terminalTraits(sink(true, 132), tty);
    expect(traits).toMatchObject({ color: true, unicode: true, columns: 132 });
  });

  test("NO_COLOR, TERM=dumb, no TERM or a non-UTF-8 locale fall back to plain", () => {
    for (const env of [
      { ...tty, NO_COLOR: "1" },
      { ...tty, TERM: "dumb" },
      { LANG: "en_US.UTF-8" },
      { TERM: "xterm-256color", LANG: "C" },
    ]) {
      const traits = terminalTraits(sink(true, 100), env);
      expect(traits.color, JSON.stringify(env)).toBe(false);
      expect(traits.unicode, JSON.stringify(env)).toBe(false);
      expect(traits.links, JSON.stringify(env)).toBe(false);
    }
  });

  test("OSC 8 links only on a terminal known to render them", () => {
    expect(terminalTraits(sink(true, 100), tty).links).toBe(false);
    for (const env of [
      { ...tty, TERM_PROGRAM: "iTerm.app" },
      { ...tty, TERM_PROGRAM: "WezTerm" },
      { ...tty, TERM_PROGRAM: "vscode" },
      { ...tty, TERM_PROGRAM: "ghostty" },
      { ...tty, TERM: "xterm-kitty" },
      { ...tty, VTE_VERSION: "7600" },
      { ...tty, WT_SESSION: "abc" },
      { ...tty, FORCE_HYPERLINK: "1" },
    ])
      expect(
        terminalTraits(sink(true, 100), env).links,
        JSON.stringify(env),
      ).toBe(true);
    expect(
      terminalTraits(sink(true, 100), { ...tty, VTE_VERSION: "4000" }).links,
    ).toBe(false);
    expect(
      terminalTraits(sink(true, 100), {
        ...tty,
        TERM_PROGRAM: "iTerm.app",
        FORCE_HYPERLINK: "0",
      }).links,
    ).toBe(false);
    expect(
      terminalTraits(sink(false), { ...tty, FORCE_HYPERLINK: "1" }).links,
    ).toBe(false);
  });
});

describe("createSetupRenderer, plain", () => {
  test("a step line carries the ASCII mark, number, title and outcome, with no ANSI", () => {
    const out = sink(false);
    const r = createSetupRenderer(out, tty);
    r.step("done", 4, "Sign in to Catalyst", "signed in to Acme");
    r.step("done", 2, "Skills", "already up to date");
    r.step("act", 5, "Background sync", "not confirmed");
    r.step("fail", 7, "Final check", "1 check did not pass");
    r.step("skip", 6, "Daily update", "this machine has no scheduler");
    const text = out.text();
    expect(text).not.toMatch(ANSI);
    expect(text).not.toContain(ESC);
    expect(text.split("\n")).toEqual([
      "    [done]   4 Sign in to Catalyst             signed in to Acme",
      "    [done]   2 Skills                          already up to date",
      "    [!]      5 Background sync                 not confirmed",
      "    [fail]   7 Final check                     1 check did not pass",
      "    [skip]   6 Daily update                    this machine has no scheduler",
      "",
    ]);
  });

  test("a link in a pipe is the bare URL", () => {
    const out = sink(false);
    const r = createSetupRenderer(out, { ...tty, FORCE_HYPERLINK: "1" });
    r.detail(`Open ${r.link("https://example.com/activate?code=ABCD")}`);
    expect(out.text()).toBe(
      "        Open https://example.com/activate?code=ABCD\n",
    );
  });

  test("details wrap at 80 columns with a hanging indent, never mid-word", () => {
    const out = sink(false);
    const r = createSetupRenderer(out, tty);
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    r.detail(words);
    const lines = out.text().trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line.startsWith("        word")).toBe(true);
    }
    expect(lines.map((l) => l.trim()).join(" ")).toBe(words);
  });

  test("a URL longer than the room stays whole on its own line", () => {
    const out = sink(false);
    const r = createSetupRenderer(out, tty);
    const url = `https://example.com/${"x".repeat(120)}`;
    r.detail(`Open this link: ${url} now`);
    const lines = out
      .text()
      .trimEnd()
      .split("\n")
      .map((l) => l.trim());
    expect(lines).toContain(url);
  });

  test("a wrapped step outcome continues under the outcome, not under the mark", () => {
    const out = sink(false);
    const r = createSetupRenderer(out, tty);
    r.step(
      "done",
      3,
      "Folders",
      Array.from({ length: 20 }, () => "created").join(" "),
    );
    const [first, second] = out.text().split("\n");
    expect(first.length).toBeLessThanOrEqual(80);
    expect(second.startsWith(" ".repeat(43))).toBe(true);
  });

  test("a heading and a blank line are plain text", () => {
    const out = sink(false);
    const r = createSetupRenderer(out, tty);
    r.heading("Setting up");
    r.blank();
    expect(out.text()).toBe("\n  Setting up\n\n");
  });

  test("the call to action prints as plain text first in a pipe", () => {
    const out = sink(false);
    const r = createSetupRenderer(out, tty);
    r.action("Approve this computer in your browser");
    expect(out.text()).toBe(
      "        Approve this computer in your browser\n",
    );
  });
});

describe("createSetupRenderer, terminal", () => {
  test("marks are a coloured ✓ ! ✗ – and the text is unchanged", () => {
    const out = sink(true, 100);
    const r = createSetupRenderer(out, tty);
    r.step("done", 1, "Catalyst command", "installed 0.15.0");
    r.step("act", 5, "Background sync", "not confirmed");
    r.step("fail", 7, "Final check", "1 check did not pass");
    r.step("skip", 6, "Daily update", "no scheduler");
    const text = out.text();
    expect(text).toMatch(ANSI);
    const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toContain(
      "✓   1 Catalyst command                installed 0.15.0",
    );
    expect(plain).toContain(
      "▲   5 Background sync                 not confirmed",
    );
    expect(plain).toContain(
      "✗   7 Final check                     1 check did not pass",
    );
    expect(plain).toContain(
      "–   6 Daily update                    no scheduler",
    );
  });

  test("a link is OSC 8 around the visible URL on a capable terminal", () => {
    const out = sink(true, 100);
    const r = createSetupRenderer(out, { ...tty, TERM_PROGRAM: "iTerm.app" });
    const url = "https://example.com/activate";
    r.detail(r.link(url));
    const text = out.text();
    expect(text).toMatch(OSC8);
    expect(text).toContain(`${ESC}]8;;${url}${ESC}\\${url}${ESC}]8;;${ESC}\\`);
  });

  test("a link is the bare URL on a terminal not known to render OSC 8", () => {
    const out = sink(true, 100);
    const r = createSetupRenderer(out, tty);
    r.detail(r.link("https://example.com/activate"));
    expect(out.text()).not.toMatch(OSC8);
    expect(out.text()).toContain("https://example.com/activate");
  });

  test("wrapping counts visible width only, so colour and links never shorten a line", () => {
    const out = sink(true, 60);
    const r = createSetupRenderer(out, { ...tty, TERM_PROGRAM: "iTerm.app" });
    r.detail(`${r.link("https://example.com/a")} ${"word ".repeat(20).trim()}`);
    const visible = out
      .text()
      .replace(/\u001b\]8;;[^\u001b]*\u001b\\/g, "")
      .replace(/\u001b\[[0-9;]*m/g, "")
      .trimEnd()
      .split("\n");
    for (const line of visible) expect(line.length).toBeLessThanOrEqual(60);
    expect(visible.length).toBeGreaterThan(1);
  });

  test("the call to action is bold on a terminal", () => {
    const out = sink(true, 100);
    const r = createSetupRenderer(out, tty);
    r.action("Approve this computer in your browser");
    expect(out.text()).toContain(`${ESC}[1m`);
  });
});

const visible = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

test("spec states distinguish action, later and optional results", () => {
  const out = sink(true, 80);
  const r = createSetupRenderer(out, tty);
  r.step("act", 11, "Install Catalyst on GitHub", "not installed yet");
  r.step("later", 13, "Choose repositories", "after step 11");
  r.step("skip", 5, "Schedule the daily update", "no scheduler here");
  expect(visible(out.text())).toContain("▲  11 Install Catalyst on GitHub");
  expect(visible(out.text())).toContain("·  13 Choose repositories");
  expect(visible(out.text())).toContain("–   5 Schedule the daily update");
});

test.each([60, 80, 120])("indent columns and wrapping at %i", (columns) => {
  const out = sink(true, columns);
  const r = createSetupRenderer(out, tty);
  r.intro("Catalyst setup");
  r.heading("GitHub");
  r.step("done", 12, "Connect your GitHub account", "connected as samlee");
  r.detail("Open this link and connect your GitHub account:");
  const url =
    "https://staging.catalystcloud.dev/settings/connected-accounts?connect=github";
  r.detail(url);
  r.outro("Next: run catalyst onboard");
  const lines = visible(out.text()).trimEnd().split("\n");
  // CTC-4680 round 2: headings and prose at 2, step rows at 4, details at 8. A URL too long for
  // its column starts at 2, on its own line.
  expect(lines.every((l) => l === "" || /^  \S/.test(l) || /^ {4}\S/.test(l) || /^ {8}\S/.test(l))).toBe(true);
  for (const l of lines)
    if (!l.includes(url))
      expect(l.length).toBeLessThanOrEqual(Math.min(columns, 100));
  expect(lines.find((l) => l.includes(url))!.trim()).toContain(url);
  expect(lines.find((l) => l.includes("GitHub") && !l.includes("Connect"))).toBe("  GitHub");
  const step = lines.find((l) => l.startsWith("    ✓"))!;
  expect(step.indexOf("Connect")).toBe(10);
  if (columns >= 80) expect(step.indexOf("connected")).toBe(42);
  else expect(lines).toContain("        connected as samlee");
  expect(lines.find((l) => l.includes("Open this link"))!.indexOf("Open")).toBe(8);
  expect(lines.at(-1)).toBe("  Next: run catalyst onboard");
});

test("empty NO_COLOR is plain too", () => {
  expect(terminalTraits(sink(true), { ...tty, NO_COLOR: "" }).unicode).toBe(
    false,
  );
});

test("live detail prints immediately and resolution clears the entire block", () => {
  const out = sink(true, 80);
  const r = createSetupRenderer(out, tty);
  r.begin(4, "Sign in to Catalyst", "waiting for you · 9:41 left");
  r.detail("Enter ABCD-1234");
  expect(out.text()).toContain("ABCD-1234");
  r.resolve("done", "sam@acme.dev, admin of Acme");
  expect(out.text()).toContain("\u001b[J");
  expect(visible(out.text()).trimEnd()).toContain(
    "sam@acme.dev, admin of Acme",
  );
  r.dispose();
});

test("a soft-wrapped URL counts its physical terminal rows", () => {
  const out = sink(true, 60);
  const r = createSetupRenderer(out, tty);
  r.begin(11, "Install Catalyst on GitHub", "waiting");
  r.detail(
    "https://staging.catalystcloud.dev/settings/connections?install=github",
  );
  const before = out.text();
  r.update("still waiting");
  const tail = out.text().slice(before.length);
  expect(tail).toMatch(/^\u001b\[4A/);
  r.dispose();
});

test("resize leaves the old live block and uses the new width for the next step", () => {
  let columns = 80;
  const chunks: string[] = [];
  const out: SetupStream = {
    isTTY: true,
    get columns() {
      return columns;
    },
    write(s) {
      chunks.push(s);
      return true;
    },
  };
  const r = createSetupRenderer(out, tty);
  r.begin(4, "Sign in to Catalyst", "waiting");
  columns = 60;
  process.emit("SIGWINCH");
  const before = chunks.length;
  r.update("still waiting");
  r.detail("code ABCD-1234");
  r.resolve("done", "signed in");
  expect(chunks.slice(before).join("")).not.toContain("\u001b[" + "1A");
  const next = chunks.length;
  r.begin(11, "Install Catalyst on GitHub", "waiting for you");
  expect(visible(chunks.slice(next).join(""))).toContain(
    "\n        waiting for you",
  );
  r.dispose();
});

test("live listener is released at resolution and suspension", () => {
  const count = process.listenerCount("SIGWINCH");
  const r = createSetupRenderer(sink(true, 80), tty);
  expect(process.listenerCount("SIGWINCH")).toBe(count);
  r.begin(4, "Sign in to Catalyst");
  expect(process.listenerCount("SIGWINCH")).toBe(count + 1);
  r.resolve("done", "connected");
  expect(process.listenerCount("SIGWINCH")).toBe(count);
  r.begin(11, "Install Catalyst on GitHub");
  r.suspendLive();
  expect(process.listenerCount("SIGWINCH")).toBe(count);
  r.dispose();
});

test("changing section preserves an unresolved step in the scrollback", () => {
  const out = sink(true, 80);
  const r = createSetupRenderer(out, tty);
  r.begin(4, "Sign in to Catalyst", "waiting");
  const before = out.text().length;
  r.heading("GitHub");
  expect(out.text().slice(before)).not.toContain("\u001b[J");
  r.dispose();
});

test("wide titles align outcomes by terminal cells", () => {
  const out = sink(true, 80);
  const r = createSetupRenderer(out, tty);
  r.step("done", 8, "選択", "selected");
  expect(visible(out.text())).toContain("選択" + " ".repeat(28) + "selected");
  r.dispose();
});

test("a live block beyond eight physical rows switches to append output", () => {
  const out = sink(true, 80);
  const r = createSetupRenderer(out, tty);
  r.begin(4, "Sign in to Catalyst", "waiting");
  for (let i = 0; i < 9; i++) r.detail("row " + i);
  const before = out.text().length;
  r.update("still waiting");
  r.resolve("done", "connected");
  expect(out.text().slice(before)).not.toContain("\u001b[J");
  r.dispose();
});

test("ordinary output preserves a live region below it", () => {
  const out = sink(true, 80);
  const r = createSetupRenderer(out, tty);
  r.begin(4, "Sign in to Catalyst", "waiting");
  const before = out.text().length;
  r.line("diagnostic");
  r.update("still waiting");
  expect(out.text().slice(before)).toMatch(
    /\u001b\[1A\r\u001b\[J  diagnostic\n/,
  );
  r.dispose();
});

test("a resize between steps uses current stream width", () => {
  let columns = 80;
  const chunks: string[] = [];
  const out: SetupStream = {
    isTTY: true,
    get columns() {
      return columns;
    },
    write(s) {
      chunks.push(s);
      return true;
    },
  };
  const r = createSetupRenderer(out, tty);
  r.step("done", 1, "Install Catalyst", "installed");
  columns = 60;
  r.step("done", 2, "Add the Catalyst skills", "ready");
  expect(visible(chunks.at(-1)!)).toContain("\n        ready");
  r.dispose();
});

test("line preserves explicit continuation indentation", () => {
  const out = sink(true, 80);
  const r = createSetupRenderer(out, tty);
  r.line("       continuation");
  expect(visible(out.text())).toBe("         continuation\n");
  r.dispose();
});

test("a single digit COLUMNS gets the width floor", () => {
  expect(terminalTraits(sink(false), { COLUMNS: "9" }).columns).toBe(40);
});

test("fast automatic steps only print their outcome", () => {
  const out = sink(true, 80);
  const r = createSetupRenderer(out, tty);
  r.begin(1, "Install the catalyst command");
  expect(out.text()).toBe("");
  r.resolve("done", "installed");
  expect(visible(out.text())).toMatch(/^ {4}✓/);
  expect(out.text()).not.toContain("checking");
  r.dispose();
});
test("browser instructions do not wait for the working delay", () => {
  const out = sink(true, 80);
  const r = createSetupRenderer(out, tty);
  r.begin(4, "Sign in to Catalyst");
  r.detail("Enter ABCD-1234");
  expect(out.text()).toContain("ABCD-1234");
  r.dispose();
});

test("ordinary output during the working delay never paints a quick checking frame", () => {
  const out = sink(true);
  const r = createSetupRenderer(out, {
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  });
  r.begin(1, "Install catalyst");
  r.line("a note");
  r.resolve("done", "installed");
  expect(out.text()).not.toContain("checking");
  r.dispose();
});

// CTC-6180: a command after the first line is copied as is, so it is never wrapped at a space.
test.each([true, false])("a command line in an item stays whole at 80 columns (tty %s)", (terminal) => {
  const out = sink(terminal, 80);
  const r = createSetupRenderer(out, tty);
  const command =
    "sudo sh '/home/tony/.npm-global/lib/node_modules/@catalyst-cloud/cli/vendor/install-session-egress.sh'";
  r.item(
    "2. ",
    "Native Linux needs a root-managed session egress service before this computer can take work. Run this, then run the same setup command:\n" +
      command,
  );
  const lines = out.text().split("\n");
  expect(lines).toContain(`     ${command}`);
  expect(lines.filter((line) => line.includes("sudo"))).toHaveLength(1);
  expect(lines.slice(0, 2).every((line) => line.length <= 80)).toBe(true);
});

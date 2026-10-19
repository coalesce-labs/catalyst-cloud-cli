// setup-render.ts — CTC-4625: how `catalyst setup` looks. The terminal's traits come
// from the stream and the environment, and every line goes through here: a pipe, a log or a dumb
// terminal gets the same words in plain ASCII, never an escape sequence.
//
// ⛔ EVERY LINE IS WRITTEN WHEN IT IS PRINTED. Nothing here collects lines to wrap or align them
// later: the sign-in code must reach the screen before the wait for approval starts (the 0.13.9
// installer piped its login through fold, which held the code until the deadline discarded it).
import { styleText } from "node:util";
import { wrapAnsi } from "fast-wrap-ansi";
import stringWidth from "fast-string-width";
import {
  colourLevel,
  markSkipped,
  markSpan,
  pixelNucleusLines,
} from "./setup-brand.js";
import {
  detectTheme,
  envTheme,
  type QueryInput,
  type Theme,
} from "./terminal-background.js";

/** The part of a writable stream the renderer uses; process.stdout and process.stderr fit. */
export interface SetupStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write(chunk: string): boolean;
}

export interface TerminalTraits {
  /** Colour and bold. */
  readonly color: boolean;
  /** ✓ ! ✗ – instead of [done] [!] [fail] [skip]. */
  readonly unicode: boolean;
  /** OSC 8 hyperlinks around the visible URL. */
  readonly links: boolean;
  readonly columns: number;
}

export type StepMark =
  "done" | "fail" | "act" | "skip" | "later" | "run" | "ask" | "now";

const DEFAULT_COLUMNS = 80;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MIN_COLUMNS = 40;

function utf8Locale(env: NodeJS.ProcessEnv): boolean {
  return /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "");
}

/**
 * OSC 8 is shown only where a terminal is known to render it: an unknown one may print the escape
 * as text. FORCE_HYPERLINK=1 or 0 overrides the list, as in the supports-hyperlinks convention.
 */
function hyperlinkTerminal(env: NodeJS.ProcessEnv): boolean {
  if (env.FORCE_HYPERLINK === "0") return false;
  if (env.FORCE_HYPERLINK === "1") return true;
  const program = env.TERM_PROGRAM ?? "";
  if (["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper"].includes(program))
    return true;
  if ((env.TERM ?? "").includes("kitty") || env.TERM === "alacritty")
    return true;
  if (env.WT_SESSION) return true;
  const vte = Number.parseInt(env.VTE_VERSION ?? "", 10);
  return Number.isFinite(vte) && vte >= 5000;
}

export function terminalTraits(
  stream: SetupStream,
  env: NodeJS.ProcessEnv,
): TerminalTraits {
  const fancy =
    stream.isTTY === true &&
    env.NO_COLOR === undefined &&
    Boolean(env.TERM) &&
    env.TERM !== "dumb" &&
    utf8Locale(env);
  let columns = DEFAULT_COLUMNS;
  if (
    stream.isTTY === true &&
    typeof stream.columns === "number" &&
    stream.columns > 0
  )
    columns = stream.columns;
  else if (/^[1-9][0-9]{0,3}$/.test(env.COLUMNS ?? ""))
    columns = Number(env.COLUMNS);
  return {
    color: fancy,
    unicode: fancy,
    links: fancy && hyperlinkTerminal(env),
    columns: Math.max(MIN_COLUMNS, columns),
  };
}

const ASCII_MARKS: Record<StepMark, string> = {
  done: "[done]",
  fail: "[fail]",
  act: "[!]",
  skip: "[skip]",
  later: "[later]",
  run: "[..]",
  ask: "[?]",
  now: "[next]",
};
const UNICODE_MARKS: Record<
  StepMark,
  [string, Parameters<typeof styleText>[0]]
> = {
  done: ["✓", "green"],
  fail: ["✗", "red"],
  act: ["▲", "yellow"],
  skip: ["–", "gray"],
  later: ["·", "gray"],
  run: ["◐", "cyan"],
  ask: ["◆", "cyan"],
  now: ["◆", "cyan"],
};

/** One part in setup's three-part tracker. */
export interface TrackerRow {
  readonly mark: StepMark;
  readonly number: number;
  readonly title: string;
  readonly note: string;
}

export interface SetupRenderer {
  intro(title: string): void;
  /** CTC-4680: "Catalyst Cloud", the program and version and, once known, who and where, once per
   *  program start, beside the Pixel Nucleus mark where the banner options allow it (see
   *  markSkipped) and as plain lines otherwise. True when the words included the identity. */
  brand(
    program: string,
    version?: string,
    identity?: { readonly user: string; readonly workspace: string },
  ): boolean;
  /** Setup's parts, one row each, like step rows but never touching the live step. */
  tracker(rows: readonly TrackerRow[]): void;
  outro(text: string): void;
  plan(number: number, title: string, detail: string): void;
  begin(
    number: number,
    title: string,
    status?: string,
    mark?: "run" | "ask",
  ): void;
  update(status: string): void;
  resolve(mark: StepMark, outcome: string): void;
  suspendLive(): void;
  promptRows(rows: number | null): void;
  dispose(): void;
  readonly traits: TerminalTraits;
  /** One step's outcome: `<mark> <number> <title>  <outcome>`, wrapped under the outcome. */
  step(mark: StepMark, number: number, title: string, outcome: string): void;
  /** An indented line under the current step. */
  detail(text: string): void;
  replaceLastDetail(text: string): void;
  /** The one thing the person must do now: bold on a terminal. */
  action(text: string): void;
  heading(text: string): void;
  /** Prose at column 2, with the headings. */
  line(text: string): void;
  /** A list item: `label` at column 2 and its text hanging after it when it wraps. */
  item(label: string, text: string): void;
  blank(): void;
  /** A URL, clickable where the terminal renders OSC 8, always visible as text. */
  link(url: string): string;
  bold(text: string): string;
  dim(text: string): string;
  /** The run's one closing verdict: bold green or bold red on a terminal. */
  verdict(ok: boolean, text: string): string;
  mark(mark: StepMark): string;
}

/** CTC-4680: where and how the banner is drawn. */
export interface BannerOptions {
  /** Draw the mark. Only `catalyst setup` sets this; every other verb gets the words alone. */
  readonly mark?: boolean;
  /** Where the banner goes (stderr in the CLI); the renderer's own stream when left out. */
  readonly stream?: SetupStream;
  /** The detected background; CATALYST_THEME, then COLORFGBG, then dark when left out. */
  readonly theme?: Theme;
  /** --no-color. */
  readonly noColor?: boolean;
}

/**
 * The banner options for the onboard flow: the mark only for `catalyst setup`, and the background
 * asked of the terminal only when the mark will be drawn and both stdin and stdout are terminals.
 */
export async function setupBanner(options: {
  readonly setup: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly input: QueryInput;
  readonly stdout: { readonly isTTY?: boolean };
  readonly stream: SetupStream;
  readonly noColor?: boolean;
}): Promise<BannerOptions> {
  const { setup, env, input, stream, noColor } = options;
  const tty = stream.isTTY === true && options.stdout.isTTY === true;
  const columns =
    stream.columns && stream.columns > 0 ? stream.columns : DEFAULT_COLUMNS;
  const ask =
    !markSkipped({ setup, tty, columns, env, noColor }) && input.isTTY === true
      ? { input, output: stream }
      : undefined;
  return { mark: setup, stream, noColor, theme: await detectTheme(env, ask) };
}

export function createSetupRenderer(
  stream: SetupStream,
  env: NodeJS.ProcessEnv,
  banner: BannerOptions = {},
): SetupRenderer {
  let traits = terminalTraits(stream, env);
  const style = (format: Parameters<typeof styleText>[0], text: string) =>
    traits.color ? styleText(format, text, { validateStream: false }) : text;
  let width = Math.min(traits.columns, 100);
  const refresh = () => {
    const next = terminalTraits(stream, env);
    if (live && next.columns !== traits.columns) live.resized = true;
    traits = next;
    width = Math.min(traits.columns, 100);
  };
  let frame = 1;
  const visible = (text: string) =>
    text
      .replace(/\u001b\]8;;[^\u001b]*\u001b\\/g, "")
      .replace(/\u001b\[[0-9;]*m/g, "");
  // CTC-4680 (round 2): headings and prose at column 2, step rows at 4, and their details 4 more,
  // at 8, so the eye doesn't travel across a small screen to read them. No rail: the same columns
  // on a terminal and in a pipe.
  const textCol = 2;
  const rowCol = 4;
  const titleCol = rowCol + 4;
  const outcomeCol = rowCol + (traits.unicode ? 38 : 43);
  const prefix = (col: number) => " ".repeat(col);
  const mark = (kind: StepMark) => {
    if (!traits.unicode) return ASCII_MARKS[kind];
    const [glyph, colour] = UNICODE_MARKS[kind];
    return style(
      colour,
      kind === "run" ? ["◒", "◐", "◓", "◑"][frame % 4]! : glyph,
    );
  };
  const rows = (text: string, col: number): string[] => {
    refresh();
    const indent = /^ */.exec(text)?.[0].length ?? 0;
    col += indent;
    text = text.slice(indent);
    // CTC-6180: each line after the first is a command a person copies, so it is never wrapped.
    const [prose = "", ...commands] = text.split("\n");
    return [...wrapAnsi(prose, Math.max(1, width - col), {
      hard: false,
      wordWrap: true,
      trim: true,
    })
      .split("\n")
      .map((line) => {
        const plain = visible(line);
        const indent =
          /^https?:\/\/\S+$/.test(plain) && stringWidth(plain) > width - col
            ? textCol
            : col;
        return prefix(indent) + line;
      }), ...commands.map((command) => prefix(col) + command)];
  };
  const stepRows = (
    kind: StepMark,
    number: number,
    title: string,
    outcome: string,
    plan = false,
  ): string[] => {
    refresh();
    const lead = plan
      ? traits.unicode
        ? " "
        : "       "
      : traits.unicode
        ? mark(kind)
        : mark(kind).padEnd(7);
    const titleWidth = stringWidth(visible(title));
    const label = `${prefix(rowCol)}${lead}${traits.unicode ? "  " : " "}${String(number || "").padStart(2)} ${title}`;
    if (!outcome) return [label];
    if (width < 80 || titleWidth > 30)
      return [label, ...rows(outcome, titleCol)];
    const padding = " ".repeat(Math.max(2, 32 - titleWidth));
    const wrapped = wrapAnsi(outcome, width - outcomeCol, {
      hard: false,
      wordWrap: true,
      trim: true,
    }).split("\n");
    return [
      `${label}${padding}${wrapped[0]}`,
      ...wrapped.slice(1).map((l) => prefix(outcomeCol) + l),
    ];
  };
  const write = (lines: string[]) => stream.write(lines.join("\n") + "\n");
  let live:
    | {
        number: number;
        title: string;
        status: string;
        mark: "run" | "ask";
        details: string[];
        height: number;
        resized: boolean;
      }
    | undefined;
  const clear = () => {
    if (live && traits.unicode && !live.resized && live.height)
      stream.write(`\u001b[${live.height}A\r\u001b[J`);
  };
  let workingTimer: ReturnType<typeof setTimeout> | undefined;
  const flushWorking = () => {
    if (workingTimer) {
      clearTimeout(workingTimer);
      workingTimer = undefined;
      paint();
    }
  };
  let listening = false;
  const releaseListener = () => {
    if (listening) {
      process.off("SIGWINCH", resize);
      listening = false;
    }
  };
  const abandon = () => {
    if (workingTimer) clearTimeout(workingTimer);
    workingTimer = undefined;
    live = undefined;
    releaseListener();
  };
  const paint = () => {
    if (!live || live.resized) return;
    const lines = [
      ...stepRows(
        live.mark,
        live.number,
        style("bold", live.title),
        live.status,
      ),
      ...live.details.flatMap((t) => rows(t, titleCol)),
    ];
    const physicalWidth =
      stream.columns && stream.columns > 0 ? stream.columns : traits.columns;
    const physicalRows = lines.reduce(
      (n, line) =>
        n + Math.max(1, Math.ceil(stringWidth(visible(line)) / physicalWidth)),
      0,
    );
    if (traits.unicode) {
      clear();
      write(lines);
      live.height = physicalRows;
      // A taller block cannot be safely erased in a short terminal. Keep its scrollback instead.
      if (physicalRows > 8) live.resized = true;
    } else if (!live.height) {
      write(lines);
      live.height = physicalRows;
    }
  };
  const resize = () => {
    if (live) live.resized = true;
    refresh();
  };
  const ordinary = (lines: string[]) => {
    if (live && traits.unicode && !live.resized) {
      clear();
      live.height = 0;
      write(lines);
      if (!workingTimer) paint();
    } else write(lines);
  };
  const suspendLive = () => {
    clear();
    abandon();
  };
  let branded = false;
  const r: SetupRenderer = {
    get traits() {
      refresh();
      return traits;
    },
    intro(title) {
      refresh();
      ordinary([prefix(textCol) + style("bold", title)]);
    },
    brand(program, version, identity) {
      if (branded) return false;
      branded = true;
      refresh();
      const out = banner.stream ?? stream;
      const tty = out.isTTY === true && stream.isTTY === true;
      const columns =
        tty && out.columns && out.columns > 0 ? out.columns : traits.columns;
      const separator = utf8Locale(env) ? " · " : " ";
      const words = [
        "Catalyst Cloud",
        `${program}${version ? `${separator}${version}` : ""}`,
        ...(identity
          ? [`user:      ${identity.user}`, `workspace: ${identity.workspace}`]
          : []),
      ];
      const print = (lines: string[]) => out.write(lines.join("\n") + "\n");
      const level = colourLevel(env, { tty, noColor: banner.noColor });
      if (
        level === "none" ||
        markSkipped({ setup: banner.mark === true, tty, columns, env, noColor: banner.noColor })
      ) {
        // Without the mark the words carry everything, plainly: a screen reader reads blocks aloud.
        print(words.map((w) => prefix(textCol) + w));
        return identity !== undefined;
      }
      // Beside the middle of the mark, 4 columns from it, each cut short with … rather than
      // wrapped under it when the terminal is narrow.
      const textAt = textCol + markSpan() + 4;
      const room = columns - textAt - 1;
      const fit = (text: string) => {
        if (stringWidth(text) <= room) return text;
        // Cut by what the terminal draws: whole graphemes, counted in columns.
        let cut = "";
        for (const { segment } of graphemes.segment(text)) {
          if (stringWidth(cut + segment) > room - 1) break;
          cut += segment;
        }
        return `${cut}…`;
      };
      const styled = words.map((w, i) =>
        i === 0 && fit(w) === w ? `\u001b[1m${w}\u001b[22m` : fit(w),
      );
      const mark = pixelNucleusLines(
        banner.theme ?? envTheme(env) ?? "dark",
        level,
      );
      const first = Math.floor((mark.length - styled.length) / 2);
      print(
        mark.map((line, i) => {
          const text = styled[i - first];
          return text
            ? `${prefix(textCol)}${line}    ${text}`
            : `${prefix(textCol)}${line}`.trimEnd();
        }),
      );
      return identity !== undefined;
    },
    tracker(parts) {
      ordinary(
        parts.flatMap((p) => stepRows(p.mark, p.number, p.title, p.note)),
      );
    },
    outro(text) {
      abandon();
      // Wrapped by words like any prose, a link kept whole on its own line when it is too long.
      write(["", ...rows(text, textCol)]);
    },
    plan(number, title, text) {
      ordinary(stepRows("run", number, title, text, true));
      if (width < 80) r.blank();
    },
    begin(number, title, status = "checking…", kind = "run") {
      if (live?.number === number) suspendLive();
      else abandon();
      if (traits.unicode && !listening) {
        process.on("SIGWINCH", resize);
        listening = true;
      }
      live = {
        number,
        title,
        status,
        mark: kind,
        details: [],
        height: 0,
        resized: false,
      };
      if (status === "checking…" && kind === "run") {
        workingTimer = setTimeout(() => {
          workingTimer = undefined;
          paint();
        }, 300);
        workingTimer.unref();
      } else paint();
    },
    update(status) {
      if (live) {
        live.status = status;
        frame++;
        if (workingTimer && /waiting|new code/.test(status)) flushWorking();
        else if (!workingTimer) paint();
      }
    },
    resolve(kind, outcome) {
      if (!live) return;
      const { number, title } = live;
      clear();
      abandon();
      write(stepRows(kind, number, title, outcome));
    },
    suspendLive,
    promptRows(rows) {
      if (live) {
        if (rows === null) live.resized = true;
        else live.height += rows;
      }
    },
    dispose() {
      abandon();
    },
    step(kind, number, title, outcome) {
      if (live && live.number === number) r.resolve(kind, outcome);
      else ordinary(stepRows(kind, number, title, outcome));
    },
    detail(text) {
      flushWorking();
      if (live && traits.unicode && !live.resized) {
        live.details.push(text);
        paint();
      } else write(rows(text, titleCol));
    },
    replaceLastDetail(text) {
      if (live && traits.unicode && !live.resized && live.details.length) {
        live.details[live.details.length - 1] = text;
        paint();
      } else r.detail(text);
    },
    action(text) {
      r.detail(style("bold", text));
    },
    heading(text) {
      abandon();
      write(["", prefix(textCol) + style("bold", text)]);
    },
    line(text) {
      ordinary(rows(text, textCol));
    },
    item(label, text) {
      const col = textCol + stringWidth(label);
      const lines = rows(text, col);
      const hang = prefix(col);
      ordinary(
        lines[0]!.startsWith(hang)
          ? [prefix(textCol) + label + lines[0]!.slice(col), ...lines.slice(1)]
          : [prefix(textCol) + label.trimEnd(), ...lines],
      );
    },
    blank() {
      refresh();
      ordinary([""]);
    },
    link(url) {
      return traits.links
        ? `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\`
        : url;
    },
    bold: (text) => style("bold", text),
    dim: (text) => style("dim", text),
    verdict: (ok, text) => style(["bold", ok ? "green" : "red"], text),
    mark,
  };
  return r;
}

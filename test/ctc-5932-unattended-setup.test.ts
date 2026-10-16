// ctc-5932-unattended-setup.test.ts — a setup run with no one to answer says what it chose and
// skipped, never calls an unconnected part done, and names the exact flags a choice needs.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { createClackOnboardUi } from "../src/onboard-ui.js";
import { onboardReasonText } from "../src/onboard-next.js";
import { ONBOARD_STEPS, type OnboardJournal, type OnboardStepId } from "../src/onboard.js";
import { setupPartProgress, unattendedSkipLines } from "../src/setup-onboard-copy.js";
import { createSetupRenderer } from "../src/setup-render.js";

type Step = OnboardJournal["steps"][number];
const ANSI = /\u001b\[[0-9;]*m/g;

function journalWith(states: Partial<Record<OnboardStepId, Partial<Step>>>): OnboardJournal {
  return {
    schema: 1,
    runId: "ctc-5932",
    installer: null,
    cli: "0.16.15",
    tenant: null,
    exit: 11,
    complete: false,
    changes: [],
    steps: ONBOARD_STEPS.map((id) => ({ id, state: "pending" as const, ...states[id] })),
  };
}

const MACHINE = { machine: { state: "done" }, cli: { state: "done" }, skills: { state: "done" }, legacy: { state: "done" }, signin: { state: "done" }, housekeeping: { state: "done" } } as const;
/** What a piped run leaves: every browser approval waiting, and no runner chosen. */
const PIPED = journalWith({
  ...MACHINE,
  "linear.workspace": { state: "waiting", reason: "workspace_approval_required" },
  "linear.personal": { state: "waiting", reason: "personal_approval_required" },
  "linear.team": { state: "waiting", reason: "prerequisite_not_ready" },
  "github.install": { state: "waiting", reason: "github_installation_approval_required" },
  "github.personal": { state: "waiting", reason: "personal_approval_required" },
  runner: { state: "skipped", reason: "runner_not_selected" },
});
const CONNECTED = journalWith({
  ...MACHINE,
  "linear.workspace": { state: "done" },
  "linear.personal": { state: "done" },
  "github.install": { state: "done" },
  "github.personal": { state: "done" },
});

describe("CTC-5932 — what an unattended run left out", () => {
  test("a piped run says it chose no runner and skipped Linear and GitHub, with the commands that resume", () => {
    expect(unattendedSkipLines(PIPED)).toEqual([
      "Setup ran without questions, so it chose no runner: this computer will not run tickets.",
      "To add one, run in a terminal: catalyst setup --runner",
      "Linear and GitHub were skipped, because they need you in a browser. Not connected: Connect your Linear workspace, Connect your Linear account, Install Catalyst on GitHub, Connect your GitHub account.",
      "To connect them, run in a terminal: catalyst setup",
    ]);
  });

  test("a runner chosen or declined by flag is not repeated back", () => {
    expect(unattendedSkipLines(PIPED, { runner: false }).join("\n")).not.toContain("chose no runner");
    expect(unattendedSkipLines(PIPED, { runner: true }).join("\n")).not.toContain("chose no runner");
  });

  test("connections that are done are never called skipped", () => {
    expect(unattendedSkipLines(CONNECTED, { runner: true })).toEqual([]);
  });

  test("a scoped run speaks only of its own steps", () => {
    expect(unattendedSkipLines(PIPED, { scope: ["runner"] })).toHaveLength(2);
    expect(unattendedSkipLines(PIPED, { scope: ["linear.workspace"] })).toEqual([
      "Linear and GitHub were skipped, because they need you in a browser. Not connected: Connect your Linear workspace.",
      "To connect them, run in a terminal: catalyst setup",
    ]);
  });
});

describe("CTC-5932 — a part is done only when its skips were choices", () => {
  test("skipped connections never finish part 2", () => {
    const skipped = journalWith({
      ...MACHINE,
      "linear.workspace": { state: "skipped" },
      "linear.personal": { state: "skipped" },
      "linear.team": { state: "skipped" },
      "linear.adopt": { state: "skipped" },
      "linear.automations": { state: "skipped" },
      "github.install": { state: "skipped" },
      "github.personal": { state: "skipped" },
    });
    const part2 = setupPartProgress(skipped)[2];
    expect(part2.done).toBe(0);
    expect(part2.total).toBe(7);
  });

  test("positive control: a runner skipped by choice still finishes its row", () => {
    const withRunner = setupPartProgress(PIPED)[3];
    const without = setupPartProgress(journalWith({ ...MACHINE, runner: { state: "skipped", reason: "interrupted" } }))[3];
    expect(withRunner.done).toBe(1);
    expect(without.done).toBe(0);
  });
});

function ui(interactive: boolean) {
  const output = new PassThrough();
  Object.assign(output, { isTTY: false, columns: 200 });
  let text = "";
  output.on("data", (chunk) => (text += chunk));
  const quiet = () => {};
  const made = createClackOnboardUi(
    {
      intro: quiet,
      outro: quiet,
      log: { message: quiet, info: quiet, warn: quiet, error: quiet },
      select: async () => "stop",
      isCancel: () => false,
    },
    { input: new PassThrough(), output },
    { renderer: createSetupRenderer(output, { NO_COLOR: "1" }), interactive, signals: new EventEmitter(), version: "0.16.15" },
  );
  return { made, text: () => text.replace(ANSI, "") };
}

describe("CTC-5932 — the end screen of a run with no terminal", () => {
  test("says what it skipped and never that Linear and GitHub are connected", () => {
    const f = ui(false);
    f.made.plan(PIPED);
    f.made.finish(PIPED);
    const text = f.text().replace(/\s+/g, " ");
    expect(text).toContain("so it chose no runner: this computer will not run tickets.");
    expect(text).toContain("To add one, run in a terminal: catalyst setup --runner");
    expect(text).toContain("Linear and GitHub were skipped, because they need you in a browser.");
    expect(text).not.toContain("Linear and GitHub are connected");
    f.made.dispose();
  });

  test("positive control: a person at a terminal answered for themselves, so the lines stay out", () => {
    const f = ui(true);
    f.made.finish(PIPED);
    expect(f.text()).not.toContain("Setup ran without questions");
    f.made.dispose();
  });
});

describe("CTC-5932 — a choice no one could make names the exact flag", () => {
  const step = (reason: string, choices?: string): Step => ({
    id: reason.startsWith("team") ? "linear.team" : "github.repos",
    state: "waiting",
    reason,
    ...(choices ? { evidence: { choices } } : {}),
  });
  test("two teams: the advice lists both", () => {
    expect(onboardReasonText(step("team_choice_required", "ADV,ENG"))).toBe(
      "This workspace has 2 Linear teams: ADV, ENG. Add --team with one of them to the same command, for example --team ADV.",
    );
  });
  test("one team: the advice names --team with its key", () => {
    expect(onboardReasonText(step("team_choice_required", "ADV"))).toBe(
      "This workspace has 1 Linear team: ADV. Add --team with one of them to the same command, for example --team ADV.",
    );
  });
  test("one repository: the advice names --repo with it", () => {
    expect(onboardReasonText(step("repository_choice_required", "acme/api"))).toBe(
      "One repository is available: acme/api. Add --repo <owner/name> to the same command, for example --repo acme/api. Repeat --repo to choose more than one.",
    );
  });
  test("without recorded choices the old advice stays", () => {
    expect(onboardReasonText(step("team_choice_required"))).toBe(
      "Choose an existing team with catalyst onboard --team <team ID or key>.",
    );
  });
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { createClackOnboardUi } from "../src/onboard-ui.js";
import { createSetupRenderer } from "../src/setup-render.js";
import { ONBOARD_STEPS, type OnboardJournal } from "../src/onboard.js";
import { GITHUB_CONFIRM_ACCESS } from "../src/onboard-github-copy.js";
const journal = (): OnboardJournal => ({
  schema: 1,
  runId: "test",
  installer: null,
  cli: "0.15.0",
  tenant: null,
  exit: 11,
  complete: false,
  changes: [],
  steps: ONBOARD_STEPS.map((id) => ({ id, state: "done" })),
});
function fixture(
  interactive = false,
  cancel = false,
  unicode = false,
  consentGiven = true,
  verbose = false,
  selectAnswer = "stop",
) {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => (text += chunk));
  const signals = new EventEmitter();
  if (unicode) Object.assign(output, { isTTY: true, columns: 100 });
  const renderer = createSetupRenderer(
    output,
    unicode ? { TERM: "xterm-256color", LANG: "C.UTF-8" } : { NO_COLOR: "1" },
  );
  const quiet = () => {};
  let selectCalls = 0;
  const prompts = {
    intro: quiet,
    outro: quiet,
    log: { message: quiet, info: quiet, warn: quiet, error: quiet },
    select: async () => { selectCalls++; return selectAnswer; },
    isCancel: () => cancel,
  };
  const ui = createClackOnboardUi(
    prompts,
    { input: new PassThrough(), output },
    {
      renderer,
      verbose,
      consentGiven,
      introduced: true,
      interactive,
      signals,
      logPath: () => "/tmp/setup-full.log",
      baseUrl: () => "https://staging.catalystcloud.dev",
    },
  );
  return { ui, signals, text: () => text, selectCalls: () => selectCalls };
}

test("the install-engine continuation shows local sync inventory even while legacy repeats are hidden", () => {
  const f = fixture(true);
  f.ui.stepStart("legacy");
  f.ui.showLocalSyncInventory!(["/tmp/replica.db (17 bytes)", "/tmp/cursor.json (5 bytes)"]);
  expect(f.text()).toContain("/tmp/replica.db (17 bytes)");
  expect(f.text()).toContain("/tmp/cursor.json (5 bytes)");
  f.ui.dispose();
});

test("unattended project review uses move-on without opening a choice", async () => {
  const projects = [{ id: "project-one", name: "Existing project", key: "ENG", status: "ready" }];
  const unattended = fixture(false);
  expect(await unattended.ui.reviewProjects?.(projects)).toBe("move-on");
  expect(unattended.selectCalls()).toBe(0);
  unattended.ui.dispose();

  const interactive = fixture(true, false, false, true, false, "repair:project-one");
  expect(await interactive.ui.reviewProjects?.(projects)).toEqual({ repair: "project-one" });
  expect(interactive.selectCalls()).toBe(1);
  interactive.ui.dispose();
});

test.each([false, true])("GitHub confirmation reaches the terminal before a direct handoff and remains while waiting (unicode=%s)", async (unicode) => {
  const f = fixture(false, false, unicode);
  try {
    f.ui.stepStart("github.install");
    f.ui.message("private adapter log: https://github.com/install?state=private-handoff");
    f.ui.message(GITHUB_CONFIRM_ACCESS);
    expect(f.text().replace(/\s+/g, " ")).toContain(GITHUB_CONFIRM_ACCESS);
    expect(f.text()).not.toContain("private-handoff");
    const beforeWait = f.text().length;
    await f.ui.wait("Waiting for GitHub approval", async () => {
      const waiting = f.text().slice(beforeWait).split("\u001b[J").at(-1) ?? "";
      expect(waiting.replace(/\s+/g, " ")).toContain(GITHUB_CONFIRM_ACCESS);
      expect(waiting).not.toContain("private-handoff");
    });
  } finally {
    f.ui.dispose();
  }
});
test("injected setup hides successful machine repeats and uses exact group/title", () => {
  const f = fixture();
  const j = journal();
  for (const id of [
    "machine",
    "cli",
    "skills",
    "legacy",
    "signin",
    "housekeeping",
    "daemon",
  ] as const) {
    f.ui.stepStart(id);
    f.ui.stepEnd(
      j.steps.find((s) => s.id === id)!,
      j,
    );
  }
  expect(f.text()).toBe("");
  f.ui.stepStart("linear.adopt");
  f.ui.stepEnd(
    j.steps.find((s) => s.id === "linear.adopt")!,
    j,
  );
  expect(f.text()).toContain("Linear");
  expect(f.text()).toContain("Part 1 done. This computer is set up.");
  expect(f.text()).toContain("Part 2 of 3: Linear and GitHub");
  expect(f.text()).toMatch(/\[done\] +4 Set up the team's workflow/);
  expect(f.text()).not.toContain("Connections");
  f.ui.dispose();
});
test("project registration folds into one repository outcome", () => {
  const f = fixture();
  const j = journal();
  for (const id of ["github.repos", "projects"] as const) {
    f.ui.stepStart(id);
    f.ui.stepEnd(
      j.steps.find((s) => s.id === id)!,
      j,
    );
  }
  const done = f
    .text()
    .split("\n")
    .filter((l) => l.startsWith("    [done]"));
  expect(done).toHaveLength(1);
  expect(done[0]).toContain("1 Choose repositories");
  f.ui.dispose();
});
test("final screen only lists root actions and one last Next line", () => {
  const f = fixture();
  const j = journal();
  Object.assign(
    j.steps.find((s) => s.id === "github.install")!,
    { state: "waiting" },
  );
  Object.assign(
    j.steps.find((s) => s.id === "github.repos")!,
    { state: "waiting", reason: "prerequisite_not_ready" },
  );
  f.ui.finish(j);
  expect(f.text()).toContain("Not ready for work yet");
  expect(f.text()).toContain("1 thing needs you:");
  expect(f.text()).not.toContain("Choose repositories:");
  expect(f.text().match(/Next:/g)).toHaveLength(1);
  expect(f.text().trimEnd().split("\n").at(-1)).toBe(
    "  Next: run catalyst setup after you finish 1.",
  );
  f.ui.dispose();
});

test("an optional browser interrupt skips its step, keeps the setup signal live, and allows a second stop", async () => {
  const f = fixture(true);
  f.ui.stepStart("github.install");
  const wait = f.ui.wait(
    "Waiting for GitHub",
    () =>
      new Promise<void>((resolve) =>
        f.ui.stepSignal!.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      ),
  );
  expect(f.text()).toContain("waiting for you, up to 10 minutes");
  expect(f.text()).toContain("/connect/github/start");
  f.signals.emit("SIGINT");
  expect(f.ui.signal.aborted).toBe(false);
  expect(f.ui.stepSignal!.aborted).toBe(true);
  await vi.waitFor(() =>
    expect(f.text()).toContain("Press Ctrl-C again to stop setup."),
  );
  f.signals.emit("SIGINT");
  await wait;
  expect(f.ui.signal.aborted).toBe(true);
  f.ui.dispose();
  expect(f.signals.listenerCount("SIGINT")).toBe(0);
});

test("noninteractive browser wait says Ctrl-C stops setup", async () => {
  const f = fixture();
  f.ui.stepStart("github.install");
  await f.ui.wait("Waiting", async () => {});
  expect(f.text()).toContain("Ctrl-C stops setup.");
  expect(f.text()).not.toContain("Ctrl-C skips");
  f.ui.dispose();
});
test("plain interactive waits remind once a minute with singular minutes", async () => {
  vi.useFakeTimers();
  const f = fixture(true);
  try {
    f.ui.stepStart("github.install");
    let finish!: () => void;
    const work = f.ui.wait(
      "Waiting",
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.text()).toContain("Still waiting, 9 minutes left.");
    await vi.advanceTimersByTimeAsync(480000);
    expect(f.text()).toContain("Still waiting, 1 minute left.");
    expect(f.text()).not.toContain("1 minutes");
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.text()).not.toContain("0 minutes left");
    finish();
    await work;
  } finally {
    f.ui.dispose();
    vi.useRealTimers();
  }
});
test("cancel after root actions keeps them once and puts full log before the question", async () => {
  const f = fixture(true, true);
  const j = journal();
  Object.assign(
    j.steps.find((s) => s.id === "github.install")!,
    { state: "waiting" },
  );
  expect(await f.ui.checkAgain!(j)).toBe(false);
  f.ui.finish(j);
  expect(f.text().match(/1 thing needs you/g)).toHaveLength(1);
  expect(f.text().match(/Full log:/g)).toHaveLength(1);
  expect(f.text()).toContain("Setup paused");
  expect(f.text().indexOf("Full log:")).toBeLessThan(
    f.text().indexOf("Setup paused"),
  );
  f.ui.dispose();
});

test.each([false, true])(
  "renewed sign-in inside combined setup shows its code before waiting and resolves its step (unicode=%s)",
  async (unicode) => {
    const f = fixture(false, false, unicode);
    const j = journal();
    f.ui.stepStart("signin");
    f.ui.message("Workspace: Example workspace · owner");
    expect(f.text()).toBe("");
    f.ui.message("Open https://signin.test/device and enter ABCD-1234.");
    expect(f.text()).toContain("ABCD-1234");
    await f.ui.wait("Waiting for Catalyst approval", async () => {
      expect(f.text()).toContain("waiting for you");
      expect(f.text()).toContain("Ctrl-C stops setup.");
      if (unicode)
        expect(f.text().slice(f.text().lastIndexOf("\u001b[J") + 3)).toContain(
          "ABCD-1234",
        );
    });
    f.ui.stepEnd(
      j.steps.find((s) => s.id === "signin")!,
      j,
    );
    expect(f.text()).toMatch(
      unicode ? /✓.*2 Sign in to Catalyst/ : /\[done\]\s+2 Sign in to Catalyst/,
    );
    f.ui.dispose();
  },
);
test("a folded completed parent has its live block erased before the paused summary", () => {
  const f = fixture(true, false, true);
  const j = journal();
  f.ui.stepStart("github.repos");
  f.ui.message("Choose repositories now.");
  f.ui.stepEnd(
    j.steps.find((s) => s.id === "github.repos")!,
    j,
  );
  const before = f.text().length;
  f.signals.emit("SIGINT");
  f.ui.finish(j);
  const closing = f.text().slice(before);
  expect(closing).toMatch(/\u001b\[\d+A\r\u001b\[J/);
  expect(closing.indexOf("\u001b[")).toBeLessThan(
    closing.indexOf("Setup paused"),
  );
  f.ui.dispose();
});

test("staged signin before an engine step remains inside the shared plain frame", async () => {
  const f = fixture();
  f.ui.message("To connect this machine, visit: https://signin.test/device");
  f.ui.message("and enter the code: ABCD-1234");
  await f.ui.wait("Waiting for Catalyst approval", async () => {
    expect(f.text()).toContain("2 Sign in to Catalyst");
    expect(f.text()).toContain("ABCD-1234");
    expect(f.text()).toContain("waiting for you");
  });
  expect(f.text()).not.toContain("\u001b");
  f.ui.dispose();
});

test.each([false, true])(
  "staged approval closes its step before the plan and hides the later checked repeat (unicode=%s)",
  async (unicode) => {
    const f = fixture(false, false, unicode);
    f.ui.message("To connect this machine, visit: https://signin.test/device");
    f.ui.message("and enter the code: ABCD-1234");
    await f.ui.wait("Waiting for Catalyst approval", async () => {});
    expect(f.ui.stagedSigninEnd?.("done")).toBe(true);
    const closed = f.text();
    expect(closed).toMatch(
      unicode
        ? /✓.*2 Sign in to Catalyst.*approved/
        : /\[done\]\s+2 Sign in to Catalyst.*approved/,
    );
    f.ui.stepStart("signin");
    f.ui.stepEnd({ id: "signin", state: "done" }, journal());
    expect(f.text()).toBe(closed);
    f.ui.dispose();
  },
);

test.each([false, true])(
  "staged sign-in stops with a visible cause and final next action (paused=%s)",
  (paused) => {
    const f = fixture(true, false, true);
    f.ui.message("To connect this machine, visit: https://signin.test/device");
    f.ui.message("and enter the code: ABCD-1234");
    const before = f.text().length;
    if (paused) f.signals.emit("SIGINT");
    expect(f.ui.stagedSigninEnd?.("waiting", "Approval timed out.")).toBe(true);
    f.ui.dispose();
    const closing = f.text().slice(before);
    expect(closing).toContain("Approval timed out.");
    expect(closing).toContain(
      paused ? "Setup paused" : "Setup is not ready yet",
    );
    expect(closing).toContain("Your saved connection was not changed.");
    expect(closing).not.toContain("Your progress is saved");
    expect(closing.trim().split("\n").at(-1)).toContain(
      "Next: run catalyst setup to sign in again.",
    );
    expect(closing.indexOf("\u001b[J")).toBeLessThan(
      closing.indexOf("Approval timed out."),
    );
  },
);

test("ordinary staged signin has one approved outcome when the engine checks it again", () => {
  const f = fixture(false, false, false, false);
  f.ui.message("Open https://signin.test/device and enter ABCD-1234.");
  f.ui.stagedSigninEnd!("done");
  f.ui.stepStart("signin");
  f.ui.stepEnd({ id: "signin", state: "done" }, journal());
  expect(f.text().match(/\[done\]\s+2 Sign in to Catalyst/g)).toHaveLength(1);
  f.ui.dispose();
});
test("staged signin failure before a code still ends with cause and next", () => {
  const f = fixture();
  expect(f.ui.stagedSigninEnd!("failed", "authorization request failed.")).toBe(
    true,
  );
  f.ui.dispose();
  expect(f.text()).toContain("Authorization request failed.");
  expect(f.text()).toContain("Setup is not ready yet");
  expect(f.text().trim().split("\n").at(-1)).toContain("Next:");
  expect(f.text()).not.toContain("Sign in to Catalyst");
});
test("post-approval identity refusal describes verification rather than denied approval", () => {
  const f = fixture();
  f.ui.message("Open https://signin.test/device and enter ABCD-1234.");
  f.ui.stagedSigninEnd!("failed", "this account cannot continue this setup.");
  expect(f.text()).toContain("could not verify this account");
  expect(f.text()).not.toContain("not approved");
  expect(f.text()).toContain("This account cannot continue this setup.");
  f.ui.dispose();
});
test("final readiness failure stays visible without a numbered ready row", () => {
  const f = fixture();
  const j = journal();
  Object.assign(
    j.steps.find((s) => s.id === "ready")!,
    { state: "failed", reason: "onboarding_capability_unavailable" },
  );
  j.exit = 10;
  f.ui.finish(j);
  expect(f.text()).toContain(
    "The server's setup capabilities could not be checked.",
  );
  expect(f.text().replace(/\s+/g, " ")).toContain(
    "Run catalyst setup to try again.",
  );
  expect(f.text()).not.toMatch(/0 Check onboarding readiness/);
  f.ui.dispose();
});

test("post-approval verification wait is neutral and the real pause cause states the unchanged connection once", () => {
  const f = fixture();
  f.ui.message("Open https://signin.test/device and enter ABCD-1234.");
  f.ui.stagedSigninEnd!(
    "waiting",
    "Sign-in paused. Your saved connection was not changed.",
  );
  expect(f.text()).toContain("not finished");
  expect(f.text()).not.toContain("not approved");
  expect(
    f.text().match(/Your saved connection was not changed\./g),
  ).toHaveLength(1);
  f.ui.dispose();
});
test.each(["waiting", "failed"] as const)(
  "generic readiness %s avoids the removed unverified sentence and keeps a truthful retry",
  (state) => {
    const f = fixture();
    const j = journal();
    Object.assign(
      j.steps.find((s) => s.id === "ready")!,
      { state, reason: "onboarding_checks_pending" },
    );
    j.exit = state === "failed" ? 10 : 11;
    f.ui.finish(j);
    expect(f.text()).not.toContain("Some required checks are still unverified");
    if (state === "failed")
      expect(f.text().replace(/\s+/g, " ")).toContain(
        "A required check failed. Run catalyst setup again to retry.",
      );
    expect(f.text().trim().split("\n").at(-1)).toContain("Next:");
    f.ui.dispose();
  },
);


test.each([false, true])("shared renderer keeps passed grants and permission-gap details verbose only (verbose=%s)", (verbose) => {
 const f=fixture(false,false,false,true,verbose);const j=journal();
 const step=j.steps.find(s=>s.id==="github.install")!;
 Object.assign(step,{state:"done",evidence:{granted:"contents (read)"}});
 f.ui.stepEnd(step,j);
 expect(f.text().includes("granted contents (read)")).toBe(verbose);
 Object.assign(step,{state:"waiting",reason:"github_app_permissions_outdated",evidence:{installation:"17",org:"acme",missing:"contents (write)",url:"https://github.com/organizations/acme/settings/installations/17/permissions/update"}});
 f.ui.stepEnd(step,j);
 expect(f.text()).toContain("needs updated permissions");
 expect(f.text().includes("contents (write)")).toBe(verbose);
 expect(f.text()).not.toContain("not installed yet");
 f.ui.dispose();
});

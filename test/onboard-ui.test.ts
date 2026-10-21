import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { pollConsent } from "../src/onboard-consent.js";
import { parseArgs } from "../src/args.js";
import { createClackOnboardUi, shouldUseOnboardUi } from "../src/onboard-ui.js";
import type { OnboardIdentity, OnboardJournal } from "../src/onboard.js";

function journal(extra: Partial<OnboardJournal> = {}): OnboardJournal {
  return {
    schema: 1,
    runId: "ui-fixture",
    installer: null,
    cli: "0.14.1",
    tenant: null,
    exit: 11,
    steps: [],
    changes: [],
    complete: false,
    ...extra,
  };
}
function fixture(answer: string | symbol = "cloud", baseUrl?: string) {
  const events: Array<{ kind: string; text?: string }> = [];
  const selections: Array<{
    options: Array<{ value: string }>;
    initialValue?: string;
  }> = [];
  const cancel = Symbol("cancel");
  const signals = new EventEmitter();
  const prompts = {
    intro: (text: string) => events.push({ kind: "intro", text }),
    outro: (text: string) => events.push({ kind: "outro", text }),
    log: {
      message: (text: string) => {
        events.push({ kind: "message", text });
      },
      info: (text: string) => {
        events.push({ kind: "info", text });
      },
      warn: (text: string) => {
        events.push({ kind: "warn", text });
      },
      error: (text: string) => {
        events.push({ kind: "error", text });
      },
    },
    select: async (options: {
      options: Array<{ value: string }>;
      initialValue?: string;
    }) => {
      selections.push(options);
      events.push({ kind: "select" });
      return answer;
    },
    isCancel: (value: unknown) => typeof value === "symbol",
    spinner: () => {
      throw new Error("Clack spinner must never own onboarding input");
    },
  };
  const progress = {
    start: (text: string) => {
      events.push({ kind: "start", text });
    },
    stop: () => {
      events.push({ kind: "stop" });
    },
    dispose: () => {
      events.push({ kind: "progress-dispose" });
    },
  };
  const ui = createClackOnboardUi(
    prompts,
    { input: new PassThrough(), output: new PassThrough() },
    { signals, progress, baseUrl: () => baseUrl },
  );
  return {
    ui,
    events,
    selections,
    cancel,
    signals,
    progress,
    cancelSpinner: () => signals.emit("SIGINT"),
  };
}

test("Q4 presents one shared keep-or-stop question with no import or approval default", async () => {
  const f = fixture("keep");
  f.ui.stepStart("settings");
  const rows = ["one", "two"].map((name) => ({
    repository: `example/${name}`,
    state: "draft" as const,
    variableNames: ["PUBLIC_URL"],
    secretNames: [],
    sources: [".env.example"],
  }));
  expect(await f.ui.reviewSettings!(rows)).toBe("keep");
  expect(f.selections).toHaveLength(1);
  expect(f.selections[0]!.initialValue).toBe("keep");
  expect(f.selections[0]!.options.map((option) => option.value)).toEqual([
    "keep",
    "stop",
  ]);
  expect(
    f.events[f.events.findIndex((event) => event.kind === "select") - 1]!.kind,
  ).toBe("stop");
  f.ui.dispose();
});
test("Q4 cancellation aborts before any drafts are accepted", async () => {
  const f = fixture(Symbol("cancel"));
  expect(
    await f.ui.reviewSettings!([
      {
        repository: "example/service",
        state: "draft",
        variableNames: [],
        secretNames: [],
        sources: [],
      },
    ]),
  ).toBe("cancel");
  expect(f.ui.signal.aborted).toBe(true);
  f.ui.dispose();
});
test("Q4 has no fictional chooser when no repositories are available", async () => {
  const f = fixture("keep");
  expect(await f.ui.reviewSettings!([])).toBe("cancel");
  expect(f.selections).toEqual([]);
  f.ui.dispose();
});

test.each([
  [["onboard"], true, true],
  [["onboard"], false, false],
  [["onboard", "--yes"], true, false],
  [["onboard", "--json"], true, false],
  [["onboard", "--dry-run"], true, false],
] as const)(
  "interactive onboarding selection honors flags %#",
  (argv, tty, expected) => {
    expect(shouldUseOnboardUi(parseArgs([...argv]), tty)).toBe(expected);
  },
);

test.each([
  ["cloud", false, true, false],
  ["local", false, true, true],
  ["stop", false, false, false],
  ["local", true, true, true],
] as const)(
  "one plan choice %s returns explicit consent and mode",
  async (answer, persisted, proceed, localSync) => {
    const f = fixture(answer);
    expect(await f.ui.confirmPlan(persisted)).toEqual({ proceed, localSync });
    expect(f.selections).toHaveLength(1);
    expect(f.selections[0]!.options.map((option) => option.value)).toEqual(
      expect.arrayContaining(["cloud", "local", "stop"]),
    );
    expect(f.selections[0]!.initialValue).toBe(persisted ? "local" : "cloud");
    f.ui.dispose();
  },
);

test("plan cancellation stops setup and aborts its UI signal", async () => {
  const f = fixture(Symbol("cancel"));
  expect(await f.ui.confirmPlan(false)).toMatchObject({ proceed: false });
  expect(f.ui.signal.aborted).toBe(true);
  f.ui.dispose();
});

test("progress stops before another message or plan prompt writes to the terminal", async () => {
  const f = fixture();
  f.ui.stepStart("signin");
  f.ui.message("Approve your sign-in in the browser.");
  const messageIndex = f.events.findIndex(
    (event) => event.text === "Approve your sign-in in the browser.",
  );
  expect(
    f.events
      .slice(0, messageIndex)
      .some((event) => ["stop", "cancel"].includes(event.kind)),
  ).toBe(true);
  f.ui.stepStart("github.personal");
  await f.ui.confirmPlan(false);
  const promptIndex = f.events.findIndex((event) => event.kind === "select");
  expect(f.events[promptIndex - 1]!.kind).toMatch(/stop|cancel/);
  f.ui.dispose();
});

test("waiting progress uses a waiting warning rather than a success message", () => {
  const f = fixture();
  f.ui.stepStart("github.personal");
  f.ui.stepEnd({
    id: "github.personal",
    state: "waiting",
    reason: "consent_timeout",
  });
  expect(f.events.some((event) => event.kind === "warn")).toBe(true);
  expect(
    f.events.some((event) =>
      /complete|connected|finished successfully/i.test(event.text ?? ""),
    ),
  ).toBe(false);
  f.ui.dispose();
});

test("incomplete and complete receipts produce distinct finish outcomes", () => {
  const incomplete = fixture();
  incomplete.ui.finish(journal());
  expect(
    incomplete.events.map((event) => event.text ?? "").join("\n"),
  ).not.toContain("Onboarding complete");
  expect(incomplete.events.map((event) => event.text ?? "").join("\n")).toMatch(
    /resume|still|needs|saved/i,
  );
  incomplete.ui.dispose();
  const complete = fixture();
  complete.ui.finish(journal({ exit: 0, complete: true }));
  expect(complete.events.map((event) => event.text ?? "").join("\n")).toMatch(
    /onboarding complete/i,
  );
  complete.ui.dispose();
});

test("successful single-step completion never claims complete onboarding", () => {
  const f = fixture();
  f.ui.finish(journal({ exit: 0, complete: false, scope: "step" }), "signin");
  expect(f.events.map((event) => event.text ?? "").join("\n")).not.toMatch(
    /onboarding complete/i,
  );
  f.ui.dispose();
});

test("wait returns its result after stopping progress", async () => {
  const f = fixture();
  expect(await f.ui.wait("Checking live membership", async () => 42)).toBe(42);
  expect(f.events.some((event) => event.kind === "start")).toBe(true);
  expect(f.events.some((event) => event.kind === "stop")).toBe(true);
  expect(
    f.events
      .filter((event) => event.kind === "stop")
      .every((event) => event.text === undefined),
  ).toBe(true);
  f.ui.dispose();
});

test("wait cleans up progress when its operation rejects", async () => {
  const f = fixture();
  await expect(
    f.ui.wait("Checking live membership", async () => {
      throw new Error("fixture failure");
    }),
  ).rejects.toThrow("fixture failure");
  expect(
    f.events.some((event) =>
      ["stop", "cancel", "spinner-error"].includes(event.kind),
    ),
  ).toBe(true);
  f.ui.dispose();
});

test("dispose stops active progress and aborts further UI work", () => {
  const f = fixture();
  f.ui.stepStart("signin");
  f.ui.dispose();
  expect(
    f.events.some((event) => ["stop", "cancel"].includes(event.kind)),
  ).toBe(true);
  expect(f.ui.signal.aborted).toBe(true);
});

test("spinner cancellation aborts the shared onboarding signal", () => {
  const f = fixture();
  f.ui.stepStart("signin");
  f.cancelSpinner();
  expect(f.ui.signal.aborted).toBe(true);
  f.ui.dispose();
});

test("a saved plan is shown as needing recheck rather than verified success and intro is not repeated", () => {
  const f = fixture();
  f.ui.plan(journal({ steps: [{ id: "signin", state: "done" }] }));
  f.ui.plan(journal());
  expect(f.events.filter((event) => event.kind === "intro")).toHaveLength(1);
  const text = f.events.map((event) => event.text ?? "").join("\n");
  expect(text).toContain("(recheck)");
  expect(text).not.toContain("✓");
  f.ui.dispose();
});

test("progress groups follow the whole onboarding journey without repeating a shared group", () => {
  const f = fixture();
  for (const id of [
    "machine",
    "cli",
    "signin",
    "linear.personal",
    "github.personal",
    "projects",
    "accounts",
    "capacity",
    "daemon",
    "first-ticket",
    "ready",
  ] as const)
    f.ui.stepStart(id);
  const messages = f.events
    .filter((event) => event.kind === "message")
    .map((event) => event.text);
  expect(messages).toEqual([
    "This computer",
    "Catalyst sign-in",
    "Connections",
    "Project setup",
    "Runner and services",
    "Work and readiness",
  ]);
  f.ui.dispose();
});

test.each([
  ["done", undefined, "info"],
  ["failed", "token_revoked", "error"],
  ["pending", "prerequisite_not_ready", "warn"],
  ["skipped", "member_scope", "message"],
] as const)(
  "progress %s is displayed honestly with its appropriate status",
  (state, reason, kind) => {
    const f = fixture();
    f.ui.stepStart("accounts");
    f.ui.stepEnd({ id: "accounts", state, ...(reason ? { reason } : {}) });
    const result = f.events.at(-1)!;
    expect(result.kind).toBe(kind);
    expect(result.text?.includes("✓")).toBe(state === "done");
    if (reason === "token_revoked")
      expect(result.text).toContain("token revoked");
    if (reason === "member_scope")
      expect(result.text).toContain("administrator");
    f.ui.dispose();
  },
);

test("an unrecognized plan answer cannot approve setup", async () => {
  const f = fixture("unexpected-value");
  expect(await f.ui.confirmPlan(false)).toEqual({
    proceed: false,
    localSync: false,
  });
  f.ui.dispose();
});

test("cancelled UI cannot start more terminal progress", () => {
  const f = fixture();
  f.ui.stepStart("signin");
  f.cancelSpinner();
  const starts = f.events.filter((event) => event.kind === "start").length;
  f.ui.stepStart("github.personal");
  expect(f.events.filter((event) => event.kind === "start")).toHaveLength(
    starts,
  );
  f.ui.dispose();
});

test("a complete flag with a nonzero exit is never rendered as complete onboarding", () => {
  const f = fixture();
  f.ui.finish(journal({ complete: true, exit: 11 }));
  expect(f.events.map((event) => event.text ?? "").join("\n")).not.toMatch(
    /onboarding complete/i,
  );
  f.ui.dispose();
});

test("spinner cancellation ends a hung consent callback and cleans up progress", async () => {
  const f = fixture();
  const result = f.ui.wait("Waiting for provider approval", () =>
    pollConsent({
      signal: f.ui.signal,
      timeoutMs: 1000,
      readStatus: async () => new Promise<never>(() => {}),
    }),
  );
  f.cancelSpinner();
  expect(await result).toMatchObject({
    state: "waiting",
    reason: "interrupted",
  });
  expect(f.events.some((event) => event.kind === "stop")).toBe(true);
  f.ui.dispose();
});

test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
  "UI signal %s cancels without changing process listeners",
  (signal) => {
    const before = process.listenerCount(signal);
    const f = fixture();
    f.ui.stepStart("signin");
    expect(f.signals.listenerCount(signal)).toBe(1);
    f.signals.emit(signal);
    expect(f.ui.signal.aborted).toBe(true);
    f.ui.dispose();
    expect(f.signals.listenerCount(signal)).toBe(0);
    expect(process.listenerCount(signal)).toBe(before);
  },
);

test.each(["stop", "dispose"] as const)(
  "UI disposal releases signal listeners even when progress %s fails",
  (operation) => {
    const f = fixture();
    f.ui.stepStart("signin");
    f.progress[operation] = () => {
      throw new Error("fixture progress cleanup failed");
    };
    expect(() => f.ui.dispose()).toThrow("fixture progress cleanup failed");
    expect(f.ui.signal.aborted).toBe(true);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      expect(f.signals.listenerCount(signal)).toBe(0);
  },
);

test.each(["live@example.com", null])(
  "Q1 displays the live person and workspace before selecting a plan, email=%s",
  async (email) => {
    const f = fixture("stop");
    const identity: OnboardIdentity = {
      account: "tenant-live",
      membershipId: "person-live",
      baseUrl: "https://staging.catalystcloud.dev",
      role: "admin",
      display: {
        personLabel: "Live Person",
        email,
        workspaceName: "Live Workspace",
        workspaceSlug: "live-workspace",
      },
    };
    const receipt = journal();
    const before = JSON.stringify(receipt);
    f.ui.plan(receipt, identity);
    expect(await f.ui.confirmPlan(false)).toMatchObject({ proceed: false });
    const person = f.events.findIndex(
      (event) =>
        event.text === `Signed in to Catalyst as Live Person${email ? ` (${email})` : ""}`,
    );
    const workspace = f.events.findIndex(
      (event) =>
        event.text === "Catalyst workspace: Live Workspace · admin",
    );
    const prompt = f.events.findIndex((event) => event.kind === "select");
    expect(person).toBeGreaterThanOrEqual(0);
    expect(workspace).toBeGreaterThan(person);
    expect(prompt).toBeGreaterThan(workspace);
    expect(f.selections).toHaveLength(1);
    expect(f.events.map((event) => event.text ?? "").join("\n")).not.toContain(
      "(null)",
    );
    expect(JSON.stringify(receipt)).toBe(before);
    f.ui.dispose();
  },
);

test("live display fields cannot insert terminal controls, new lines or unbounded labels", () => {
  const f = fixture();
  const identity: OnboardIdentity = {
    account: "tenant-a",
    membershipId: "person-a",
    baseUrl: "https://staging.catalystcloud.dev",
    role: "member",
    display: {
      personLabel: "Live\nPerson\u001b[31m\u0000",
      email: "mail\r@example.com",
      workspaceName: "Workspace\u2028name\u009b",
      workspaceSlug: "x".repeat(250),
    },
  };
  f.ui.plan(journal(), identity);
  const person = f.events.find((event) =>
    event.text?.startsWith("Signed in to Catalyst as "),
  )?.text;
  const workspace = f.events.find((event) =>
    event.text?.startsWith("Catalyst workspace: "),
  )?.text;
  expect(person).toBe("Signed in to Catalyst as Live Person [31m (mail @example.com)");
  expect(workspace).toBe(
    "Catalyst workspace: Workspace name · member",
  );
  expect(person).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  expect(workspace).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  f.ui.dispose();
});

test("a first-run plan explains account or invitation prerequisites without inventing a login", async () => {
  const f = fixture("stop");
  f.ui.plan(journal(), null);
  await f.ui.confirmPlan(false);
  const prerequisite = f.events.findIndex(
    (event) =>
      event.text ===
      "Use an existing Catalyst account or accept your invitation before approving sign-in.",
  );
  expect(prerequisite).toBeGreaterThanOrEqual(0);
  expect(
    f.events.findIndex((event) => event.kind === "select"),
  ).toBeGreaterThan(prerequisite);
  expect(
    f.events.some((event) => event.text?.startsWith("Signed in to Catalyst as ")),
  ).toBe(false);
  expect(f.events.some((event) => event.text?.startsWith("Catalyst workspace: "))).toBe(
    false,
  );
  f.ui.dispose();
});

test("a login expiring after Q1 stays neutral and displays the actual renewal command", () => {
  const f = fixture();
  f.ui.stepStart("signin");
  f.ui.stepEnd({
    id: "signin",
    state: "waiting",
    reason: "onboard_login_refresh_required",
  });
  expect(
    f.events.some(
      (event) =>
        event.kind === "warn" && event.text?.includes("catalyst login"),
    ),
  ).toBe(true);
  expect(
    f.events.some((event) => event.kind === "error" || event.kind === "info"),
  ).toBe(false);
  f.ui.dispose();
});

// CTC-4477: every step that waits names the next action a person can take.
const adoptedTeam = (extra: OnboardJournal["steps"] = []) =>
  journal({
    steps: [
      { id: "linear.workspace", state: "done", evidence: { workspaceSlug: "fixture" } },
      {
        id: "linear.team",
        state: "done",
        evidence: { team: "team-1", teamKey: "ENG" },
      },
      ...extra,
    ],
  });
const warned = (
  reason: string,
  options: {
    id?: OnboardJournal["steps"][number]["id"];
    baseUrl?: string;
    evidence?: OnboardJournal["steps"][number]["evidence"];
    journal?: OnboardJournal;
  } = {},
) => {
  const f = fixture("cloud", options.baseUrl);
  const id = options.id ?? "accounts";
  f.ui.stepStart(id);
  f.ui.stepEnd(
    {
      id,
      state: "waiting",
      reason,
      ...(options.evidence ? { evidence: options.evidence } : {}),
    },
    options.journal,
  );
  f.ui.dispose();
  return f.events.filter((event) => event.kind === "warn").at(-1)!.text!;
};

test.each([
  "workflow_mapping_unverified",
  "account_enrollment_required",
  "settings_checkout_unverified",
  "settings_approval_unverified",
  "capacity_admission_unverified",
  "capacity_currently_full",
  "capacity_unavailable",
  "housekeeping_service_unverified",
  "workflow_identity_unverified",
  "workflow_login_refresh_required",
  "workflow_mapping_changed",
  "workflow_unavailable",
  "runner_not_selected",
  "runner_docker_missing",
  "runner_image_unpinned",
  "runner_images_unavailable",
  "runner_org_key_missing",
  "runner_host_not_ready",
  "runner_admission_operator",
  "runner_enrollment_stale",
  "workflow_admin_required",
  "workflow_plan_changed",
  "verification_pending",
])("%s renders a written next action, never the raw reason", (reason) => {
  const text = warned(reason);
  expect(text).not.toContain(reason.replaceAll("_", " "));
  expect(text).not.toContain(reason);
});

test("an unadopted workflow names the adopt command for the selected team key", () => {
  const text = warned("workflow_mapping_unverified", {
    id: "linear.adopt",
    journal: adoptedTeam(),
  });
  expect(text).toContain("catalyst team adopt ENG");
  expect(text).toContain("--yes --plan-hash");
  expect(text).toContain("catalyst onboard");
  expect(warned("workflow_mapping_unverified")).toContain(
    "catalyst team adopt <TEAM KEY>",
  );
});

test("a team key that could carry terminal text is replaced by the placeholder", () => {
  const text = warned("workflow_mapping_unverified", {
    id: "linear.adopt",
    journal: journal({
      steps: [
        {
          id: "linear.team",
          state: "done",
          evidence: { team: "team-1", teamKey: "ENG\u001b[2J" },
        },
      ],
    }),
  });
  expect(text).toContain("catalyst team adopt <TEAM KEY>");
  expect(text).not.toContain("\u001b");
});

test("missing AI accounts name the saved workspace's AI accounts page and an API key", () => {
  const text = warned("account_enrollment_required", {
    baseUrl: "https://cloud.example.dev/",
  });
  expect(text).toContain("https://cloud.example.dev/settings/coding-accounts");
  expect(text).toContain("Settings → AI accounts");
  expect(text).toContain("an API key, billed per token");
  expect(text).not.toMatch(/setup-token|subscription/);
  expect(warned("account_enrollment_required")).toContain(
    "Settings → AI accounts",
  );
  expect(warned("account_enrollment_required")).not.toContain("undefined");
});

test("closed runner admission names the enroll command for this computer and how to ask for cloud runners", () => {
  const text = warned("capacity_admission_unverified", { id: "capacity", journal: adoptedTeam() });
  expect(text).toContain("No runner is allowed to take work");
  expect(text).toContain("catalyst onboard --runner --team ENG");
  expect(text).toContain("ask Catalyst support to turn on cloud runners");
  // CTC-6180 review: with no team key the printed command is still runnable as is.
  const unknown = warned("capacity_admission_unverified", { id: "capacity" });
  expect(unknown.split("\n").at(-1)).toBe("catalyst onboard --runner");
  expect(unknown).not.toContain("<TEAM KEY>");
});

test("the daily update explains the service manager it needs and that it is optional", () => {
  const text = warned("housekeeping_service_unverified", {
    id: "housekeeping",
  });
  expect(text).toMatch(/user service manager/);
  expect(text).toMatch(/launchd/);
  expect(text).toMatch(/systemd/);
  expect(text).toMatch(/optional/);
});

test.each(["settings_checkout_unverified", "settings_approval_unverified"])(
  "%s says settings are optional for a first ticket and how to finish them",
  (reason) => {
    const text = warned(reason, { id: "settings" });
    expect(text).toContain("optional for a first ticket");
    expect(text).toContain("catalyst onboard from the repository's checkout");
  },
);

test("an unavailable server step mentions a web link only when one was printed", () => {
  const without = warned("cloud_capability_unavailable", { id: "linear.adopt" });
  expect(without).not.toMatch(/shown above|link/i);
  expect(without).toContain("catalyst onboard");
  const withLink = warned("cloud_capability_unavailable", {
    id: "linear.workspace",
    evidence: { path: "https://cloud.example.dev/a/account/connections" },
  });
  expect(withLink).toContain("https://cloud.example.dev/a/account/connections");
  expect(withLink).not.toContain("shown above");
});

const observedRun = (extra: OnboardJournal["steps"] = []) =>
  journal({
    exit: 11,
    steps: [
      { id: "signin", state: "done" },
      {
        id: "linear.team",
        state: "done",
        evidence: { team: "team-1", teamKey: "ENG" },
      },
      {
        id: "linear.adopt",
        state: "waiting",
        reason: "cloud_capability_unavailable",
      },
      { id: "projects", state: "done" },
      {
        id: "accounts",
        state: "waiting",
        reason: "account_enrollment_required",
      },
      {
        id: "settings",
        state: "waiting",
        reason: "settings_checkout_unverified",
      },
      { id: "values", state: "waiting", reason: "required_values_unverified" },
      {
        id: "capacity",
        state: "waiting",
        reason: "capacity_admission_unverified",
      },
      { id: "daemon", state: "skipped", reason: "local_sync_not_selected" },
      {
        id: "housekeeping",
        state: "waiting",
        reason: "housekeeping_service_unverified",
      },
      ...extra,
    ],
  });
const outro = (value: OnboardJournal, baseUrl?: string) => {
  const f = fixture("cloud", baseUrl);
  f.ui.finish(value);
  f.ui.dispose();
  return f.events.find((event) => event.kind === "outro")!.text!;
};

test("an incomplete finish lists each unfinished step with its next action", () => {
  const text = outro(observedRun(), "https://cloud.example.dev");
  expect(text).not.toMatch(/onboarding complete/i);
  expect(text).toContain(
    "Apply the Catalyst workflow: This setup step is not available on this server yet.",
  );
  expect(text).toContain(
    "Check AI accounts: No AI account is added yet.",
  );
  expect(text).toContain("https://cloud.example.dev/settings/coding-accounts");
  expect(text).toContain("Review repository settings: ");
  expect(text).toContain(
    "Check the repository's values: Setup couldn't get a current readiness check for this team from Catalyst",
  );
  expect(text).toContain("Check runner capacity: No runner is allowed");
  expect(text).toContain("Schedule the daily update: ");
  expect(text).not.toContain("Register your projects:");
  expect(text).not.toContain("Check optional local sync:");
  expect(text).not.toContain("Sign in to Catalyst:");
  expect(text).toMatch(/resume: catalyst onboard/);
  expect(text).not.toContain("Move a ticket");
});

test("a finish with the work prerequisites done says a first ticket can start now", () => {
  const done = (id: OnboardJournal["steps"][number]["id"]) =>
    ({ id, state: "done" }) as const;
  const value = observedRun();
  value.steps = value.steps.map((step) =>
    ["linear.adopt", "accounts", "capacity"].includes(step.id)
      ? done(step.id)
      : step,
  );
  const text = outro(value);
  expect(text).toContain(
    "Move a ticket in ENG to the stage that starts Catalyst's work; `catalyst explain <ticket>` says why it is or is not starting.",
  );
  expect(text).not.toMatch(/onboarding complete/i);
});

test("exit 0 with deferred steps waiting renders ready for work and the optional next steps", () => {
  const value = journal({
    exit: 0,
    complete: false,
    steps: [
      {
        id: "linear.team",
        state: "done",
        evidence: { team: "team-1", teamKey: "ENG" },
      },
      ...(["linear.adopt", "projects", "accounts", "capacity"] as const).map(
        (id) => ({ id, state: "done" as const }),
      ),
      {
        id: "settings",
        state: "waiting",
        reason: "settings_checkout_unverified",
      },
      {
        id: "housekeeping",
        state: "waiting",
        reason: "housekeeping_service_unverified",
      },
      { id: "first-ticket", state: "done" },
    ],
  });
  const text = outro(value);
  expect(text).toMatch(/^Ready for work\.\nNext, when you want:\n/);
  expect(text).toContain("Review repository settings: ");
  expect(text).toContain("Schedule the daily update: ");
  expect(text).toContain("Move a ticket in ENG to the stage that starts Catalyst's work;");
  expect(text).not.toMatch(/onboarding complete|still needs|resume:/i);
});

test("the runner question defaults to no, and only an explicit yes starts one", async () => {
  const no = fixture("no");
  expect(await no.ui.chooseRunner!()).toBe(false);
  expect(no.selections[0]!.initialValue).toBe("no");
  expect(no.selections[0]!.options.map((o) => o.value)).toEqual(["no", "yes"]);
  expect(await fixture("yes").ui.chooseRunner!()).toBe(true);
  const cancelled = fixture(Symbol("cancel"));
  expect(await cancelled.ui.chooseRunner!()).toBeNull();
  expect(cancelled.ui.signal.aborted).toBe(true);
});

test("CTC-4739 — the runner question says what Yes and No mean, and the flags that skip it, before it asks", async () => {
  const { ui, events } = fixture("no");
  expect(await ui.chooseRunner!()).toBe(false);
  const ask = events.findIndex((e) => e.kind === "select");
  const said = events
    .slice(0, ask)
    .map((e) => e.text ?? "")
    .join("\n");
  expect(ask).toBeGreaterThan(0);
  expect(said).toContain(
    "Yes makes this computer pick up tickets and run agents in Docker with your workspace's AI accounts",
  );
  expect(said).toContain("uses this computer's CPU and memory while it is on");
  expect(said).toContain(
    "No is right for a personal workstation: your workspace's runner hosts do the work.",
  );
  expect(said).toContain("--no-runner");
  expect(said).toContain("--runner");
  expect(said).not.toMatch(/tenant/i);
});

test("the first-ticket question lists the offered tickets, then a sample and skip", async () => {
  const pick = fixture("ENG-2");
  expect(
    await pick.ui.chooseFirstTicket!(
      [
        { identifier: "ENG-2", title: "Fix the login copy", estimate: 1 },
        { identifier: "ENG-8", title: "Add a footer", estimate: null },
      ],
      { teamKey: "ENG", stage: "Ready for Catalyst" },
    ),
  ).toBe("ENG-2");
  expect((pick.selections[0] as { message?: string }).message).toBe(
    "Which ticket should Catalyst start first? It moves to Ready for Catalyst in ENG.",
  );
  expect(pick.selections[0]!.initialValue).toBe("ENG-2");
  expect(pick.selections[0]!.options.map((o) => o.value)).toEqual([
    "ENG-2",
    "ENG-8",
    "create-sample",
    "skip",
  ]);
  const empty = fixture("create-sample");
  expect(await empty.ui.chooseFirstTicket!([], { teamKey: "ENG", stage: "Todo" })).toBe("create-sample");
  expect(empty.selections[0]!.initialValue).toBe("create-sample");
  const cancelled = fixture(Symbol("cancel"));
  expect(await cancelled.ui.chooseFirstTicket!([], { teamKey: "ENG", stage: "Todo" })).toBeNull();
  expect(cancelled.ui.signal.aborted).toBe(true);
});

// CTC-4630: the workflow plan is approved inline, and the automation check speaks plainly.
test.each([
  ["apply", true],
  ["skip", false],
] as const)("the workflow plan question answered %s returns %s", async (answer, expected) => {
  const f = fixture(answer);
  expect(
    await f.ui.confirmWorkflowAdoption!("ENG", [
      "Create stages: Research, Plan",
      "Keep existing stages: Todo, Done",
    ]),
  ).toBe(expected);
  expect(f.events).toContainEqual({
    kind: "message",
    text: "Catalyst workflow plan for ENG:\nCreate stages: Research, Plan\nKeep existing stages: Todo, Done",
  });
  expect(f.selections).toHaveLength(1);
  expect(f.selections[0]!.initialValue).toBe("apply");
  expect(f.selections[0]!.options.map((option) => option.value)).toEqual([
    "apply",
    "skip",
  ]);
  expect(f.ui.signal.aborted).toBe(false);
  f.ui.dispose();
});

test("cancelling the workflow plan question applies nothing and stops setup", async () => {
  const f = fixture(Symbol("cancel"));
  expect(await f.ui.confirmWorkflowAdoption!("ENG", ["Create stages: Plan"])).toBe(
    false,
  );
  expect(f.ui.signal.aborted).toBe(true);
  f.ui.dispose();
});

const ended = (
  step: OnboardJournal["steps"][number],
  value: OnboardJournal = adoptedTeam(),
) => {
  const f = fixture();
  f.ui.stepStart(step.id);
  f.ui.stepEnd(step, value);
  f.ui.dispose();
  return f.events
    .filter((event) => ["info", "message", "warn", "error"].includes(event.kind))
    .at(-1)!;
};

test("compatible pull request automations show one green line", () => {
  expect(
    ended({ id: "linear.automations", state: "done", reason: "automations_compatible" }),
  ).toEqual({
    kind: "info",
    text: "✓ Check Linear's pull request automations: Nothing to change.",
  });
});

test("conflicting pull request automations say what to change in Linear and where", () => {
  const line = ended({
    id: "linear.automations",
    state: "skipped",
    reason: "automation_management_unavailable",
    evidence: { automations: "open,merge" },
  });
  expect(line.kind).toBe("message");
  expect(line.text).toContain("Open https://linear.app/fixture/settings/teams/ENG/workflow and set each pull request automation to No action.");
  expect(line.text).not.toMatch(/automation management unavailable/i);
});

test("unread pull request automations say plainly that cloud readiness checks them", () => {
  const line = ended({
    id: "linear.automations",
    state: "skipped",
    reason: "automation_management_unavailable",
  });
  expect(line.kind).toBe("message");
  expect(line.text).toContain("could not read them; checked again before work starts");
  expect(line.text).not.toMatch(/automation management unavailable/i);
});


test.each([undefined, "../other", "bad/slug", "x\u001b[31m"])("automation action does not invent a link from unsafe workspace slug %s", (workspaceSlug) => {
  const value = adoptedTeam();
  value.steps[0]!.evidence = workspaceSlug === undefined ? {} : { workspaceSlug };
  const line = ended({ id: "linear.automations", state: "skipped", reason: "automation_management_unavailable", evidence: { automations: "merge" } }, value);
  expect(line.text).toContain("Open your ENG team's workflow settings in Linear and set each pull request automation to No action.");
  expect(line.text).not.toContain("https://linear.app/");
});

test("CTC-4680 round 5: a timed-out link asks to try again, and stopping pauses setup", async () => {
  const again = fixture("again");
  expect(await again.ui.retryTimedOut!("github.install")).toBe(true);
  expect(again.ui.signal.aborted).toBe(false);
  expect(again.selections[0]!.initialValue).toBe("again");
  expect(again.selections[0]!.options.map((o) => o.value)).toEqual(["again", "stop"]);
  const said = again.events.map((e) => e.text ?? "").join("\n");
  expect(said).toMatch(/the link timed out/i);
  expect(said).not.toMatch(/tenant|consent_timeout|_browser_unavailable/);
  const stop = fixture("stop");
  expect(await stop.ui.retryTimedOut!("github.install")).toBe(false);
  expect(stop.ui.signal.aborted).toBe(true);
  const cancelled = fixture(Symbol("cancel"));
  expect(await cancelled.ui.retryTimedOut!("linear.workspace")).toBe(false);
  expect(cancelled.ui.signal.aborted).toBe(true);
});

 test("returning workspace choice defaults to moving on instead of the first project", async () => {
   const f = fixture("move-on");
   expect(await f.ui.reviewProjects!([{ id: "team-cloud", key: "CTC", name: "Cloud", status: "Ready" }, { id: "team-sdk", key: "SDK", name: "SDK", status: "Merge queue needs attention" }])).toBe("move-on");
   expect(f.selections[0]!.initialValue).toBe("move-on");
   expect(f.selections[0]!.options.map(o => o.value)).toEqual(["move-on", "repair:team-cloud", "repair:team-sdk", "cleanup:team-cloud", "cleanup:team-sdk", "new"]);
   f.ui.dispose();
 });

 test("project cleanup shows its preview and defaults to keeping the project", async () => {
   const f = fixture("keep");
   expect(await f.ui.confirmProjectCleanup!({ id: "team-sdk", key: "SDK", name: "SDK", status: "Ready" }, ["Stop mirroring org/sdk."])).toBe(false);
   expect(f.events.find(e => e.text === "Stop mirroring org/sdk.")).toBeDefined();
   expect(f.selections[0]!.initialValue).toBe("keep");
   f.ui.dispose();
 });

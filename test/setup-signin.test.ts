// setup-signin.test.ts — CTC-4625: step 4 of `catalyst setup`, the browser sign-in, as words on
// the screen and as the one outcome the engine reads back.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { loadConfig, saveConfig, type CustomerConfig } from "../src/config.js";
import { CliError } from "../src/errors.js";
import type { DeviceCodePresentation } from "../src/oauth.js";
import { createSetupRenderer, type SetupStream } from "../src/setup-render.js";
import {
  keepInstalledCliPath,
  runSetupSignin,
  type SetupLoginDeps,
} from "../src/setup-signin.js";
import { makeCtx, tempHome } from "./helpers.js";

function sink(): SetupStream & { text(): string } {
  const chunks: string[] = [];
  return {
    isTTY: false,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(""),
  };
}

const code: DeviceCodePresentation = {
  verificationUri: "https://renewed-grass-57-staging.authkit.app/device",
  userCode: "DGSB-NSKL",
  completeUri:
    "https://renewed-grass-57-staging.authkit.app/device?user_code=DGSB-NSKL",
  round: 1,
  rounds: 3,
};

function setup(
  login: (deps: SetupLoginDeps, log: (line: string) => void) => Promise<number>,
) {
  const out = sink();
  const r = createSetupRenderer(out, {
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  });
  const ctx = makeCtx(tempHome());
  return {
    out,
    run: (seconds = 600, interrupted?: AbortSignal) =>
      runSetupSignin(ctx, r, seconds, {
        login: (loginCtx, deps) => login(deps, loginCtx.stdout),
        ...(interrupted ? { interrupted } : {}),
      }),
  };
}

describe("runSetupSignin", () => {
  test("says what the step is for, then the fill-in link first, then the address and the code", async () => {
    const s = setup(async (deps) => {
      deps.present(code);
      return 0;
    });
    expect(await s.run()).toBe("done");
    const lines = s.out
      .text()
      .trimEnd()
      .split("\n")
      .map((l) => l.trim());
    expect(lines[0]).toMatch(
      /^This connects this computer to your Catalyst account, so catalyst and/,
    );
    const link = lines.indexOf(code.completeUri ?? "");
    const address = lines.findIndex((l) => l.startsWith("Or open"));
    expect(link).toBeGreaterThan(0);
    expect(address).toBeGreaterThan(link);
    expect(s.out.text().replace(/\s+/g, " ")).toContain(
      `Or open ${code.verificationUri} and enter DGSB-NSKL.`,
    );
  });

  test("names the sign-in page's host when it is not Catalyst Cloud's", async () => {
    const s = setup(async (deps) => {
      deps.present(code);
      return 0;
    });
    await s.run();
    expect(s.out.text().replace(/\s+/g, " ")).toContain(
      "That page is Catalyst's sign-in page, hosted by WorkOS.",
    );
    const own = setup(async (deps) => {
      deps.present({
        ...code,
        verificationUri: "https://app.catalystcloud.dev/device",
        completeUri: undefined,
      });
      return 0;
    });
    await own.run();
    expect(own.out.text()).not.toContain("served from");
  });

  test("a replacement code says so", async () => {
    const s = setup(async (deps) => {
      deps.present({ ...code, round: 2 });
      return 0;
    });
    await s.run();
    expect(s.out.text()).toContain("new code 2 of 3 · 10:00 left");
  });

  test("in a pipe the wait is one plain line with its limit, never an escape", async () => {
    const s = setup(async (deps) => {
      deps.present(code);
      return deps.waitForApproval(async () => 0);
    });
    await s.run(600);
    expect(s.out.text()).toContain(
      "waiting for you (up to 10 minutes). Ctrl-C stops setup.",
    );
    expect(s.out.text()).not.toContain("\u001b");
  });

  test("on a terminal the step status counts down without a second spinner", async () => {
    const chunks: string[] = [];
    const out: SetupStream = {
      isTTY: true,
      columns: 80,
      write(s) {
        chunks.push(s);
        return true;
      },
    };
    const r = createSetupRenderer(out, {
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
    });
    r.begin(4, "Sign in to Catalyst");
    let now = 0;
    await runSetupSignin(makeCtx(tempHome()), r, 600, {
      now: () => now,
      login: async (_ctx, deps) => {
        deps.present({
          ...code,
          verificationUri: "https://example.com/device",
          completeUri: "https://example.com/device?code=DGSB-NSKL",
        });
        return deps.waitForApproval(async () => {
          now = 48000;
          await new Promise((resolve) => setTimeout(resolve, 1100));
          return 0;
        });
      },
    });
    expect(chunks.join("")).toContain("waiting for you · 10:00 left");
    expect(chunks.join("")).toContain("waiting for you · 9:12 left");
    r.dispose();
  });

  test("the time limit running out is timeout; an expired third code is timeout too", async () => {
    const slow = setup(
      (deps) =>
        new Promise((_resolve, reject) =>
          deps.signal.addEventListener("abort", () =>
            reject(new CliError("Sign-in paused.", "login-cancelled", 11)),
          ),
        ),
    );
    expect(await slow.run(1)).toBe("timeout");
    const expired = setup(async () => {
      throw new CliError("The sign-in code expired 3 times.", "login-expired");
    });
    expect(await expired.run()).toBe("timeout");
  });

  test("Ctrl-C during the wait is cancelled, not timeout", async () => {
    const stop = new AbortController();
    const s = setup(
      (deps) =>
        new Promise((_resolve, reject) => {
          deps.signal.addEventListener("abort", () =>
            reject(new CliError("Sign-in paused.", "login-cancelled", 11)),
          );
          setTimeout(() => stop.abort(), 10);
        }),
    );
    expect(await s.run(600, stop.signal)).toBe("cancelled");
  });

  test("a login that ends without signing in shows its own last line as the reason", async () => {
    const s = setup(async (deps, log) => {
      deps.present(code);
      log("catalyst: login was denied, run: catalyst login to try again");
      return 2;
    });
    expect(await s.run()).toBe("failed");
    expect(s.out.text().replace(/\s+/g, " ")).toContain(
      "The sign-in did not finish: catalyst: login was denied, run: catalyst login to try again",
    );
  });

  test("a login that throws shows the error as the reason", async () => {
    const s = setup(async () => {
      throw new CliError("access_denied", "login-denied");
    });
    expect(await s.run()).toBe("failed");
    expect(s.out.text()).toContain("The sign-in did not finish: access_denied");
  });
});

describe("keepInstalledCliPath", () => {
  function fixture() {
    const home = tempHome();
    const temporary = mkdtempSync(join(tmpdir(), "catalyst-setup-cli-"));
    const running = join(
      temporary,
      "node_modules",
      "@catalyst-cloud",
      "cli",
      "bin",
      "catalyst.js",
    );
    mkdirSync(dirname(running), { recursive: true });
    writeFileSync(running, "");
    const global = mkdtempSync(join(tmpdir(), "global-"));
    const real = join(
      global,
      "lib",
      "node_modules",
      "@catalyst-cloud",
      "cli",
      "bin",
      "catalyst.js",
    );
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, "");
    mkdirSync(join(global, "bin"));
    symlinkSync(real, join(global, "bin", "catalyst"));
    saveConfig(home, { ...baseConfig, cliPath: running });
    return {
      home,
      temporary,
      running,
      real: realpathSync(real),
      bin: join(global, "bin"),
    };
  }
  const baseConfig: CustomerConfig = {
    baseUrl: "https://cloud.example",
    key: "fixture-personal-key",
    account: "acct",
    slug: "acme",
    name: "Acme",
    permissions: [],
    principal: "session",
    joinedAt: "2026-10-02T00:00:00Z",
    lastSkillBundleVersion: "0.14.10",
  };

  test("a sign-in made by the temporary command records the installed command instead", () => {
    const f = fixture();
    const ctx = makeCtx(f.home, {
      env: {
        PATH: `${f.bin}:/usr/bin:/bin`,
        CATALYST_INSTALL_TEMP_CLI: f.temporary,
      },
    });
    keepInstalledCliPath(ctx, f.running);
    expect(loadConfig(f.home)?.cliPath).toBe(f.real);
  });

  test("an installed command running setup keeps its own path", () => {
    const f = fixture();
    const ctx = makeCtx(f.home, { env: { PATH: `${f.bin}:/usr/bin:/bin` } });
    keepInstalledCliPath(ctx, f.running);
    expect(loadConfig(f.home)?.cliPath).toBe(f.running);
  });

  test("with no installed command on PATH the record is left alone", () => {
    const f = fixture();
    const ctx = makeCtx(f.home, {
      env: { PATH: f.home, CATALYST_INSTALL_TEMP_CLI: f.temporary },
    });
    keepInstalledCliPath(ctx, f.running);
    expect(loadConfig(f.home)?.cliPath).toBe(f.running);
  });
});

test("replacement sign-in code retains its reason and interrupt hint on the next countdown tick", async () => {
  vi.useFakeTimers();
  const chunks: string[] = [];
  const r = createSetupRenderer(
    {
      isTTY: true,
      columns: 100,
      write(s) {
        chunks.push(s);
        return true;
      },
    },
    { TERM: "xterm-256color", LANG: "C.UTF-8" },
  );
  r.begin(4, "Sign in to Catalyst");
  let finish!: () => void;
  try {
    const run = runSetupSignin(makeCtx(tempHome()), r, 600, {
      login: async (_ctx, deps) => {
        deps.present(code);
        return deps.waitForApproval(async () => {
          deps.present({ ...code, round: 2, userCode: "ABCD-EFGH" });
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return 0;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const text = chunks.join("");
    const current = text.slice(text.lastIndexOf("new code 2 of 3"));
    expect(current).toContain("new code 2 of 3");
    expect(current).toContain("This connects this computer");
    expect(current).toContain("Ctrl-C stops setup.");
    expect(current).toContain("ABCD-EFGH");
    finish();
    await run;
  } finally {
    r.dispose();
    vi.useRealTimers();
  }
});
test("plain sign-in reminder uses one minute", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const s = setup((deps) => {
    deps.present(code);
    return deps.waitForApproval(
      () =>
        new Promise<number>((r) => {
          finish = () => r(0);
        }),
    );
  });
  try {
    const run = s.run(120);
    await vi.advanceTimersByTimeAsync(60000);
    expect(s.out.text()).toContain("Still waiting, 1 minute left.");
    finish();
    await run;
  } finally {
    vi.useRealTimers();
  }
});

test("real per-code approval waits print one interrupt hint in each replacement frame", async () => {
  const chunks: string[] = [];
  const r = createSetupRenderer(
    {
      isTTY: true,
      columns: 100,
      write(s) {
        chunks.push(s);
        return true;
      },
    },
    { TERM: "xterm-256color", LANG: "C.UTF-8" },
  );
  r.begin(4, "Sign in to Catalyst");
  await runSetupSignin(makeCtx(tempHome()), r, 600, {
    login: async (_ctx, deps) => {
      deps.present(code);
      await deps.waitForApproval(async () => 0);
      deps.present({ ...code, round: 2 });
      await deps.waitForApproval(async () => 0);
      return 0;
    },
  });
  const text = chunks.join("");
  const frame = text.slice(text.lastIndexOf("new code 2 of 3"));
  expect(frame.match(/Ctrl-C stops setup/g)).toHaveLength(1);
  r.dispose();
});

test("a replacement code in plain mode shows the remaining shared deadline", async () => {
  const out = sink();
  const r = createSetupRenderer(out, { NO_COLOR: "1" });
  let now = 0;
  expect(
    await runSetupSignin(makeCtx(tempHome()), r, 600, {
      now: () => now,
      login: async (_ctx, deps) => {
        deps.present(code);
        await deps.waitForApproval(async () => 0);
        now = 8 * 60_000;
        deps.present({ ...code, round: 2 });
        return deps.waitForApproval(async () => 0);
      },
    }),
  ).toBe("done");
  expect(out.text()).toContain("waiting for you (up to 2 minutes).");
  expect(
    out.text().match(/waiting for you \(up to 10 minutes\)/g),
  ).toHaveLength(1);
});

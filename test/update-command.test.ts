// update-command.test.ts — `catalyst update` and `catalyst update policy` through the real
// dispatcher (CTC-6708), plus `catalyst runner update --check` listing every component, with the
// image engine injected so output and exit codes are checked without Docker.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { readUpdatePolicy, updatePolicyPathFor } from "../src/update-policy";
import { makeCtx, tempHome } from "./helpers";
import { answered, approved, CLI_VERSION, countingEngine, fakeNpm, hostRelease, NEXT, OLD, runnerInstall, sdkProject } from "./update-fixtures";

describe("catalyst update policy", () => {
  it("POSITIVE CONTROL: turning the CLI off says so, keeps the others, and saves it", async () => {
    const home = tempHome();
    const ctx = makeCtx(home);
    expect(await main(["update", "policy", "cli", "off"], ctx)).toBe(0);
    expect(ctx.out).toEqual(["Automatic CLI updates are off. Other components keep their settings."]);
    expect(readUpdatePolicy(home).components).toEqual({ cli: { enabled: false, source: "owner" } });
    const listed = makeCtx(home);
    expect(await main(["update", "policy"], listed)).toBe(0);
    expect(listed.out[0]).toBe("Automatic updates:");
    expect(listed.out.find((l) => l.startsWith("CLI "))).toMatch(/off\s+\(owner\)/);
    expect(listed.out.find((l) => l.startsWith("Runner "))).toMatch(/on\s+\(default\)/);
    expect(listed.out).toContain("SDK projects: none registered");
  });

  it("a project's SDK setting needs an absolute --project and is stored by real path", async () => {
    const home = tempHome();
    const project = sdkProject("0.16.0");
    const ctx = makeCtx(home);
    expect(await main(["update", "policy", "sdk", "off", "--project", project], ctx)).toBe(0);
    expect(ctx.out[0]).toContain("Automatic SDK updates are off for");
    expect(ctx.out[0]).toContain("Release checks will only report available updates.");
    expect(readUpdatePolicy(home).projects).toMatchObject([{ sdk: "notify", source: "owner" }]);
  });

  it.each([
    [["update", "policy", "daemon", "off"], /unknown component: daemon/],
    [["update", "policy", "cli", "maybe"], /catalyst update/],
    [["update", "policy", "sdk", "on"], /needs --project/],
    [["update", "policy", "sdk", "on", "--project", "relative/app"], /--project must be an absolute path/],
    [["update", "policy", "cli", "off", "--project", "/tmp"], /--project goes with update policy sdk/],
    [["update", "--dir", "relative"], /--dir must be an absolute path/],
    [["update", "now"], /catalyst update/],
  ])("NEGATIVE: %j is a usage error that changes no setting", async (argv, message) => {
    const home = tempHome();
    const ctx = makeCtx(home);
    expect(await main(argv, ctx)).toBe(1);
    expect(ctx.err.join("\n")).toMatch(message);
    expect(() => readFileSync(updatePolicyPathFor(home))).toThrow();
  });
});

describe("catalyst update --check", () => {
  it("prints the component report and the --json decision model", async () => {
    const home = tempHome();
    const dir = runnerInstall();
    const engine = countingEngine(answered(hostRelease({ components: approved() })));
    const ctx = makeCtx(home);
    expect(await main(["update", "--check", "--dir", dir], ctx, { update: { engine } })).toBe(0);
    expect(ctx.out[0]).toBe(`Approved release: example-89, generation 89, train ${NEXT.split(".").slice(0, 2).join(".")}`);
    expect(ctx.out.at(-1)).toBe("Checked the approved release; nothing was changed.");

    const json = makeCtx(home);
    expect(await main(["update", "--check", "--json", "--dir", dir], json, { update: { engine } })).toBe(0);
    const body = JSON.parse(json.out[0] ?? "{}") as { schemaVersion: number; mode: string; components: { id: string; installed: string | null }[] };
    expect(body).toMatchObject({ schemaVersion: 1, mode: "check", exitCode: 0 });
    expect(body.components.find((c) => c.id === "cli")?.installed).toBe(CLI_VERSION);
  });
});

describe("catalyst runner update --check names every component", () => {
  it("with the CLI held by its owner, the image check stays first and the CLI row says it is held", async () => {
    const home = tempHome();
    const dir = runnerInstall();
    expect(await main(["update", "policy", "cli", "off"], makeCtx(home))).toBe(0);
    const engine = countingEngine(answered(hostRelease({ components: approved() })));
    const ctx = makeCtx(home);
    expect(await main(["runner", "update", "--check", "--dir", dir], ctx, { runner: { engine } })).toBe(0);
    expect(ctx.out[0]).toBe("Checked the approved release; nothing was changed.");
    expect(ctx.out.find((l) => l.startsWith("CLI "))).toContain("held by owner's setting");
    expect(ctx.out.find((l) => l.startsWith("Runner "))).toContain("update available");
    // One desired-release read serves both halves.
    expect(engine.calls.desiredRelease).toBe(1);

    const json = makeCtx(home);
    expect(await main(["runner", "update", "--check", "--json", "--dir", dir], json, { runner: { engine } })).toBe(0);
    const body = JSON.parse(json.out[0] ?? "{}") as Record<string, unknown>;
    // The fields scripts already read stay at the top, beside the new component list.
    expect(body).toMatchObject({ outcome: "planned", generation: 89, exitCode: 0, schemaVersion: 1 });
    expect((body.components as { id: string; status: string }[]).find((c) => c.id === "cli")).toMatchObject({ status: "held", reason: "owner_setting" });
  });
});

describe("catalyst update sdk --project", () => {
  it("POSITIVE CONTROL: one explicit update of one project, which leaves its automatic setting off", async () => {
    const home = tempHome();
    const dir = runnerInstall();
    const project = sdkProject(OLD);
    const engine = countingEngine(answered(hostRelease({ components: approved() })));
    const calls: string[][] = [];
    const ctx = makeCtx(home);
    expect(await main(["update", "sdk", "--project", project, "--dir", dir], ctx, { update: { engine, sdkExec: fakeNpm(calls) } })).toBe(0);
    expect(calls).toHaveLength(1);
    expect(ctx.out).toEqual([
      `@catalyst-cloud/sdk in ${project}: updated from ${OLD} to ${NEXT} with npm.`,
      `Automatic SDK updates remain off for ${project}.`,
    ]);
    // The explicit update registers nothing and changes no setting.
    expect(readUpdatePolicy(home).projects).toEqual([]);
  });

  it("with no usable approval it changes nothing and exits 1", async () => {
    const home = tempHome();
    const project = sdkProject(OLD);
    const calls: string[][] = [];
    const ctx = makeCtx(home);
    expect(await main(["update", "sdk", "--project", project, "--dir", "/nonexistent-runner"], ctx, { update: { sdkExec: fakeNpm(calls) } })).toBe(1);
    expect(ctx.out).toEqual(["Approved release unavailable: sign in with catalyst login.", "Nothing was changed."]);
    expect(calls).toEqual([]);
  });

  it("turning a project's SDK updates on says release checks may update its package files", async () => {
    const home = tempHome();
    const project = sdkProject(OLD);
    const ctx = makeCtx(home);
    expect(await main(["update", "policy", "sdk", "on", "--project", project], ctx)).toBe(0);
    expect(ctx.out[0]).toMatch(/^Automatic SDK updates are on for .+\. Release checks may update its package files\.$/);
  });
});

describe("runner update honours the owner's image holds (review fixes)", () => {
  it("the scheduled --auto run keeps the images while one is held, and never reads the release", async () => {
    const home = tempHome();
    expect(await main(["update", "policy", "supervisor", "off"], makeCtx(home))).toBe(0);
    const engine = countingEngine(answered(hostRelease({ components: approved() })));
    const ctx = makeCtx(home, { now: () => new Date("2026-10-23T15:00:00.000Z") });
    expect(await main(["runner", "update", "--auto", "--dir", runnerInstall()], ctx, { runner: { engine } })).toBe(0);
    expect(ctx.out).toEqual(["2026-10-23T15:00:00.000Z retained owner_setting generation=88"]);
    expect(engine.calls).toEqual({});
  });

  it("unreadable settings keep the images and exit 1; runner update --check still prints its image result", async () => {
    const home = tempHome();
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(join(home, ".config", "catalyst-cloud", "updates.json"), "{");
    const engine = countingEngine(answered(hostRelease({ components: approved() })));
    const apply = makeCtx(home);
    expect(await main(["runner", "update", "--dir", runnerInstall()], apply, { runner: { engine } })).toBe(1);
    expect(apply.out[1]).toContain("update_policy_unreadable");
    const check = makeCtx(home);
    expect(await main(["runner", "update", "--check", "--dir", runnerInstall()], check, { runner: { engine } })).toBe(0);
    expect(check.out[0]).toBe("Checked the approved release; nothing was changed.");
    expect(check.err.join("\n")).toContain("update settings at");
  });
});


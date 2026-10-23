// update-sdk.test.ts — a project's SDK against the approved release (CTC-6708): declared, locked
// and installed versions read apart, each module at its own approved version, the dependency group
// kept, ambiguity reported instead of guessed, and not one project byte changed.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseApprovedRelease, type ApprovedRelease } from "../src/approved-release";
import { applySdkUpdate, inspectSdkProject, type SdkExec } from "../src/update-sdk";
import { tempHome } from "./helpers";
import { approved, fakeNpm, NEXT, OLD, sdkProject, TRAIN } from "./update-fixtures";

function release(): ApprovedRelease {
  const parsed = parseApprovedRelease(approved());
  if (!parsed.ok) throw new Error("fixture must parse");
  return parsed.release;
}
const bytes = (dir: string) => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));

describe("inspectSdkProject", () => {
  it("POSITIVE CONTROL: a lockfile pinning an older SDK is behind, with one exact npm command, and no byte changes", () => {
    const dir = sdkProject(OLD);
    const before = bytes(dir);
    const project = inspectSdkProject(dir, release());
    expect(project).toMatchObject({
      packageManager: "npm",
      status: "update_available",
      packages: [{ name: "@catalyst-cloud/sdk", group: "dependencies", declared: OLD, locked: OLD, installed: null, approved: NEXT }],
      command: `catalyst update sdk --project ${dir}`,
      packageManagerCommand: `cd ${dir} && npm install --save-exact @catalyst-cloud/sdk@${NEXT}`,
    });
    expect(bytes(dir)).toEqual(before);
  });

  it("each declared module moves to its own approved version; an undeclared one is never added", () => {
    const dir = sdkProject(OLD, { replicaNode: `${TRAIN}.0` });
    const project = inspectSdkProject(dir, release());
    expect(project.packageManagerCommand).toBe(`cd ${dir} && npm install --save-exact @catalyst-cloud/sdk@${NEXT} @catalyst-cloud/sdk-replica-node@${TRAIN}.1`);
    expect(project.packageManagerCommand).not.toContain("sdk-replica-browser");
  });

  it("a development dependency stays one", () => {
    const dir = sdkProject(OLD, { dev: true });
    expect(inspectSdkProject(dir, release()).packageManagerCommand).toBe(`cd ${dir} && npm install --save-exact --save-dev @catalyst-cloud/sdk@${NEXT}`);
  });

  it("the installed package wins over the lockfile, and a current project offers nothing", () => {
    const dir = sdkProject(OLD);
    mkdirSync(join(dir, "node_modules", "@catalyst-cloud", "sdk"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "@catalyst-cloud", "sdk", "package.json"), JSON.stringify({ version: NEXT }));
    expect(inspectSdkProject(dir, release())).toMatchObject({ status: "current", command: null, packages: [{ locked: OLD, installed: NEXT }] });
  });

  it("a range is never reported as the installed version", () => {
    const dir = sdkProject(`^${OLD}`, { lockfiles: [] });
    expect(inspectSdkProject(dir, release())).toMatchObject({ status: "unknown", reason: "installed_version_unknown", command: null });
  });

  it("two lockfiles and no declared manager is ambiguous and offers no command", () => {
    const dir = sdkProject(OLD, { lockfiles: ["package-lock.json", "yarn.lock"] });
    expect(inspectSdkProject(dir, release())).toMatchObject({ status: "unknown", reason: "package_manager_ambiguous", command: null });
  });

  it("the declared manager is used, and a path with spaces is quoted", () => {
    const root = mkdtempSync(join(tmpdir(), "sdk spaces "));
    const dir = join(root, "my app");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0", dependencies: { "@catalyst-cloud/sdk": OLD } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(inspectSdkProject(dir, release())).toMatchObject({
      command: `catalyst update sdk --project '${dir}'`,
      packageManagerCommand: `cd '${dir}' && pnpm add --save-exact @catalyst-cloud/sdk@${NEXT}`,
    });
  });

  it("a project with no SDK, or no approval, offers nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-sdk-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { left: "1.0.0" } }));
    expect(inspectSdkProject(dir, release())).toMatchObject({ status: "no_sdk", command: null });
    expect(inspectSdkProject(sdkProject(OLD), null)).toMatchObject({ status: "approval_unavailable", command: null });
  });
});

describe("applySdkUpdate: the owner's explicit update of one project", () => {
  it("POSITIVE CONTROL: runs the project's own manager by argv with exact versions and reads the result back", () => {
    const dir = sdkProject(OLD, { replicaNode: `${TRAIN}.0`, dev: true });
    const calls: string[][] = [];
    const result = applySdkUpdate(tempHome(), dir, release(), fakeNpm(calls));
    expect(calls).toEqual([["npm", "install", "--save-exact", "--save-dev", `@catalyst-cloud/sdk@${NEXT}`, `@catalyst-cloud/sdk-replica-node@${TRAIN}.1`]]);
    expect(result).toMatchObject({
      outcome: "updated",
      detail: "npm",
      moved: [
        { name: "@catalyst-cloud/sdk", from: OLD, to: NEXT },
        { name: "@catalyst-cloud/sdk-replica-node", from: `${TRAIN}.0`, to: `${TRAIN}.1` },
      ],
    });
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { devDependencies: Record<string, string>; dependencies?: unknown };
    expect(manifest.devDependencies["@catalyst-cloud/sdk"]).toBe(NEXT);
    expect(manifest.dependencies).toBeUndefined();
  });

  it("a failed install puts the package files back byte for byte", () => {
    const dir = sdkProject(OLD);
    const before = { manifest: readFileSync(join(dir, "package.json"), "utf8"), lock: readFileSync(join(dir, "package-lock.json"), "utf8") };
    const result = applySdkUpdate(tempHome(), dir, release(), fakeNpm([], { fail: true }));
    expect(result).toMatchObject({ outcome: "failed", detail: "package_manager_failed", moved: [] });
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before.manifest);
    expect(readFileSync(join(dir, "package-lock.json"), "utf8")).toBe(before.lock);
  });

  it("an install that does not land the approved version is a failure, never reported as updated", () => {
    const dir = sdkProject(OLD);
    const noop: SdkExec = () => ({ status: 0, stderr: "" });
    expect(applySdkUpdate(tempHome(), dir, release(), noop)).toMatchObject({ outcome: "failed", detail: "verify_failed" });
  });

  it("a package already newer than approved is kept when another is behind: it is never moved down", () => {
    const dir = sdkProject(OLD, { replicaNode: `${TRAIN}.30` });
    expect(inspectSdkProject(dir, release()).packageManagerCommand).toBe(`cd ${dir} && npm install --save-exact @catalyst-cloud/sdk@${NEXT}`);
    const calls: string[][] = [];
    const result = applySdkUpdate(tempHome(), dir, release(), fakeNpm(calls));
    expect(calls).toEqual([["npm", "install", "--save-exact", `@catalyst-cloud/sdk@${NEXT}`]]);
    expect(result).toMatchObject({ outcome: "updated", moved: [{ name: "@catalyst-cloud/sdk", from: OLD, to: NEXT }] });
    expect(result.moved).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@catalyst-cloud/sdk-replica-node"]).toBe(`${TRAIN}.30`);
  });

  it("an ambiguous project is refused and its manager never runs", () => {
    const dir = sdkProject(OLD, { lockfiles: ["package-lock.json", "yarn.lock"] });
    const calls: string[][] = [];
    expect(applySdkUpdate(tempHome(), dir, release(), fakeNpm(calls))).toMatchObject({ outcome: "refused", detail: "package_manager_ambiguous" });
    expect(calls).toEqual([]);
  });
});

describe("applySdkUpdate after an interrupted or failed run (review fixes)", () => {
  const lockFor = (home: string, dir: string) =>
    join(home, ".config", "catalyst-cloud", "sdk-update-locks", `${createHash("sha256").update(dir).digest("hex").slice(0, 32)}.lock`);

  it("a live run's lock refuses a second run; a lock left by a killed run is taken over once stale", () => {
    const home = tempHome();
    const dir = sdkProject(OLD);
    const lock = lockFor(home, dir);
    mkdirSync(join(lock, ".."), { recursive: true });
    writeFileSync(lock, "");
    expect(applySdkUpdate(home, dir, release(), fakeNpm([]))).toMatchObject({ outcome: "refused", detail: "update_running" });
    const old = new Date(Date.now() - 16 * 60_000);
    utimesSync(lock, old, old);
    expect(applySdkUpdate(home, dir, release(), fakeNpm([]))).toMatchObject({ outcome: "updated" });
    expect(existsSync(lock)).toBe(false);
  });

  it("a lockfile the failed install created is removed with the rest put back", () => {
    const dir = sdkProject(OLD, { lockfiles: [] });
    const manifest = readFileSync(join(dir, "package.json"), "utf8");
    const creates: SdkExec = (_argv, cwd) => {
      writeFileSync(join(cwd, "package-lock.json"), "{}");
      writeFileSync(join(cwd, "package.json"), "{}");
      return { status: 1, stderr: "npm ERR!" };
    };
    expect(applySdkUpdate(tempHome(), dir, release(), creates)).toMatchObject({ outcome: "failed" });
    expect(existsSync(join(dir, "package-lock.json"))).toBe(false);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(manifest);
  });
});


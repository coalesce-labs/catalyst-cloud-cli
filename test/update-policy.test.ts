// update-policy.test.ts — the owner's per-component settings (CTC-6708): everything on by default,
// every component held independently, a damaged file never read as "everything on", private atomic
// writes under a lock, and project paths kept by their real path and identity.
import { mkdirSync, mkdtempSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliError, UsageError } from "../src/errors";
import {
  canonicalProject,
  effectivePolicy,
  projectIdentityHolds,
  readUpdatePolicy,
  setComponentPolicy,
  setProjectSdkPolicy,
  UPDATE_COMPONENTS,
  updatePolicyPathFor,
} from "../src/update-policy";
import { tempHome } from "./helpers";

describe("defaults and holds", () => {
  it("POSITIVE CONTROL: with no settings file every component is on by default", () => {
    const policy = readUpdatePolicy(tempHome());
    for (const id of UPDATE_COMPONENTS) expect(effectivePolicy(policy, id)).toEqual({ enabled: true, source: "default" });
    expect(policy.projects).toEqual([]);
  });

  it.each(UPDATE_COMPONENTS.map((id) => [id]))("holding %s holds only that component", (id) => {
    const home = tempHome();
    setComponentPolicy(home, id, false);
    const policy = readUpdatePolicy(home);
    for (const other of UPDATE_COMPONENTS)
      expect(effectivePolicy(policy, other)).toEqual(other === id ? { enabled: false, source: "owner" } : { enabled: true, source: "default" });
  });

  it("the file is private, and each change keeps the others (no lost update)", () => {
    const home = tempHome();
    setComponentPolicy(home, "cli", false);
    setComponentPolicy(home, "replica", false);
    setComponentPolicy(home, "cli", true);
    const policy = readUpdatePolicy(home);
    expect(policy.components).toEqual({ cli: { enabled: true, source: "owner" }, replica: { enabled: false, source: "owner" } });
    expect(statSync(updatePolicyPathFor(home)).mode & 0o777).toBe(0o600);
  });

  it("a writer holding the lock makes a second writer wait, then refuse, instead of overwriting", () => {
    const home = tempHome();
    setComponentPolicy(home, "cli", false);
    writeFileSync(`${updatePolicyPathFor(home)}.lock`, "");
    expect(() => setComponentPolicy(home, "runner", false)).toThrow(/another command is changing the update settings/);
    expect(readUpdatePolicy(home).components).toEqual({ cli: { enabled: false, source: "owner" } });
  });

  it.each([
    ["not JSON", "{"],
    ["an unknown component", JSON.stringify({ version: 1, components: { daemon: { enabled: false, source: "owner" } } })],
    ["a non-boolean setting", JSON.stringify({ version: 1, components: { cli: { enabled: "no", source: "owner" } } })],
    ["another version", JSON.stringify({ version: 2 })],
    ["a relative project path", JSON.stringify({ version: 1, projects: [{ path: "app", sdk: "notify", source: "owner", dev: 1, ino: 1 }] })],
  ])("NEGATIVE: a settings file with %s is an error, never read as everything on", (_label, text) => {
    const home = tempHome();
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(updatePolicyPathFor(home), text);
    expect(() => readUpdatePolicy(home)).toThrow(CliError);
  });
});

describe("project SDK settings", () => {
  it("a project is stored by its real path, and a symlink to it names the same project", () => {
    const home = tempHome();
    const root = mkdtempSync(join(tmpdir(), "policy-project-"));
    const project = join(root, "app");
    mkdirSync(project);
    const link = join(root, "link");
    symlinkSync(project, link);
    const saved = setProjectSdkPolicy(home, link, "notify");
    expect(saved.path).toBe(canonicalProject(project).path);
    setProjectSdkPolicy(home, project, "auto");
    expect(readUpdatePolicy(home).projects).toMatchObject([{ path: saved.path, sdk: "auto", source: "owner" }]);
  });

  it("a different directory moved into a registered path no longer holds the registration", () => {
    const root = mkdtempSync(join(tmpdir(), "policy-identity-"));
    const project = join(root, "app");
    mkdirSync(project);
    const home = tempHome();
    const saved = setProjectSdkPolicy(home, project, "auto");
    expect(projectIdentityHolds(saved)).toBe(true);
    renameSync(project, join(root, "moved"));
    mkdirSync(project);
    expect(projectIdentityHolds(saved)).toBe(false);
  });

  it("a relative or missing project path is refused", () => {
    expect(() => canonicalProject("relative/app")).toThrow(UsageError);
    expect(() => canonicalProject(join(tmpdir(), "no-such-project-ctc-6708"))).toThrow(/no project at/);
  });
});

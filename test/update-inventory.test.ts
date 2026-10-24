// update-inventory.test.ts — what an install has, read without changing it (CTC-6708): absent,
// installed and unknown are three different answers, and none of them is a guess.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloudPackInventory, devPackInventory, imageInventory, readInventory, replicaInventory } from "../src/update-inventory";
import { makeCtx, seedReplica, seedWriterState, tempHome } from "./helpers";
import { CLI_VERSION, cloudPack, OLD, ref, runnerInstall, signIn } from "./update-fixtures";

describe("readInventory", () => {
  it("POSITIVE CONTROL: the CLI is this package's version; nothing else installed reads as absent", () => {
    const home = tempHome();
    const ctx = makeCtx(home, { env: { CATALYST_SKILLS_CLAUDE_DIR: join(home, "skills") } });
    const inventory = readInventory(ctx, join(home, "no-runner"));
    expect(inventory.cli.version).toBe(CLI_VERSION);
    expect(inventory.images).toEqual({ installed: false, dir: join(home, "no-runner") });
    expect(inventory.skills.cloud.state).toBe("not_installed");
    expect(inventory.skills.dev.state).toBe("not_installed");
    expect(inventory.replica).toEqual({ state: "not_installed" });
  });
});

describe("imageInventory", () => {
  it("reads each digest-pinned image and the applied generation", () => {
    const dir = runnerInstall(["7", "8", "9"], 88);
    expect(imageInventory(dir)).toEqual({
      installed: true,
      dir,
      generation: 88,
      references: { runner: ref("runner", "7"), supervisor: ref("supervisor", "8"), watchdog: ref("watchdog", "9") },
    });
  });

  it("a tag or foreign image is unreadable, never guessed", () => {
    const dir = runnerInstall(["7", "8", "9"], null);
    writeFileSync(join(dir, ".env"), "CATALYST_RUNNER_IMAGE=ghcr.io/coalesce-labs/catalyst-runner:latest\n");
    expect(imageInventory(dir)).toMatchObject({ installed: true, generation: null, references: { runner: null, supervisor: null, watchdog: null } });
  });
});

describe("cloudPackInventory", () => {
  it("reads a stamped adoption candidate; an unstamped copy remains unowned", () => {
    const home = tempHome();
    const dir = cloudPack(OLD);
    expect(cloudPackInventory(makeCtx(home, { env: { CATALYST_SKILLS_CLAUDE_DIR: dir } }), null)).toMatchObject({ state: "installed", version: OLD, dir, evidence: { candidate: true, commit: null } });
    const unstamped = mkdtempSync(join(tmpdir(), "unstamped-"));
    mkdirSync(join(unstamped, "unstick"));
    writeFileSync(join(unstamped, "unstick", "SKILL.md"), "---\nname: unstick\n---\n<!-- vendored-from: @catalyst-cloud/catalyst-skills — old -->\n");
    expect(cloudPackInventory(makeCtx(home, { env: { CATALYST_SKILLS_CLAUDE_DIR: unstamped } }), null)).toMatchObject({ state: "unknown", reason: "installation_owner_unknown" });
  });
});

describe("devPackInventory", () => {
  it("a Dev pack that is present has an unknown version, never a guessed one", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-pack-"));
    mkdirSync(join(dir, "research-codebase"));
    writeFileSync(join(dir, "research-codebase", "SKILL.md"), "---\nname: research-codebase\n---\n");
    expect(devPackInventory(makeCtx(tempHome(), { env: { CATALYST_SKILLS_CLAUDE_DIR: dir } }), null)).toMatchObject({ state: "unknown", reason: "installation_owner_unknown", dir });
  });
});

describe("replicaInventory", () => {
  it("a running writer reports the CLI version it recorded; one that predates the record is unknown", async () => {
    const home = tempHome();
    const cfg = signIn(home);
    await seedReplica(home, { heartbeatAgeMs: 0 });
    seedWriterState(home, { version: OLD });
    expect(replicaInventory(makeCtx(home), cfg)).toMatchObject({ state: "running", version: OLD });
    seedWriterState(home, {});
    expect(replicaInventory(makeCtx(home), cfg)).toMatchObject({ state: "running", version: null });
  });

  it("a replica file with no live writer is stopped, and stays reported as stopped", async () => {
    const home = tempHome();
    const cfg = signIn(home);
    await seedReplica(home, {});
    expect(replicaInventory(makeCtx(home), cfg)).toMatchObject({ state: "stopped" });
  });
});

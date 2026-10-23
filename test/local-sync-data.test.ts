// local-sync-data.test.ts — the local sync inventory setup and `catalyst legacy` show before removal:
// which files it lists, which saved paths it refuses, and how removal treats a file that changed
// after the person said yes or a pid record that names a writer (CTC-6603).
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { configPathFor, defaultReplicaDbFor } from "../src/config";
import { findLocalSyncData, localSyncInventory, removeLocalSyncData, stopReplicaWriterForTest, type LocalSyncFile } from "../src/local-sync-data";
import { makeCtx, tempHome, type TestCtx } from "./helpers";

let ctx: TestCtx;

const put = (path: string, text = "") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const saveConfig = (value: unknown) => put(configPathFor(ctx.home), JSON.stringify(value));
const fileAt = (path: string): LocalSyncFile => {
  const stat = statSync(path);
  return { kind: "data", name: path, path, localSync: true, size: stat.size, dev: stat.dev, ino: stat.ino };
};
const paths = async () => (await findLocalSyncData(ctx)).map(file => file.path).sort();

beforeEach(() => {
  const home = tempHome();
  ctx = makeCtx(home, { env: { XDG_STATE_HOME: join(home, "xdg-state") } });
});

describe("finding local sync data", () => {
  it("lists the replica, its sidecars and the event cache segments, and nothing else in those folders", async () => {
    const db = defaultReplicaDbFor(ctx.home);
    put(db, "db");
    put(`${db}-wal`, "wal");
    put(`${db}.writer.lock`, JSON.stringify({ pid: 4242 }));
    const events = join(ctx.home, "xdg-state", "catalyst", "events");
    put(join(events, "2026-10-01.jsonl"), "{}\n");
    put(join(events, "cursor.json"), "{}");
    put(join(events, "notes.txt"), "someone else's");
    put(join(events, "acme", "backbone", "2026-10-02-001.jsonl"), "{}\n");
    put(join(events, "acme", "backbone", "keep.md"), "");
    put(join(events, "stray-file"), "");
    const extra = join(ctx.home, "extra-events");
    put(join(extra, ".sync.writer.lock"), "{}");
    ctx.env.CATALYST_EVENTS_DIR = extra;
    expect(await paths()).toEqual([
      db, `${db}-wal`, `${db}.writer.lock`,
      join(extra, ".sync.writer.lock"),
      join(events, "2026-10-01.jsonl"),
      join(events, "acme", "backbone", "2026-10-02-001.jsonl"),
      join(events, "cursor.json"),
    ].sort());
  });

  it("finds nothing on a machine with no replica and no event cache", async () => {
    expect(await findLocalSyncData(ctx)).toEqual([]);
  });

  it("reads a saved login that is not an object as no saved replica path", async () => {
    saveConfig(["not", "an", "object"]);
    put(defaultReplicaDbFor(ctx.home), "db");
    expect(await paths()).toEqual([defaultReplicaDbFor(ctx.home)]);
  });

  it("lists a replica saved at another absolute path", async () => {
    const elsewhere = join(ctx.home, "data", "replica.db");
    saveConfig({ replicaDb: elsewhere });
    put(elsewhere, "db");
    expect(await paths()).toEqual([elsewhere]);
  });

  it("refuses a saved replica path that is not absolute, keeping the data", async () => {
    saveConfig({ replicaDb: "relative/replica.db" });
    await expect(findLocalSyncData(ctx)).rejects.toMatchObject({ code: "local-sync-path-invalid" });
  });

  it("refuses a saved replica path that names the login or settings file", async () => {
    saveConfig({ replicaDb: join(ctx.home, "elsewhere", "customer.json") });
    await expect(findLocalSyncData(ctx)).rejects.toMatchObject({ code: "local-sync-path-protected" });
  });

  it("refuses a replica sidecar that is a folder rather than a file", async () => {
    mkdirSync(`${defaultReplicaDbFor(ctx.home)}-wal`, { recursive: true });
    await expect(findLocalSyncData(ctx)).rejects.toThrow("requires a regular file");
  });

  it("reads an event cache root that is a file as empty", async () => {
    put(join(ctx.home, "xdg-state", "catalyst", "events"), "not a folder");
    expect(await findLocalSyncData(ctx)).toEqual([]);
  });

  it("names each file with its size", () => {
    const path = join(ctx.home, "replica.db");
    put(path, "12345");
    expect(localSyncInventory([fileAt(path)])).toEqual([`${path} (5 bytes)`]);
  });
});

describe("removing local sync data", () => {
  it("stops each writer a pidfile or lock names once, then removes every approved file", async () => {
    const db = join(ctx.home, "replica.db");
    for (const [path, text] of [[db, "db"], [`${db}.pid`, "4242\n"], [`${db}.writer.lock`, JSON.stringify({ pid: 4242 })], [`${db}.writer.state`, "{}"]] as const) put(path, text);
    const files = [db, `${db}.pid`, `${db}.writer.lock`, `${db}.writer.state`].map(fileAt);
    const stopped: number[] = [];
    await removeLocalSyncData(files, async (pid) => { stopped.push(pid); });
    expect(stopped).toEqual([4242]);
    expect(await Promise.all(files.map(async f => { try { statSync(f.path); return true; } catch { return false; } }))).toEqual([false, false, false, false]);
  });

  it("sends no signal for a pid record that holds no usable pid", async () => {
    const db = join(ctx.home, "replica.db");
    put(`${db}.pid`, "not-a-pid");
    put(`${db}.writer.lock`, JSON.stringify({ pid: -3 }));
    const stopped: number[] = [];
    await removeLocalSyncData([fileAt(`${db}.pid`), fileAt(`${db}.writer.lock`)], async (pid) => { stopped.push(pid); });
    expect(stopped).toEqual([]);
  });

  it("skips an approved file that is already gone", async () => {
    const path = join(ctx.home, "replica.db");
    put(path, "db");
    const file = fileAt(path);
    rmSync(path);
    await expect(removeLocalSyncData([file], async () => {})).resolves.toBeUndefined();
  });

  it("keeps everything when a file was replaced after confirmation", async () => {
    const path = join(ctx.home, "replica.db");
    const other = join(ctx.home, "replica.db-wal");
    put(path, "db");
    put(other, "wal");
    const approved = [fileAt(path), fileAt(other)];
    // A folder now stands where the approved file was: a rename or a fresh file reads the same way.
    rmSync(path);
    mkdirSync(path);
    await expect(removeLocalSyncData(approved, async () => {})).rejects.toThrow("changed after confirmation");
    expect(statSync(other).size).toBe(3);
  });

  it("refuses to treat the cleanup process itself as a replica writer", async () => {
    await expect(stopReplicaWriterForTest(process.pid)).rejects.toThrow("refusing to stop the cleanup process");
  });
});

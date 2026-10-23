// watch-live-entry.test.ts — CTC-4508: `catalyst watch` is a cloud stream and needs no replica. The
// SDK's replica-bearing node entry is mocked to throw on import, so a watch that reaches for it fails
// here; the watch still prints an in-scope frame and advances its cursor.
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { WebSocketLike } from "@catalyst-cloud/sdk";
import { watchCursorPathFor } from "../src/config";
import { CliError } from "../src/errors";
import { loadLiveSdk, resetSdkCache } from "../src/sdk";
import { runWatch } from "../src/watch";
import { readCursorFile } from "../src/watch/cursor-file";
import { FIXTURE_ACCOUNT } from "./fixture-contract";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, waitFor } from "./helpers";

vi.mock("@catalyst-cloud/sdk/node", () => {
  throw new Error("the replica-bearing SDK entry was imported");
});

class FakeWs implements WebSocketLike {
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.({}));
  }
}

let server: FixtureServer;
let home: string;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  resetSdkCache();
  home = tempHome();
  server.headCursor = 10;
  await seedJoined(home, server);
});

test("watch streams frames with the replica-bearing SDK entry unloadable", async () => {
  await expect(import("@catalyst-cloud/sdk/node")).rejects.toThrow(/mocking a module/); // positive control: the node entry cannot load
  const ctx = makeCtx(home);
  const sockets: FakeWs[] = [];
  const urls: string[] = [];
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  const cfg = JSON.parse(readFileSync(`${home}/.config/catalyst-cloud/customer.json`, "utf8"));
  const done = runWatch(ctx, cfg, { scope: {} }, {
    wsFactory: (url) => {
      urls.push(url);
      const ws = new FakeWs();
      sockets.push(ws);
      return ws;
    },
    waitForStop: () => stopped,
    backoffMs: 5,
    maxBackoffMs: 10,
  });
  await waitFor(() => sockets.length === 1);
  expect(new URL(urls[0]!).searchParams.get("cli_version")).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  sockets[0]!.onopen?.({});
  await waitFor(() => sockets[0]!.sent.length === 1);
  sockets[0]!.onmessage?.({
    data: JSON.stringify({ type: "change", accountId: FIXTURE_ACCOUNT, seq: 11, entity: "issues", entityId: "lin-eng-1", op: "upsert", row: { id: "lin-eng-1", identifier: "ENG-1" } }),
  });
  await waitFor(() => readCursorFile(watchCursorPathFor(home))?.cursor === 11);
  expect(JSON.parse(ctx.out[0]!)).toMatchObject({ seq: 11, entity: "issues" });
  sockets[0]!.close();
  await waitFor(() => sockets.length === 2);
  expect(new URL(urls[1]!).searchParams.get("cli_version")).toBe(new URL(urls[0]!).searchParams.get("cli_version"));
  stop();
  expect(await done).toBe(0);
});

test("a live client that cannot load is sdk-unavailable, and the next call retries the import", async () => {
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("no such module");
  };
  const err = await loadLiveSdk(failing).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).code).toBe("sdk-unavailable");
  expect((err as CliError).message).toContain("no such module");
  await loadLiveSdk(failing).catch(() => undefined);
  expect(calls).toBe(2);
});

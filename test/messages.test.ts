// CTC-6650 — `messages read` prints the bodies behind comms.message.posted events.
import { beforeEach, describe, expect, test } from "vitest";
import type { MessagesReadParams, MessagesReadResult } from "@catalyst-cloud/sdk";
import { main } from "../src/cli";
import { readManifest, writeConfig, type CustomerConfig } from "../src/config";
import { makeCtx, tempHome, type TestCtx } from "./helpers";

let ctx: TestCtx;
beforeEach(() => {
  const home = tempHome();
  ctx = makeCtx(home);
  const config: CustomerConfig = { baseUrl: "https://cloud.example", key: "ctc_user_self", account: "workspace-1", slug: "acme", name: "Acme", permissions: ["mirror:read"], principal: "service", user: { id: "self", label: "Self", email: null, role: "member", linearUserId: null }, joinedAt: "2026-10-23T00:00:00Z", lastSkillBundleVersion: readManifest().version };
  writeConfig(home, config);
});

function fake(result: MessagesReadResult) {
  const calls: MessagesReadParams[] = [];
  const client = { messages: { read: async (params: MessagesReadParams) => { calls.push(params); return result; } } };
  return { calls, client };
}
const ok: MessagesReadResult = {
  outcome: "ok",
  status: 200,
  ticket: "CTC-1234",
  messages: [
    { id: "m1", seq: 5003, kind: "note", body: "rebased on main\nconflicts cleared", from: { kind: "agent", id: "seat-1", label: "Seat 1" }, sentAt: "2026-10-23T09:00:00.000Z" },
  ],
  next: 5004,
};

describe("messages read", () => {
  test("prints each message's sequence, time, sender and body, and the next page", async () => {
    const f = fake(ok);
    expect(await main(["messages", "read", "--ticket", "ctc-1234", "--since", "5003"], ctx, { messages: { createClient: () => f.client } })).toBe(0);
    expect(f.calls).toEqual([{ ticket: "CTC-1234", since: 5003 }]);
    expect(ctx.out).toEqual(["#5003 2026-10-23T09:00:00.000Z Seat 1 (note)", "  rebased on main", "  conflicts cleared"]);
    expect(ctx.err).toEqual(["more: re-run with --since 5004"]);
  });

  test("--json prints the ticket, messages and next cursor", async () => {
    const f = fake({ ...ok, next: null });
    expect(await main(["messages", "read", "--ticket", "CTC-1234", "--json"], ctx, { messages: { createClient: () => f.client } })).toBe(0);
    expect(f.calls).toEqual([{ ticket: "CTC-1234" }]);
    expect(JSON.parse(ctx.out.join(""))).toEqual({ ticket: "CTC-1234", messages: ok.messages, next: null });
  });

  test("a server without the read route exits 1 and says so", async () => {
    const f = fake({ outcome: "unsupported", status: 404, reason: "this server does not offer message reads" });
    expect(await main(["messages", "read", "--ticket", "CTC-1234"], ctx, { messages: { createClient: () => f.client } })).toBe(1);
    expect(ctx.err.join("\n")).toContain("messages: unsupported (404): this server does not offer message reads");
  });

  test("a missing ticket or a bad --since is a usage error before any request", async () => {
    const f = fake(ok);
    expect(await main(["messages", "read"], ctx, { messages: { createClient: () => f.client } })).toBe(1);
    expect(await main(["messages", "read", "--ticket", "CTC-1", "--since", "-1"], ctx, { messages: { createClient: () => f.client } })).toBe(1);
    expect(await main(["messages", "list", "--ticket", "CTC-1"], ctx, { messages: { createClient: () => f.client } })).toBe(1);
    expect(f.calls).toEqual([]);
  });
});

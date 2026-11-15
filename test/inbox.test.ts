import {describe, expect, it} from "vitest";
import {main} from "../src/cli";
import {writeConfig, readManifest} from "../src/config";
import {makeCtx, tempHome} from "./helpers";
function fixture(reply: object, status = 200) {
  const calls: Array<{path: string; body: unknown; auth: string | null}> = [];
  const ctx = makeCtx(tempHome(), {fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization")});
    return Response.json(reply, {status});
  }) as typeof fetch});
  writeConfig(ctx.home, {baseUrl: "https://cloud.example", key: "ctc_user_self", account: "a", slug: "a", name: "A", permissions: ["mirror:read", "mirror:write"], principal: "service", joinedAt: "2026-11-15", lastSkillBundleVersion: readManifest().version});
  return {ctx, calls};
}
describe("inbox", () => {
  it.each([[], ["unknown"]])("prints inbox usage for invalid syntax %j", async (...subcommand) => {
    const {ctx, calls} = fixture({});
    expect(await main(["inbox", ...subcommand], ctx)).toBe(1);
    const error = ctx.err.join("\n");
    expect(error).toContain("Usage: catalyst inbox <check --ticket CTC-N --agent NAME");
    expect(error).toContain("ack --ticket CTC-N --agent NAME --session ID --message ID --turn N");
    expect(calls).toHaveLength(0);
  });
  it("checks pending mail and prints its session without acknowledging", async () => {
    const {ctx, calls} = fixture({session: "ses_1", messages: [{id: "msg_1", body: "please rebase", from: {label: "Ryan"}}]});
    expect(await main(["inbox", "check", "--ticket", "ctc-900", "--agent", "seat-a"], ctx)).toBe(0);
    expect(calls).toEqual([{path: "/api/v1/agent/inbox/check", body: {ticket: "CTC-900", agent: "seat-a"}, auth: "Bearer ctc_user_self"}]);
    expect(ctx.out.join("\n")).toContain("ses_1");
    expect(ctx.out.join("\n")).toContain("please rebase");
  });
  it("prints the send disposition", async () => {
    const {ctx, calls} = fixture({outcome: "accepted", messageId: "msg_1", delivery: "next-turn"}, 201);
    expect(await main(["inbox", "send", "--ticket", "CTC-901", "--body", "hello", "--session", "ses_1"], ctx)).toBe(0);
    expect(calls[0]?.body).toEqual({ticket: "CTC-901", body: "hello", kind: "note", to: {session: "ses_1"}});
    expect(ctx.out.join("\n")).toContain("next-turn");
  });
  it("acknowledges explicitly and prints JSON", async () => {
    const {ctx, calls} = fixture({delivered: ["msg_1"], ignored: []});
    expect(await main(["inbox", "ack", "--ticket", "CTC-900", "--agent", "seat-a", "--session", "ses_1", "--message", "msg_1", "--turn", "2", "--json"], ctx)).toBe(0);
    expect(calls[0]?.body).toEqual({ticket: "CTC-900", agent: "seat-a", session: "ses_1", delivered: [{messageId: "msg_1", turn: 2}]});
    expect(JSON.parse(ctx.out[0]!)).toEqual({delivered: ["msg_1"], ignored: []});
  });
  it("reports refusal and rejects malformed acknowledgement before transport", async () => {
    const {ctx, calls} = fixture({refusal: "not_holder"}, 409);
    expect(await main(["inbox", "check", "--ticket", "CTC-900", "--agent", "seat-a"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("not_holder");
    expect(await main(["inbox", "ack", "--ticket", "CTC-900", "--agent", "seat-a", "--session", "ses_1", "--message", "msg_1", "--turn", "0"], ctx)).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

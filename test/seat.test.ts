import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/args";
import { cmdSeat } from "../src/seat";
import { makeCtx, tempHome } from "./helpers";

describe("seat checkout", () => {
  test("sends a providerless sized draw and prints its credential envelope with a session id", async () => {
    const home = tempHome();
    const ctx = makeCtx(home);
    ctx.env.CATALYST_CLOUD_WORKSTATION_TOKEN = "workstation-key";
    ctx.env.CATALYST_CLOUD_BASE_URL = "https://cloud.example.test";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    ctx.fetch = async (input, init) => {
      calls.push({ url: String(input), init: init! });
      return Response.json({ outcome: "issued", provider: "claude", model: "opus", credential: { setupToken: "secret" } });
    };
    const args = parseArgs(["seat", "checkout", "--size", "big", "--harness", "claude,codex", "--session-id", "seat-1", "--key-env", "CATALYST_CLOUD_WORKSTATION_TOKEN"]);
    expect(await cmdSeat(args, ctx)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/agent/credential-checkout");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ sessionId: "seat-1", size: "big", harnesses: ["claude", "codex"] });
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer workstation-key");
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ provider: "claude", model: "opus", sessionId: "seat-1" });
  });

  test("rejects a missing harness before any request", async () => {
    const ctx = makeCtx(tempHome());
    await expect(cmdSeat(parseArgs(["seat", "checkout", "--size", "big"]), ctx)).rejects.toThrow(/harness/);
  });
});

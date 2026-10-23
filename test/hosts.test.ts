import { beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { readManifest, writeConfig } from "../src/config";
import { makeCtx, tempHome, type TestCtx } from "./helpers";
const inventory = {
  account: "acme",
  readAtMs: 1800000000000,
  machines: [
    {
      id: "host_1",
      name: "studio-mac",
      ownership: "self_hosted",
      teams: ["ENG"],
      slots: 4,
      inUse: 1,
      free: 3,
      lastCheckInAtMs: 1800000000000,
      status: "live",
      removable: true,
      renameable: true,
    },
  ],
  capacity: {
    slots: 4,
    inUse: 1,
    free: 3,
    selfHostedSlots: 4,
    catalystSlots: 0,
  },
};
let ctx: TestCtx;
let calls: { url: string; method: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  ctx = makeCtx(tempHome(), {
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer ctc_user_member",
      );
      if (method === "GET") return Response.json(inventory);
      return Response.json({
        ok: true,
        hostId: "host_1",
        ...(method === "POST" ? { name: "studio-mac-2" } : {}),
      });
    },
  });
  writeConfig(ctx.home, {
    baseUrl: "https://cloud.example",
    key: "ctc_user_member",
    account: "acme",
    slug: "acme",
    name: "Acme",
    permissions: ["mirror:read"],
    principal: "service",
    joinedAt: "2026-10-08T00:00:00Z",
    lastSkillBundleVersion: readManifest().version,
  });
});
describe("hosts", () => {
  it("reads rows and totals in text and JSON, using the connected account", async () => {
    expect(await main(["hosts"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain(
      "studio-mac | Self-hosted | ENG | 4 slots, 1 in use, 3 free | live",
    );
    expect(ctx.out.join("\n")).toContain("4 self-hosted, 0 from Catalyst");
    ctx.out.length = 0;
    expect(await main(["hosts", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join(""))).toEqual(inventory);
    expect(calls[0]?.url).toBe(
      "https://cloud.example/api/v1/hosts/machines?account=acme",
    );
  });
  it("confirmation refusal leaves the machine enrolled", async () => {
    expect(
      await main(["hosts", "remove", "studio-mac"], ctx, {
        hosts: { confirm: async () => false },
      }),
    ).toBe(2);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
  it("removes by the stable ID after explicit consent and renames by name", async () => {
    expect(await main(["hosts", "remove", "studio-mac", "--yes"], ctx)).toBe(0);
    expect(calls[1]).toMatchObject({
      url: "https://cloud.example/api/v1/hosts/host_1?account=acme",
      method: "DELETE",
    });
    expect(await main(["hosts", "rename", "host_1", "studio-mac-2"], ctx)).toBe(
      0,
    );
    expect(calls[3]).toMatchObject({
      url: "https://cloud.example/api/v1/hosts/host_1/name?account=acme",
      method: "POST",
      body: { name: "studio-mac-2" },
    });
  });
  it("a cloud permission refusal says admin access is required", async () => {
    const good = ctx.fetch;
    ctx.fetch = async (input, init) =>
      init?.method === "DELETE"
        ? Response.json({ error: "admin_required" }, { status: 403 })
        : good(input, init);
    expect(await main(["hosts", "remove", "studio-mac", "--yes"], ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain("Admin access is required");
  });
  it("refuses a malformed response rather than reporting no machines", async () => {
    ctx.fetch = async () => Response.json({ machines: [] });
    expect(await main(["hosts", "--json"], ctx)).toBe(2);
    expect(ctx.out).toEqual([]);
  });
});

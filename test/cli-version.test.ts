import { describe, expect, test } from "vitest";
import { reportCliVersion } from "../src/cli-version";
import { main } from "../src/cli";
import { makeCtx, tempHome } from "./helpers";
import { readManifest } from "../src/config";
import { startMeFixture, FIXTURE_USER_KEY } from "./fixture";

const origin = "https://staging.catalystcloud.dev";

describe("installed CLI release reporting", () => {
  test("the real CLI entry sends its actual installed manifest version through an injected login transport", async () => {
    const server = await startMeFixture();
    try {
      const calls: Array<{url:string;headers:Headers}> = [];
      const ctx = makeCtx(tempHome(), {fetch: async (input,init) => {
        calls.push({url:String(input),headers:new Headers(init?.headers)});
        return fetch(input, init);
      }});
      expect(await main(["login", "--key", FIXTURE_USER_KEY, "--base-url", server.url], ctx)).toBe(0);
      const me = calls.find(call => new URL(call.url).pathname === "/api/v1/me");
      expect(me).toBeDefined();
      expect(me?.headers.get("x-catalyst-cli-version")).toBe(readManifest().version);
      expect(me?.headers.get("authorization")).toBe(`Bearer ${FIXTURE_USER_KEY}`);
    } finally { await server.close(); }
  });
  test("reports the package release while retaining authorization and legal PUT transport", async () => {
    const calls: Array<{ input: unknown; init?: RequestInit }> = [];
    const response = new Response("{}");
    const transport: typeof fetch = async (input, init) => { calls.push({ input, init }); return response; };
    const signal = new AbortController().signal;
    const send = reportCliVersion(transport, "0.15.0", () => [origin]);
    const body = '{"agents":[]}';
    expect(await send(`${origin}/api/v1/review-agents/write`, {
      method: "PUT", body, signal, redirect: "error", credentials: "omit",
      headers: { authorization: "Bearer fixture", "x-catalyst-cli-version": "forged" },
    })).toBe(response);
    expect(calls).toHaveLength(1);
    expect(calls[0].init).toMatchObject({ method: "PUT", body, signal, redirect: "error", credentials: "omit" });
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture");
    expect(headers.get("x-catalyst-cli-version")).toBe("0.15.0");
    expect(headers.get("x-catalyst-client")).toBeNull();
    expect(headers.get("user-agent")).toBeNull();
  });
  test("supports URL and Request inputs without consuming a request body or changing native redirect policy", async () => {
    const captured: Array<{ input: unknown; init?: RequestInit }> = [];
    const transport: typeof fetch = async (input, init) => { captured.push({ input, init }); return new Response("{}"); };
    const send = reportCliVersion(transport, "0.15.0", () => [origin]);
    await send(new URL(`${origin}/api/v1/me`), {headers: [["authorization", "Bearer first"]]});
    const request = new Request(`${origin}/api/v1/review-agents/write`, {method:"PUT",body:"payload",headers:{authorization:"Bearer request"}});
    await send(request);
    expect(request.bodyUsed).toBe(false);
    expect(captured[1].input).toBe(request);
    expect(captured[1].init?.redirect).toBeUndefined();
    expect(new Headers(captured[1].init?.headers).get("authorization")).toBe("Bearer request");
    await send(request, {headers: new Headers({authorization:"Bearer override"})});
    expect(new Headers(captured[2].init?.headers).get("authorization")).toBe("Bearer override");
  });
  test("does not decorate unrelated initial destinations, provider calls or malformed release values", async () => {
    const captured: RequestInit[] = [];
    const transport: typeof fetch = async (_input, init) => { captured.push(init ?? {}); return new Response("{}"); };
    const init = {headers: {authorization:"Bearer fixture"}};
    const send = reportCliVersion(transport, "0.15.0", () => [origin]);
    for (const url of ["https://api.workos.com/api/v1/token", "https://registry.npmjs.org/api/v1/pkg", `${origin}/oauth/token`]) await send(url, init);
    await reportCliVersion(transport, "unknown", () => [origin])(`${origin}/api/v1/me`, init);
    expect(captured).toHaveLength(4);
    for (const actual of captured) expect(actual).toBe(init);
  });
});

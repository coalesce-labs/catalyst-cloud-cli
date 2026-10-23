import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { main } from "../src/cli";
import { configPathFor, type MeUser } from "../src/config";
import { makeCtx, tempHome, type TestCtx } from "./helpers";

// Planning fixture, not a captured /me response: paths come from CTC-4357;
// the envelope and projects follow test/onboard-repositories-team.test.ts's agent list.
// Pause attribution follows the { actor, email } shape reported by PR #454's review.
type Body = Record<string, unknown>;
type Request = { method: string; path: string; body: unknown; authorization: string | null };
const now = Date.parse("2026-09-29T15:00:00Z");
const personalKey = "ctc_user_repository_fixture";
const project = { id: "project-app", name: "Application", teamKey: "APP", status: "active" };
const row = (over: Body = {}): Body => ({
  id: "repo-app", owner: "acme", name: "app", fullName: "acme/app", status: "paused",
  pausedAt: "2026-09-29T12:00:00Z", pausedBy: { actor: "person-sam", email: "sam@example.com" },
  pauseReason: "flaky deploy", projects: [project], ...over,
});
const list = (repositories: Body[] = [row()], canManage = false): Body => ({ repositories, canManage });
let home: string;
let ctx: TestCtx;
let requests: Request[];
let respond: (request: Request, index: number) => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function login(role?: MeUser["role"]): void {
  const path = configPathFor(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    baseUrl: "https://cloud.example", key: personalKey, account: "account-fixture",
    slug: "fixture", name: "Fixture", permissions: [], principal: "session",
    joinedAt: "2026-09-01T00:00:00Z",
    ...(role ? { user: { id: "person", label: "Person", email: null, role, linearUserId: null } } : {}),
  }));
}
beforeEach(() => {
  home = tempHome();
  login("member");
  requests = [];
  respond = () => json(list());
  ctx = makeCtx(home, {
    now: () => new Date(now),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const request: Request = {
        method: init?.method ?? "GET", path: url.pathname + url.search,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        authorization: new Headers(init?.headers).get("authorization"),
      };
      requests.push(request);
      return respond(request, requests.length - 1);
    },
  });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("repo status", () => {
  test("lists every visible state and projects with the personal bearer and no cached contract", async () => {
    respond = () => json(list([
      row(), row({ id: "repo-api", name: "api", fullName: "acme/api", status: "active" }),
      row({ id: "repo-legacy", name: "legacy", fullName: "acme/legacy", pausedAt: null, pausedBy: null, pauseReason: null, projects: [] }),
      row({ id: "repo-retired", name: "retired", fullName: "acme/retired", status: "archived", projects: [{ id: "project-old", name: "Legacy", teamKey: "OLD" }] }),
    ]));
    expect(await main(["repo", "status"], ctx)).toBe(0);
    expect(requests).toEqual([{ method: "GET", path: "/api/v1/me/repos", body: null, authorization: `Bearer ${personalKey}` }]);
    expect(ctx.out).toEqual([
      "acme/app: paused by sam@example.com 3 hours ago: flaky deploy", "  projects: Application (APP)",
      "acme/api: active", "  projects: Application (APP)",
      "acme/legacy: paused by an operator", "  projects: none",
      "acme/retired: archived", "  projects: Legacy (OLD)",
      "Pause or resume requires a workspace owner or admin; your role is member.",
    ]);
  });
  test("passes through the whole JSON envelope and unknown fields without guidance", async () => {
    const body = { ...list([row({ futureField: { value: 3 } })]), futureEnvelope: "kept" };
    respond = () => json(body);
    expect(await main(["repo", "status", "--json"], ctx)).toBe(0);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out.join("\n"))).toEqual(body);
  });
  test("empty list describes visibility, not workspace registration", async () => {
    respond = () => json(list([]));
    expect(await main(["repo", "status"], ctx)).toBe(0);
    expect(ctx.out[0]).toBe("No repositories are visible to your login.");
  });
  test.each([true, false])("fresh canManage=%s controls guidance without inventing a role", async (canManage) => {
    login();
    respond = () => json(list([], canManage));
    expect(await main(["repo", "status"], ctx)).toBe(0);
    expect(ctx.out[1]).toBe(canManage
      ? "You can pause or resume repositories as a workspace owner or admin."
      : "Pause or resume requires a workspace owner or admin.");
  });
  test.each([
    [0, "just now"], [59_999, "just now"], [60_000, "1 minute ago"], [120_000, "2 minutes ago"],
    [3_599_999, "59 minutes ago"], [3_600_000, "1 hour ago"], [7_200_000, "2 hours ago"],
    [86_399_999, "23 hours ago"], [86_400_000, "1 day ago"], [172_800_000, "2 days ago"], [-60_000, "just now"],
  ])("renders elapsed %s milliseconds as %s", async (elapsed, text) => {
    respond = () => json(list([row({ pausedAt: now - elapsed })]));
    expect(await main(["repo", "status"], ctx)).toBe(0);
    expect(ctx.out[0]).toBe(`acme/app: paused by sam@example.com ${text}: flaky deploy`);
  });
  test.each(["bad-date", null, 1e20])("omits invalid or absent date %s", async (pausedAt) => {
    respond = () => json(list([row({ pausedAt })]));
    expect(await main(["repo", "status"], ctx)).toBe(0);
    expect(ctx.out[0]).toBe("acme/app: paused by sam@example.com: flaky deploy");
  });
  test.each([
    { pausedBy: { actor: "person-sam", email: "sam@example.com", name: "Legacy name" }, display: "sam@example.com" },
    { pausedBy: { actor: "person-sam", email: null }, display: "person-sam" },
    { pausedBy: { actor: "person-sam", email: " " }, display: "person-sam" },
  ])("renders pause attribution as $display using email before actor", async ({ pausedBy, display }) => {
    respond = () => json(list([row({ pausedBy })]));
    expect(await main(["repo", "status"], ctx)).toBe(0);
    expect(ctx.out[0]).toBe(`acme/app: paused by ${display} 3 hours ago: flaky deploy`);
  });
  test.each([["Sam", "Sam"], [{ name: "Sam Example" }, "Sam Example"], [{ label: "Sam Label" }, "Sam Label"], [{ id: "person" }, "an operator"], [{ name: " " }, "an operator"], [undefined, "an operator"]])("accepts legacy actor %j", async (pausedBy, display) => {
    respond = () => json(list([row({ pausedBy, pausedAt: undefined, pauseReason: undefined })]));
    expect(await main(["repo", "status"], ctx)).toBe(0);
    expect(ctx.out[0]).toBe(`acme/app: paused by ${display}`);
  });
  test.each([true, false])("reports a missing GET route with JSON=%s", async (isJson) => {
    respond = () => isJson ? json({ error: "missing", detail: "retained" }, 404) : new Response("Not Found", { status: 404 });
    expect(await main(["repo", "status"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toContain("refused (404): this Catalyst Cloud does not serve repository status yet (needs a newer cloud)");
  });
  test("GET 403 reports read access, retaining server fields in JSON", async () => {
    respond = () => json({ error: "forbidden", code: "acl", message: "No repository access", detail: 3 }, 403);
    expect(await main(["repo", "status", "--json"], ctx)).toBe(1);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ status: 403, error: "forbidden", code: "acl", detail: 3, message: expect.stringContaining("No repository access") });
    expect(ctx.out.join("\n")).not.toContain("requires a workspace owner or admin");
  });
  test.each([{}, { repositories: {} }, { repositories: [], canManage: "false" }, list([row({ id: "" })]), list([row({ owner: null })]), list([row({ name: 3 })]), list([row({ status: undefined })])])("rejects malformed success %j", async (body) => {
    respond = () => json(body);
    expect(await main(["repo", "status"], ctx)).toBe(2);
    expect(ctx.out).toEqual([]);
    expect(ctx.err.join("\n")).toContain("unexpected repository list shape");
  });
  test.each([["extra"], ["--reason", "because"], ["--write"], ["--apply"], ["--with-check"]].map((extra) => ({ extra })))("rejects status arguments $extra before requests", async ({ extra }) => {
    rmSync(configPathFor(home));
    expect(await main(["repo", "status", ...extra], ctx)).toBe(1);
    expect(requests).toEqual([]);
  });
});

describe("repo pause and resume", () => {
  function mutationFixture(before: Body = row(), after: Body = row({ status: "active", futureField: 42 })): void {
    respond = (request, index) => request.method === "POST" ? json({ acknowledged: true }) : json(list([index === 0 ? before : after], true));
  }
  test.each([
    { role: "owner", action: "pause", reason: "  flaky deploy  ", status: "paused" },
    { role: "admin", action: "resume", reason: "  deploy fixed  ", status: "active" },
    { role: "owner", action: "resume", reason: undefined, status: "active" },
  ] satisfies { role: MeUser["role"]; action: string; reason: string | undefined; status: string }[])("$role can $action using GET, POST, GET with the person's bearer", async ({ role, action, reason, status }) => {
    login(role);
    const id = "repo/opaque ?#";
    mutationFixture(row({ id }), row({ id, status, pausedAt: now }));
    expect(await main(["repo", action, "ACME/App", ...(reason === undefined ? [] : ["--reason", reason])], ctx)).toBe(0);
    expect(requests).toEqual([
      { method: "GET", path: "/api/v1/me/repos", body: null, authorization: `Bearer ${personalKey}` },
      { method: "POST", path: `/api/v1/me/repos/${encodeURIComponent(id)}/${action}`, body: reason === undefined ? {} : { reason: reason.trim() }, authorization: `Bearer ${personalKey}` },
      { method: "GET", path: "/api/v1/me/repos", body: null, authorization: `Bearer ${personalKey}` },
    ]);
    expect(ctx.out).toEqual([status === "paused" ? "acme/app: paused by sam@example.com just now: flaky deploy" : "acme/app: active", "  projects: Application (APP)"]);
  });
  test.each(["pause", "resume"])("%s accepts exactly 500 trimmed characters", async (action) => {
    mutationFixture();
    expect(await main(["repo", action, "acme/app", "--reason", ` ${"x".repeat(500)} `], ctx)).toBe(0);
    expect(requests[1]?.body).toEqual({ reason: "x".repeat(500) });
  });
  test.each(["pause", "resume"].flatMap((action) => [" ", "x".repeat(501), ""].map((reason) => ({ action, reason }))))("$action rejects invalid reason before authentication", async ({ action, reason }) => {
    rmSync(configPathFor(home));
    expect(await main(["repo", action, "acme/app", `--reason=${reason}`], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("--reason must contain 1 to 500 characters after trimming");
    expect(requests).toEqual([]);
  });
  test("pause requires a reason before authentication", async () => {
    rmSync(configPathFor(home));
    expect(await main(["repo", "pause", "acme/app"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("repo pause needs --reason with 1 to 500 characters");
    expect(requests).toEqual([]);
  });
  test.each([
    ["resume"], ["resume", "app"], ["resume", "https://github.com/acme/app"], ["resume", "acme/app/extra"],
    ["resume", "acme/app", "extra"], ["resume", "acme/app", "--write"], ["resume", "acme/app", "--apply"],
    ["pause", "acme/app", "--reason=x", "--with-check"],
    ["agents-block", "/missing", "--reason=x"], ["agent-setup", "/missing", "--reason=x"],
  ].map((argv) => ({ argv })))("rejects invalid arguments $argv without authentication", async ({ argv }) => {
    rmSync(configPathFor(home));
    expect(await main(["repo", ...argv], ctx)).toBe(1);
    expect(requests).toEqual([]);
    if (argv[0] === "agents-block" || argv[0] === "agent-setup") expect(ctx.err.join("\n")).toContain("--reason belongs to repo pause or resume");
  });
  test("an invisible repository sends no POST", async () => {
    respond = () => json(list([], true));
    expect(await main(["repo", "resume", "acme/missing", "--json"], ctx)).toBe(1);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ error: "repository-not-visible", message: "no repository acme/missing is visible to your login; check catalyst repo status" });
  });
  test("ambiguous case-insensitive matches send no POST", async () => {
    respond = () => json(list([row(), row({ id: "other", owner: "ACME", name: "APP" })], true));
    expect(await main(["repo", "resume", "acme/app"], ctx)).toBe(1);
    expect(requests).toHaveLength(1);
    expect(ctx.out.join("\n")).toContain("ambiguous");
  });
  test.each(["member", "admin"] satisfies MeUser["role"][])("fresh canManage refuses a locally known %s", async (role) => {
    login(role);
    expect(await main(["repo", "pause", "acme/app", "--reason", "flaky deploy", "--json"], ctx)).toBe(1);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ error: "forbidden", status: 403, message: `pausing or resuming a repository requires a workspace owner or admin; your role is ${role}` });
  });
  test("local archived refusal sends no POST", async () => {
    respond = () => json(list([row({ status: "archived" })], true));
    expect(await main(["repo", "resume", "acme/app"], ctx)).toBe(1);
    expect(ctx.out).toEqual(["refused (409): acme/app is archived and cannot be paused or resumed"]);
    expect(requests).toHaveLength(1);
  });
  test.each([
    { status: 403, body: { error: "permission-changed" }, message: "requires a workspace owner or admin" },
    { status: 409, body: { message: "Repository is archived" }, message: "archived" },
    { status: 400, body: { code: "invalid-input", message: "reason refused", extra: true }, message: "reason refused" },
    { status: 404, body: { message: "Repository not found", code: "custom-resource-code" }, message: "acme/app" },
    { status: 404, body: { message: "Route not found" }, message: "newer cloud" },
    { status: 404, body: {}, message: "repository or this route is no longer available" },
  ])("preserves POST $status refusal and gives useful context", async ({ status, body, message }) => {
    respond = (request) => request.method === "POST" ? json(body, status) : json(list([row()], true));
    expect(await main(["repo", "resume", "acme/app", "--json"], ctx)).toBe(1);
    expect(requests).toHaveLength(2);
    const output = JSON.parse(ctx.out.join("\n"));
    expect(output).toMatchObject({ ...body, status, message: expect.stringContaining(message) });
    expect(ctx.out).toHaveLength(1);
  });
  test("prints the freshly observed row, even when another admin has paused it again", async () => {
    const after = row({ status: "paused", pauseReason: "concurrent pause", unknownField: { kept: true } });
    mutationFixture(row(), after);
    expect(await main(["repo", "resume", "acme/app", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toEqual(after);
  });
  test.each(["http", "malformed", "missing", "network", "invalid-json"])("reports the completed write once when verification fails: %s", async (failure) => {
    respond = (request, index) => {
      if (request.method === "POST") return json({ ok: true });
      if (index === 0) return json(list([row()], true));
      if (failure === "network") throw new Error("connection lost");
      if (failure === "invalid-json") return new Response("not JSON");
      if (failure === "http") return json({ error: "unavailable" }, 503);
      return json(failure === "missing" ? list([], true) : { repositories: null });
    };
    expect(await main(["repo", "resume", "acme/app", "--json"], ctx)).toBe(1);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ error: "repository-status-unavailable", writeSucceeded: true, repoId: "repo-app", message: expect.stringContaining("write succeeded") });
  });
  test.each([401, 429])("preserves transport handling of HTTP %s without retrying", async (status) => {
    respond = () => json({ error: "refused" }, status);
    expect(await main(["repo", "resume", "acme/app"], ctx)).toBe(2);
    expect(requests).toHaveLength(1);
    expect(ctx.err.join("\n")).toContain(String(status));
  });
});

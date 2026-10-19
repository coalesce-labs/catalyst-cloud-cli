// execution.test.ts — explain renders the offered row, the excluded row's reason phrase and failure
// block, and the raw string for an unknown reason; --history and accounts print the not-visible line
// with the settings URL and exit 0; running and queue print the fixture rows.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { CliError, MeError } from "../src/errors";
import { EXCLUSION_REASONS, UNKNOWN_REASONS, describeReason, gateFromContract, liveReadMayFallBack, renderExplain } from "../src/execution";
import { fixtureIssues, startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, seedTeamGate, tempHome, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  home = tempHome();
  ctx = makeCtx(home);
  server.requests.length = 0;
  await seedJoined(home, server);
});

describe("explain", () => {
  test("passes the team and the contract's ladder as capabilities", async () => {
    expect(await main(["explain", "ENG-1"], ctx)).toBe(0);
    const req = server.requests.find((r) => r.path.startsWith("/api/v1/work-eligibility"));
    expect(req?.path).toContain("team=ENG");
    expect(decodeURIComponent(req!.path)).toContain("capabilities=intake,research,plan,implement,validate,pr,remediate,merge");
  });
  test("renders the offered row", async () => {
    expect(await main(["explain", "ENG-1"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toBe("ENG-1 is offered (position 1) for phase research.");
  });
  test("renders the excluded row's reason phrase, failure block and advisory", async () => {
    expect(await main(["explain", "eng-2"], ctx)).toBe(0);
    const text = ctx.out.join("\n");
    expect(text).toContain("eng-2 is excluded (position 2): the failed phase is retrying in place and waiting out its backoff.");
    expect(text).toContain("Last failure: phase=implement, class=vendor_5xx, attempts=2, lastFailedAt=1756099000000.");
    expect(text).toContain("Advisories: assigned to a human with no delegate: this may be an unlabelled ask.");
  });
  test("prints the raw string for an unknown reason, never nothing", async () => {
    expect(await main(["explain", "ENG-3", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as { explanation: string; row: { reason: string } };
    expect(j.row.reason).toBe("frobnicate_pending");
    expect(j.explanation).toContain('reason "frobnicate_pending" (not in this bundle\'s table');
  });
  test("a ticket absent from the explainer says so", async () => {
    expect(await main(["explain", "ENG-99"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toMatch(/ENG-99: not in the ENG eligibility explainer/);
  });
  test("a Backlog ticket with no dispatch row is named as known, not unknown", async () => {
    // ENG-7 is in the mirror but not in the eligibility rows (ENG-1/2/3): a null dispatch row is not
    // proof of non-existence, so `explain` probes /api/v1/issues/:id and names the non-dispatch state.
    server.issues = fixtureIssues().map((i) => (i.identifier === "ENG-7" ? { ...i, state: "Backlog" } : i));
    expect(await main(["explain", "ENG-7"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toBe("ENG-7: known to the mirror; state Backlog is not a dispatch state.");
  });
  test("a ticket the mirror 404s on keeps the unknown wording", async () => {
    expect(await main(["explain", "ENG-404"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toBe("ENG-404: not in the ENG eligibility explainer — the ticket is unknown to the mirror, terminal, or on another team.");
  });
  test("a lowercase id is normalized before the mirror probe, so an existing Backlog ticket is not mislabeled unknown", async () => {
    // The mirror compares identifiers exactly (uppercase), so the probe must normalize the id the same
    // way the eligibility-row lookup does — otherwise `explain eng-7` reports an existing ENG-7 unknown.
    server.issues = fixtureIssues().map((i) => (i.identifier === "ENG-7" ? { ...i, state: "Backlog" } : i));
    expect(await main(["explain", "eng-7"], ctx)).toBe(0);
    const text = ctx.out.join("\n");
    expect(text).toContain("known to the mirror; state Backlog is not a dispatch state");
    expect(text).not.toContain("unknown");
  });
  // A team with no saved stage mapping gets no dispatch queue at all, so no ticket has a row — and the
  // Todo probe used to answer "state Todo is not a dispatch state", which sent a customer's agent off
  // to blame git automation. The cloud now sends the team's dispatch gate; explain leads with it.
  test("an unmapped team's explain names the missing stage mapping and the screen, never 'not a dispatch state'", async () => {
    server.eligibilityByTeam.HAG = {
      team: "HAG",
      eligibility: {
        queue: null,
        verdict: "unavailable",
        unavailable: { reason: "ordering_never_published" },
        rows: [],
        dispatchGate: {
          cause: "mapping_missing",
          missingSlots: ["dispatch", "pr", "done", "canceled"],
          remedy: "A tenant admin opens Settings → Linear teams → HAG and presses Map my stages (or Adopt the Catalyst workflow) to give dispatch, pr, done, canceled a stage. Until then Catalyst starts nothing in HAG; git automation is not involved.",
        },
      },
    };
    server.issues = [...fixtureIssues(), { ...fixtureIssues()[0], identifier: "HAG-30", state: "Todo" }];
    try {
      expect(await main(["explain", "HAG-30"], ctx)).toBe(0);
      const text = ctx.out.join("\n");
      expect(text).toContain("HAG-30 cannot start: team HAG has no saved stage mapping for dispatch, pr, done, canceled.");
      expect(text).toContain("Map my stages");
      expect(text).not.toContain("not a dispatch state");

      expect(await main(["explain", "HAG-30", "--json"], ctx)).toBe(0);
      const j = JSON.parse(ctx.out[ctx.out.length - 1]!) as { dispatchGate?: { cause: string } };
      expect(j.dispatchGate?.cause).toBe("mapping_missing");
    } finally {
      delete server.eligibilityByTeam.HAG;
      server.issues = fixtureIssues();
    }
  });
  // Codex P2: the gate is team-wide, so it cannot prove THIS ticket exists — a mistyped id on an
  // unmapped team must keep the mirror's 404 wording rather than inherit the team's mapping verdict.
  test("an id the mirror 404s on keeps the unknown wording even when its team's gate is shut", async () => {
    server.eligibilityByTeam.HAG = {
      team: "HAG",
      eligibility: {
        rows: [],
        dispatchGate: { cause: "mapping_missing", missingSlots: ["dispatch"], remedy: "Map it." },
      },
    };
    try {
      expect(await main(["explain", "HAG-404"], ctx)).toBe(0);
      const text = ctx.out.join("\n");
      expect(text).toBe("HAG-404: not in the HAG eligibility explainer — the ticket is unknown to the mirror, terminal, or on another team.");
      expect(server.requests.some((r) => r.path.startsWith("/api/v1/issues/HAG-404"))).toBe(true);
    } finally {
      delete server.eligibilityByTeam.HAG;
    }
  });
  test("a mapped stage that was deleted reads as such", async () => {
    server.eligibilityByTeam.HAG = {
      team: "HAG",
      eligibility: {
        rows: [],
        dispatchGate: { cause: "mapping_state_unresolved", missingSlots: ["dispatch"], remedy: "Re-map it." },
      },
    };
    server.issues = [...fixtureIssues(), { ...fixtureIssues()[0], identifier: "HAG-31", state: "Todo" }];
    try {
      expect(await main(["explain", "HAG-31"], ctx)).toBe(0);
      expect(ctx.out.join("\n")).toContain("HAG-31 cannot start: the stage team HAG mapped for dispatch no longer exists in Linear. Re-map it.");
    } finally {
      delete server.eligibilityByTeam.HAG;
      server.issues = fixtureIssues();
    }
  });
  // ⛔ 0.2.0 printed a "not visible to an account key yet" placeholder here and called nothing.
  // CTC-1954's route is the real answer; --history is an alias of the `history` verb.
  test("--history reads the execution route, not a placeholder, and skips the eligibility call", async () => {
    expect(await main(["explain", "ENG-2", "--history"], ctx)).toBe(0);
    expect(server.requests.map((r) => r.path.split("?")[0])).toContain("/api/v1/issues/ENG-2/execution");
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/work-eligibility"))).toHaveLength(0);
    expect(ctx.out.join("\n")).not.toContain("not visible to an account key yet");
    expect(ctx.out.join("\n")).toContain("implement: cooling (attempt 2)");
  });
  test("usage errors and not joined", async () => {
    expect(await main(["explain"], ctx)).toBe(1);
    expect(await main(["explain", "nodash"], makeCtx(home))).toBe(1);
    expect(await main(["explain", "ENG-1"], makeCtx(tempHome()))).toBe(2);
  });
  test("the reason table covers the thirty-eight exclusions and eleven unknowns", () => {
    expect(Object.keys(EXCLUSION_REASONS)).toHaveLength(38);
    expect(Object.keys(UNKNOWN_REASONS)).toHaveLength(11);
    expect(describeReason("blocked")).toMatch(/blocking relation/);
    expect(describeReason("ticket_unknown")).toMatch(/not in the mirror/);
    // An unmapped team never clears on its own; the gloss must not read as transient.
    expect(describeReason("workflow_mapping_unknown")).toMatch(/no saved stage mapping/);
    expect(describeReason("workflow_mapping_unknown")).toMatch(/does not clear by itself/);
    expect(describeReason("ordering_never_published")).toMatch(/stage mapping/);
    expect(describeReason(undefined)).toBe("no reason was given");
    expect(renderExplain("X-1", { status: "unknown", unknown: "ordering_stale" }, "X")).toContain("cannot be judged (no queue position): the dispatch order is stale.");
    expect(renderExplain("X-1", { status: "excluded", reason: "runner_image_breaker", detail: "sha abc", failure: { weird: true } }, "X")).toContain('Last failure: {"weird":true}.');
    expect(renderExplain("X-1", { status: "excluded", reason: "ask_shape_suspected", marker: "ask_template_body", release: "catalyst-not-an-ask", nextPhase: "research" }, "X")).toMatch(/Marker: ask_template_body\. Next phase would be research\. Release: catalyst-not-an-ask\./);
  });
});

describe("gateFromContract", () => {
  test("normalizes the contract's `status` onto the renderer's `cause`, tagged as cached", () => {
    expect(gateFromContract({ status: "mapping_missing", missingSlots: ["dispatch"], remedy: "Map it." })).toEqual({
      cause: "mapping_missing",
      missingSlots: ["dispatch"],
      remedy: "Map it.",
      source: "contract",
    });
  });
  test("an open gate, an absent gate and a shapeless gate are all 'no gate'", () => {
    expect(gateFromContract({ status: "open", missingSlots: [], remedy: null })).toBeNull();
    expect(gateFromContract(undefined)).toBeNull();
    expect(gateFromContract({} as never)).toBeNull();
  });
  test("an unknown status is passed through, not swallowed", () => {
    expect(gateFromContract({ status: "frobnicated" })?.cause).toBe("frobnicated");
  });
});

describe("liveReadMayFallBack", () => {
  test("an unavailable read may fall back; a cloud that answered may not", () => {
    expect(liveReadMayFallBack(new MeError("could not reach", "network"))).toBe(true);
    expect(liveReadMayFallBack(new MeError("non-JSON body", "shape"))).toBe(true);
    expect(liveReadMayFallBack(new CliError("boom", "server", 2, 503))).toBe(true);
    expect(liveReadMayFallBack(new CliError("not found", "nf", 2, 404))).toBe(true);
    expect(liveReadMayFallBack(new CliError("unauthorized", "unauthorized", 2, 401))).toBe(false);
    expect(liveReadMayFallBack(new CliError("forbidden", "forbidden", 2, 403))).toBe(false);
    expect(liveReadMayFallBack(new CliError("bad field", "invalid", 2, 400))).toBe(false);
    expect(liveReadMayFallBack(new Error("something else"))).toBe(false);
  });
});

describe("explain reads the dispatch gate from the cached contract", () => {
  // The live eligibility read is unavailable — every other route (the mirror probe, /me, the
  // contract) still reaches the real fixture server.
  function offlineCtx(h: string): TestCtx {
    const impl: typeof fetch = async (input, init) => {
      if (String(input).includes("/api/v1/work-eligibility")) throw new TypeError("simulated network outage");
      return fetch(input as Parameters<typeof fetch>[0], init);
    };
    return makeCtx(h, { fetch: impl });
  }
  // The live eligibility read is ANSWERED with a refusal (401) — never unavailable — so a cached
  // gate must not stand in for it (D4).
  function unauthorizedCtx(h: string): TestCtx {
    const impl: typeof fetch = async (input, init) => {
      if (String(input).includes("/api/v1/work-eligibility")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return fetch(input as Parameters<typeof fetch>[0], init);
    };
    return makeCtx(h, { fetch: impl });
  }

  test("AC1a — an unavailable live read falls back to the cached gate, leading with the gate and its remedy", async () => {
    seedTeamGate(home, 0, {
      status: "mapping_missing",
      missingSlots: ["dispatch", "pr"],
      remedy: "A tenant admin opens Settings → Linear teams → ENG and presses Map my stages.",
    });
    const c = offlineCtx(home);
    expect(await main(["explain", "ENG-1"], c)).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("ENG-1 cannot start: team ENG has no saved stage mapping for dispatch, pr.");
    expect(text).toContain("A tenant admin opens Settings → Linear teams → ENG and presses Map my stages.");
    expect(text).toContain("Read from the cached tenant contract: the live eligibility read was unavailable");
    expect(text).not.toContain("not a dispatch state");
  });

  test("AC1b — the same for mapping_state_unresolved, and --json carries source and liveReadFailed", async () => {
    seedTeamGate(home, 0, { status: "mapping_state_unresolved", missingSlots: ["dispatch"], remedy: "Re-map it." });
    const c = offlineCtx(home);
    expect(await main(["explain", "ENG-1", "--json"], c)).toBe(0);
    const j = JSON.parse(c.out.at(-1)!) as { dispatchGate?: { cause: string; source: string; remedy: string }; liveReadFailed?: string; explanation: string };
    expect(j.dispatchGate).toMatchObject({ cause: "mapping_state_unresolved", source: "contract", remedy: "Re-map it." });
    expect(j.liveReadFailed).toContain("simulated network outage");
    expect(j.explanation).toContain("the stage team ENG mapped for dispatch no longer exists in Linear. Re-map it.");
  });

  test("AC1c — an unavailable live read with NO cached gate still refuses exactly as before", async () => {
    const c = offlineCtx(home); // no seedTeamGate
    expect(await main(["explain", "ENG-1"], c)).toBe(2);
    expect(c.out.join("\n")).toBe("");
    expect(c.err.join("\n")).toContain("could not reach");
  });

  test("AC1c2 — a cached gate never stands in for a credential refusal", async () => {
    seedTeamGate(home, 0, { status: "mapping_missing", missingSlots: ["dispatch"], remedy: "Map it." });
    const c = unauthorizedCtx(home);
    expect(await main(["explain", "ENG-1"], c)).toBe(2);
    expect(c.out.join("\n")).toBe("");
    expect(c.err.join("\n")).toContain("401");
  });

  test("AC1d — a live row beats a stale cached shut gate, and says so", async () => {
    seedTeamGate(home, 0, { status: "mapping_missing", missingSlots: ["dispatch"], remedy: "Map it." });
    expect(await main(["explain", "ENG-1"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toBe(
      "ENG-1 is offered (position 1) for phase research. " +
        "The cached tenant contract says mapping_missing for team ENG; this live eligibility read has a row for ENG-1 and wins.",
    );
  });

  test("AC1e — two gates that disagree: the live read wins and the paragraph says so", async () => {
    seedTeamGate(home, 0, { status: "mapping_missing", missingSlots: ["dispatch"], remedy: "Map it." });
    server.eligibilityByTeam.ENG = {
      team: "ENG",
      eligibility: { rows: [], dispatchGate: { cause: "mapping_state_unresolved", missingSlots: ["dispatch"], remedy: "Re-map it." } },
    };
    server.issues = fixtureIssues().map((i) => (i.identifier === "ENG-7" ? { ...i, state: "Todo" } : i));
    try {
      expect(await main(["explain", "ENG-7", "--json"], ctx)).toBe(0);
      const j = JSON.parse(ctx.out.at(-1)!) as { dispatchGate?: { cause: string; source: string }; dispatchGateOverridden?: { cause: string; source: string }; explanation: string };
      expect(j.dispatchGate).toMatchObject({ cause: "mapping_state_unresolved", source: "live" });
      expect(j.dispatchGateOverridden).toMatchObject({ cause: "mapping_missing", source: "contract" });
      expect(j.explanation).toContain("The cached tenant contract says mapping_missing; this live eligibility read says mapping_state_unresolved and wins.");
    } finally {
      delete server.eligibilityByTeam.ENG;
      server.issues = fixtureIssues();
    }
  });

  test("AC1f — a cloud older than the eligibility change: the live read sends no gate, the cache answers", async () => {
    seedTeamGate(home, 0, { status: "mapping_missing", missingSlots: ["dispatch"], remedy: "Map it." });
    server.issues = fixtureIssues().map((i) => (i.identifier === "ENG-7" ? { ...i, state: "Backlog" } : i));
    try {
      expect(await main(["explain", "ENG-7"], ctx)).toBe(0);
      const text = ctx.out.join("\n");
      expect(text).toContain("ENG-7 cannot start: team ENG has no saved stage mapping for dispatch. Map it.");
      expect(text).toContain("Read from the cached tenant contract: this cloud's eligibility read sent no dispatch gate.");
      expect(text).not.toContain("not a dispatch state");
    } finally {
      server.issues = fixtureIssues();
    }
  });

  test("AC1g — a team-wide cached gate still never proves an id the mirror 404s on exists", async () => {
    seedTeamGate(home, 0, { status: "mapping_missing", missingSlots: ["dispatch"], remedy: "Map it." });
    expect(await main(["explain", "ENG-404"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toBe("ENG-404: not in the ENG eligibility explainer — the ticket is unknown to the mirror, terminal, or on another team.");
  });

  test("AC1h — a team absent from the contract does not crash the cached-gate read", async () => {
    server.eligibilityByTeam.HAG = { team: "HAG", eligibility: { rows: [] } };
    try {
      expect(await main(["explain", "HAG-404"], ctx)).toBe(0); // findTeamByKey → null, no throw
    } finally {
      delete server.eligibilityByTeam.HAG;
    }
  });

  // The mirror probe is the ONLY read that can prove an id exists; it is not reached through the
  // eligibility route at all. Everything below pins that the fallback never speaks for it.
  test("AC1i — the offline twin of AC1g: an unavailable live read still never proves a 404 id exists", async () => {
    seedTeamGate(home, 0, { status: "mapping_missing", missingSlots: ["dispatch"], remedy: "Map it." });
    const c = offlineCtx(home);
    expect(await main(["explain", "ENG-404"], c)).toBe(0);
    const text = c.out.join("\n");
    // The team-wide mapping verdict must NOT be inherited by an id the mirror does not know.
    expect(text).toContain("ENG-404: not in the ENG eligibility explainer — the ticket is unknown to the mirror, terminal, or on another team.");
    expect(text).not.toContain("cannot start");
    expect(text).not.toContain("no saved stage mapping");
    expect(text).not.toContain("Map it.");
    // ...and the outage is still named, so a network failure never reads as a confident verdict.
    expect(text).toContain("The live eligibility read was unavailable");
  });

  test("AC1i2 — --json on that same read carries no dispatchGate", async () => {
    seedTeamGate(home, 0, { status: "mapping_missing", missingSlots: ["dispatch"], remedy: "Map it." });
    const c = offlineCtx(home);
    expect(await main(["explain", "ENG-404", "--json"], c)).toBe(0);
    const j = JSON.parse(c.out.at(-1)!) as { dispatchGate?: unknown; liveReadFailed?: string };
    expect(j.dispatchGate).toBeUndefined();
    expect(j.liveReadFailed).toContain("simulated network outage");
  });

  test("AC1j — a mirror-probe outage is reported as itself, never as an eligibility failure", async () => {
    seedTeamGate(home, 0, { status: "mapping_missing", missingSlots: ["dispatch"], remedy: "Map it." });
    const impl: typeof fetch = async (input, init) => {
      if (String(input).includes("/api/v1/issues/")) throw new TypeError("mirror probe outage");
      return fetch(input as Parameters<typeof fetch>[0], init);
    };
    const c = makeCtx(home, { fetch: impl });
    // The eligibility read SUCCEEDED. The cached gate may not stand in for the read that did fail,
    // and the paragraph must never quote an /issues/ URL as an eligibility failure.
    expect(await main(["explain", "ENG-404"], c)).toBe(2);
    expect(c.out.join("\n")).toBe("");
    const err = c.err.join("\n");
    expect(err).toContain("/api/v1/issues/ENG-404");
    expect(err).toContain("mirror probe outage");
    expect(err).not.toContain("eligibility read was unavailable");
  });
});

describe("running / queue / accounts", () => {
  // ⛔ `/api/v1/lease/attributions` is per (ticket, phase) and 400s `invalid_field` without both.
  // 0.2.0 called it unconditionally, so `running` — the headline "what is happening?" verb, and the
  // first thing a customer types — 400'd for every tenant. The fleet-wide question is answered by
  // /fleet-activity/current and /agent-roster/current, which take no coordinates.
  test("running asks only the two fleet-wide routes, never a bare lease/attributions", async () => {
    expect(await main(["running"], ctx)).toBe(0);
    expect(server.requests.map((r) => r.path.split("?")[0])).toContain("/api/v1/fleet-activity/current");
    expect(server.requests.map((r) => r.path.split("?")[0])).toContain("/api/v1/agent-roster/current");
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/lease/attributions"))).toHaveLength(0);
    const text = ctx.out.join("\n");
    expect(text).toContain("runner-7");
    expect(text).toContain("concierge");
    const c2 = makeCtx(home);
    expect(await main(["running", "--json"], c2)).toBe(0);
    expect(Object.keys(JSON.parse(c2.out.join("\n")))).toEqual(["fleetActivity", "agentRoster"]);
  });
  test("running --ticket/--phase adds the lease attributions for that pair", async () => {
    expect(await main(["running", "--ticket", "ENG-2", "--phase", "implement", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(["fleetActivity", "agentRoster", "leaseAttributions"]);
    const req = server.requests.find((r) => r.path.startsWith("/api/v1/lease/attributions"));
    expect(req?.path).toContain("ticket=ENG-2");
    expect(req?.path).toContain("phase=implement");
  });
  test("running --ticket without --phase is a usage error, not a 400 from the cloud", async () => {
    expect(await main(["running", "--ticket", "ENG-2"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("--ticket and --phase go together");
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/lease/attributions"))).toHaveLength(0);
  });
  test("queue prints the fixture rows and passes --team", async () => {
    expect(await main(["queue", "--team", "ENG", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ team: "ENG", source: "self-derived" });
    expect(server.requests.find((r) => r.path.startsWith("/api/v1/dispatch-queue"))?.path).toContain("team=ENG");
  });
  // ⛔ The route REQUIRES a team ("bad team", 400). `queue`'s usage line calls --team optional, so
  // the omitted case has to be answered by the CLI: the contract already names this tenant's teams.
  test("queue with no --team reads every team the contract names", async () => {
    expect(await main(["queue"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("ENG-1");
    const asked = server.requests
      .filter((r) => r.path.startsWith("/api/v1/dispatch-queue"))
      .map((r) => new URL(r.path, "http://x").searchParams.get("team"));
    expect(asked).toEqual(["ENG", "OPS"]);
    const c2 = makeCtx(home);
    expect(await main(["queue", "--json"], c2)).toBe(0);
    expect(Object.keys(JSON.parse(c2.out.join("\n")))).toEqual(["ENG", "OPS"]);
  });
  // ⛔ 0.2.0 printed a placeholder unconditionally and never called the route, so it could not have
  // started working when CTC-1953 deployed. These assert the CALL, not just the rendering.
  test("accounts calls /api/v1/coding-accounts and renders the slots", async () => {
    expect(await main(["accounts"], ctx)).toBe(0);
    expect(server.requests.map((r) => r.path.split("?")[0])).toContain("/api/v1/coding-accounts");
    const text = ctx.out.join("\n");
    expect(text).not.toContain("not visible to an account key yet");
    expect(text).toContain("primary (slot-a)  claude/claude-code  active — observed working");
    expect(text).toContain("holding ENG-2/implement");
    expect(text).toContain("walled — the provider's usage limit is spent for now");
    const c2 = makeCtx(home);
    expect(await main(["accounts", "--json"], c2)).toBe(0);
    const json = JSON.parse(c2.out.join("\n")) as { accounts: { accountSlot: string; displayName: string }[] };
    expect(json.accounts).toHaveLength(2);
    // Every account carries a displayName: its label, else its email, else its slot id.
    expect(json.accounts.find((a) => a.accountSlot === "slot-a")?.displayName).toBe("primary");
    expect(json.accounts.every((a) => typeof a.displayName === "string" && a.displayName !== "")).toBe(true);
    expect(await main(["accounts"], makeCtx(tempHome()))).toBe(2);
  });
  // CTC-6204: a customer's agents kept trying to revive three revoked accounts the list showed as
  // "expired or revoked — replace its credential". Removed accounts are history: hidden by default.
  test("accounts hides removed accounts unless --all, and never offers them a credential", async () => {
    const live = { accountSlot: "codex-live", provider: "codex", status: "active", revokedAtMs: null };
    // An older cloud still calls a revoked account expired-or-revoked; revokedAtMs decides.
    const revoked = { accountSlot: "codex-gone", provider: "codex", status: "expired-or-revoked", revokedAtMs: 1 };
    const ended = { accountSlot: "codex-done", provider: "codex", status: "ended", revokedAtMs: null };
    // Positive control: an expired credential on a live account still says how to repair it.
    const expired = { accountSlot: "codex-stale", provider: "codex", status: "expired-or-revoked", revokedAtMs: null };
    server.codingAccounts = [live, revoked, ended, expired];
    try {
      expect(await main(["accounts"], ctx)).toBe(0);
      const text = ctx.out.join("\n");
      expect(text).toContain("codex-live");
      expect(text).not.toContain("codex-gone");
      expect(text).not.toContain("codex-done");
      expect(text).toMatch(/codex-stale .*replace its credential/);
      expect(text).toContain("2 removed accounts are kept for history and take no work; catalyst accounts --all lists them.");

      const all = makeCtx(home);
      expect(await main(["accounts", "--all"], all)).toBe(0);
      const lines = all.out;
      for (const slot of ["codex-gone", "codex-done"]) {
        const line = lines.find((l) => l.startsWith(slot))!;
        expect(line).toContain("removed — kept for history, takes no work");
        expect(line).not.toMatch(/replace|credential/i);
      }

      const json = makeCtx(home);
      expect(await main(["accounts", "--json"], json)).toBe(0);
      const body = JSON.parse(json.out.join("\n")) as { accounts: { accountSlot: string; removed: boolean }[]; removedHidden: number };
      expect(body.accounts.map((a) => a.accountSlot)).toEqual(["codex-live", "codex-stale"]);
      expect(body.removedHidden).toBe(2);
      const jsonAll = makeCtx(home);
      expect(await main(["accounts", "--all", "--json"], jsonAll)).toBe(0);
      const every = JSON.parse(jsonAll.out.join("\n")) as { accounts: { accountSlot: string; removed: boolean }[] };
      expect(every.accounts.filter((a) => a.removed).map((a) => a.accountSlot)).toEqual(["codex-gone", "codex-done"]);

      // Only removed accounts left: say none can take work, never "none are enrolled".
      server.codingAccounts = [revoked, ended];
      const none = makeCtx(home);
      expect(await main(["accounts"], none)).toBe(0);
      expect(none.out.join("\n")).toContain("No AI account in this workspace can take work.");
      expect(none.out.join("\n")).not.toContain("No coding accounts are enrolled");
    } finally {
      server.codingAccounts = undefined;
    }
  });
  test("history renders the ticket's phases, failure, rounds and lease", async () => {
    expect(await main(["history", "ENG-2"], ctx)).toBe(0);
    const text = ctx.out.join("\n");
    expect(text).toContain("research: completed (attempt 1)");
    expect(text).toContain("implement: cooling (attempt 2), last failure vendor_5xx ×1");
    expect(text).toContain("Last failure: implement — vendor_5xx (upstream 503)");
    expect(text).toContain("Remediate rounds dispatched: 1 (cap 3)");
    expect(text).toContain("Live lease: implement held by runner-7");
    expect(await main(["history"], makeCtx(home))).toBe(1);
  });
  test("history names every governor holding the ticket with what releases it, and the release audit", async () => {
    expect(await main(["history", "ENG-2"], ctx)).toBe(0);
    const text = ctx.out.join("\n");
    expect(text).toContain("Held by:");
    expect(text).toContain("  phase_park at implement (parked:repeated_failure) — catalyst-skills release ENG-2 once its cause is fixed");
    expect(text).toContain("  human_owned_pr at remediate — PR #41 by ana is a person's; close or merge it");
    expect(text).toContain("Releases (newest first):");
    expect(text).toContain("  2025-08-25T05:46:40.000Z refused by user:user-ana — \"retry after the outage\" — refused: human_owned_pr");
    expect(text).toContain("  2025-08-25T05:30:00.000Z released by key:ak_host — \"secret rotated\" — released: unpark implement");
  });
  test("history says when the governors or the audit could not be read, never that nothing holds it", async () => {
    server.execution = { governors: null, releases: null };
    try {
      expect(await main(["history", "ENG-2"], ctx)).toBe(0);
      const text = ctx.out.join("\n");
      expect(text).toContain("Held by: could not be read (unreadable, not empty)");
      expect(text).toContain("Releases: could not be read (unreadable, not empty)");
    } finally {
      server.execution = undefined;
    }
  });
  test("a park line no longer says only an operator releases it", async () => {
    server.execution = { park: { sentinel: "parked:repeated_failure", selfReleases: false, releasedBy: "catalyst-skills release <ticket> once its cause is fixed, or operator unpark", phase: "implement" } };
    try {
      expect(await main(["history", "ENG-2"], ctx)).toBe(0);
      const text = ctx.out.join("\n");
      expect(text).not.toContain("needs an operator");
      expect(text).toContain("Parked at implement (parked:repeated_failure): does not release itself — catalyst-skills release <ticket> once its cause is fixed, or operator unpark");
    } finally {
      server.execution = undefined;
    }
  });
  test("the reasons a release verb now clears are in the bundle's table, never printed raw", () => {
    for (const reason of ["phase_parked", "human_owned_pr", "review_not_converging", "round_threshold", "claim_storm", "repo_at_capacity", "later_phase_lease_held", "wip_limit"]) {
      expect(describeReason(reason), reason).not.toMatch(/not in this bundle's table/);
    }
    expect(describeReason("phase_parked")).toMatch(/catalyst release/);
  });
  // ⛔ A route this tenant's cloud does not serve is SAID, never rendered as an empty success.
  test("a 404 from either new route says the cloud is older than the bundle, and exits non-zero", async () => {
    server.routesDeployed = false;
    try {
      expect(await main(["accounts"], ctx)).toBe(3);
      expect(ctx.err.join("\n")).toContain("needs a newer Catalyst Cloud");
      const c2 = makeCtx(home);
      expect(await main(["history", "ENG-2"], c2)).toBe(3);
      expect(c2.err.join("\n")).toContain("needs a newer Catalyst Cloud");
      // Never an empty-but-successful answer, which is what a placeholder or a swallowed 404 gives.
      expect(ctx.out.join("\n")).toBe("");
      expect(c2.out.join("\n")).toBe("");
    } finally {
      server.routesDeployed = true;
    }
  });
  test("me prints the identity", async () => {
    expect(await main(["me"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("Hagale Technologies");
    const c2 = makeCtx(home);
    expect(await main(["me", "--json"], c2)).toBe(0);
    expect(JSON.parse(c2.out.join("\n"))).toMatchObject({ account: "tenant-3" });
  });
});

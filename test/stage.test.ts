import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { configPathFor } from "../src/config";
import { buildFixtureContract } from "./fixture-contract";
import { makeCtx, tempHome } from "./helpers";

const stageRoutes = {
  claim: "/different/agent/local-phase/claim",
  renew: "/different/agent/local-phase/renew",
  release: "/different/agent/local-phase/release",
  artifact: "/api/v1/artifacts/publish",
  object: "/api/v1/artifacts/object",
  coordination: "/api/v1/coordination/publish",
};
function setup(
  grantedPhase = "research",
  opts: {
    refuseArtifact?: string;
    priorArtifacts?: string[];
    priorBytes?: string;
    rejectMove?: boolean;
    failTerminalEventOnce?: boolean;
    rejectTerminalArtifactOnce?: boolean;
    releaseRefusal?: string;
    rejectReceiptOnce?: boolean;
    rejectReceiptOnRetry?: boolean;
    keying?: "leading" | "trailing";
    onTerminalUpload?: (home: string) => void;
  } = {},
) {
  const home = tempHome();
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(
    configPathFor(home),
    JSON.stringify({
      baseUrl: "https://cloud.example.test",
      key: "personal-key",
      account: "account-1",
      slug: "test",
      name: "Test",
      principal: "service",
      joinedAt: "2026-10-12T00:00:00Z",
    }),
  );
  const calls: { path: string; body: unknown; headers: Headers }[] = [];
  let terminalEventFailed = false;
  let terminalArtifactRejected = false;
  let receiptRejected = false;
  let receiptUploads = 0;
  const doc = buildFixtureContract();
  doc.teams[0]!.key = "CTC";
  doc.ladder.keying = opts.keying ?? "trailing";
  doc.routes = [
    ...doc.routes,
    ...(["claim", "renew", "release"] as const).map((key) => ({
      method: "POST" as const,
      path: stageRoutes[key],
      takesWriteBudgetUnit: false,
      since: "2.4.0",
    })),
  ];
  const issueStatePath = doc.routes.find((route) =>
    route.path.endsWith("/issue-state"),
  )!.path;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const body =
      init?.body &&
      typeof init.body === "string" &&
      init.headers &&
      (init.headers as Record<string, string>)["content-type"] ===
        "application/json"
        ? JSON.parse(init.body)
        : init?.body;
    calls.push({ path, body, headers: new Headers(init?.headers) });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path === "/api/v1/agent/contract") return json(doc);
    if (path === "/api/v1/issues/CTC-5742")
      return json({
        id: "linear-issue-5742",
        identifier: "CTC-5742",
        team_id: doc.teams[0]!.id,
      });
    if (path === issueStatePath)
      return opts.rejectMove
        ? json({ outcome: "rejected", reason: "state transition refused" }, 400)
        : json({ outcome: "succeeded", attempts: 1 });
    if (path === stageRoutes.claim)
      return json({
        claimed: true,
        assignment: {
          ticket: "CTC-5742",
          phase: grantedPhase,
          lease: { holder: "customer:key:host" },
          grant: { nonce: 7, expiresAtMs: Date.now() + 3_600_000 },
          priorArtifacts: opts.priorArtifacts ?? [],
        },
        credential: "lease-secret",
        runtime: {
          incarnation: "inc",
          nonce: 2,
          expiresAtMs: Date.now() + 900_000,
        },
      });
    if (path === stageRoutes.release)
      return json(
        opts.releaseRefusal
          ? { released: false, refusal: opts.releaseRefusal }
          : { released: true },
      );
    if (path === stageRoutes.renew)
      return json({
        renewed: true,
        grant: { expiresAtMs: Date.now() + 3_600_000 },
        runtime: { expiresAtMs: Date.now() + 900_000 },
      });
    if (path === stageRoutes.object)
      return new Response(opts.priorBytes ?? "# Prior research\n", {
        status: 200,
      });
    if (path === stageRoutes.artifact) {
      if (url.searchParams.get("name") === "relay-done.json")
        opts.onTerminalUpload?.(home);
      if (url.searchParams.get("name") === "relay-done.json") receiptUploads++;
      if (
        opts.rejectReceiptOnRetry &&
        url.searchParams.get("name") === "relay-done.json" &&
        receiptUploads === 2
      )
        return json({ reason: "invalid_receipt_body" }, 400);
      if (
        opts.rejectReceiptOnce &&
        url.searchParams.get("name") === "relay-done.json" &&
        !receiptRejected
      ) {
        receiptRejected = true;
        return json({ reason: "invalid_receipt_body" }, 400);
      }
      if (
        opts.rejectTerminalArtifactOnce &&
        url.searchParams.get("name") === "research.md" &&
        !terminalArtifactRejected
      ) {
        terminalArtifactRejected = true;
        return json({ reason: "too-large" }, 413);
      }
      if (url.searchParams.get("name") === opts.refuseArtifact)
        return json({ reason: "invalid-lease-credential" }, 403);
      return json({
        key: `r2/${url.searchParams.get("name")}`,
        bytes: init?.body ? Buffer.byteLength(init.body as string) : 0,
      });
    }
    if (path === stageRoutes.coordination) {
      const name = (body as { records?: { event_name?: string }[] })
        ?.records?.[0]?.event_name;
      if (
        opts.failTerminalEventOnce &&
        name?.endsWith(".complete") &&
        !terminalEventFailed
      ) {
        terminalEventFailed = true;
        return json({ error: "temporary" }, 503);
      }
      return json({ accepted: 1, seqStart: 1, seqEnd: 1, headSeq: 1 });
    }
    return json({ error: "not found" }, 404);
  };
  const ctx = makeCtx(home, { fetch: fetcher as typeof fetch });
  return { home, ctx, calls, issueStatePath };
}

describe("stage local-phase wrapper", () => {
  test("a capped remediate receipt preserves the cap marker", async () => {
    const { home, ctx, calls } = setup("remediate");
    expect(await main(["stage", "start", "CTC-5742", "remediate"], ctx)).toBe(
      0,
    );
    const artifact = join(home, "remediation.json");
    const evidence = join(home, "evidence.json");
    const bytes = Buffer.from('{"summary":"repaired"}');
    writeFileSync(artifact, bytes);
    writeFileSync(
      evidence,
      JSON.stringify({
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
        remediateCapReached: true,
        conflictRouting: "validate",
        conflictExtraPaths: ["src/conflict.ts"],
        findingsRouting: "validate",
        findingsSourcePaths: ["src/finding.ts"],
      }),
    );
    expect(
      await main(
        [
          "stage",
          "done",
          "CTC-5742",
          "remediate",
          "--artifact",
          artifact,
          "--evidence",
          evidence,
        ],
        ctx,
      ),
    ).toBe(0);
    const artifactCalls = calls.filter(
      (call) => call.path === stageRoutes.artifact,
    );
    expect(artifactCalls.at(-1)?.body).toEqual({
      version: 1,
      artifactRef: "r2/remediation.json",
      remediateCapReached: true,
      conflictRouting: "validate",
      conflictExtraPaths: ["src/conflict.ts"],
      findingsRouting: "validate",
      findingsSourcePaths: ["src/finding.ts"],
    });
  });

  test("validate forwards skipped and unavailable checks", async () => {
    const { home, ctx, calls } = setup("validate");
    expect(await main(["stage", "start", "CTC-5742", "validate"], ctx)).toBe(0);
    const artifact = join(home, "validation.md");
    const evidence = join(home, "evidence.json");
    const bytes = Buffer.from("# Validation\nThree checks passed.\n");
    const steps = [
      ["plan-conformance", "PASS"],
      ["type-safety", "PASS"],
      ["code-review", "PASS"],
      ["security-review", "SKIPPED"],
      ["security-audit", "UNAVAILABLE"],
    ].map(([step, verdict]) => ({ step, verdict }));
    writeFileSync(artifact, bytes);
    const writeEvidence = () =>
      writeFileSync(
        evidence,
        JSON.stringify({
          artifactSha256: createHash("sha256").update(bytes).digest("hex"),
          ladder: { version: 1, steps },
        }),
      );
    writeEvidence();
    expect(
      await main(
        [
          "stage",
          "done",
          "CTC-5742",
          "validate",
          "--artifact",
          artifact,
          "--evidence",
          evidence,
        ],
        ctx,
      ),
    ).toBe(0);
    expect(
      calls.filter((call) => call.path === stageRoutes.artifact).at(-1)?.body,
    ).toEqual({
      version: 1,
      artifactRef: "r2/validation.md",
      ladder: { version: 1, steps },
    });
  });

  test("validate refuses an explicitly unreported check before publication", async () => {
    const { home, ctx, calls } = setup("validate");
    expect(await main(["stage", "start", "CTC-5742", "validate"], ctx)).toBe(0);
    const artifact = join(home, "validation.md");
    const evidence = join(home, "evidence.json");
    const bytes = Buffer.from("# Validation\nOne check was unreported.\n");
    writeFileSync(artifact, bytes);
    writeFileSync(
      evidence,
      JSON.stringify({
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
        ladder: {
          version: 1,
          steps: [
            "plan-conformance",
            "type-safety",
            "code-review",
            "security-review",
            "security-audit",
          ].map((step, index) => ({
            step,
            verdict: index === 3 ? "UNREPORTED" : "PASS",
          })),
        },
      }),
    );
    expect(
      await main(
        [
          "stage",
          "done",
          "CTC-5742",
          "validate",
          "--artifact",
          artifact,
          "--evidence",
          evidence,
        ],
        ctx,
      ),
    ).toBe(1);
    expect(
      calls.filter((call) => call.path === stageRoutes.artifact),
    ).toHaveLength(1);
  });

  test("start, renew, and done use the claimed lease; receipt follows the exact artifact", async () => {
    const { home, ctx, calls, issueStatePath } = setup();
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const statePath = join(
      home,
      ".config",
      "catalyst-cloud",
      "local-stages",
      "CTC-5742.json",
    );
    expect(JSON.parse(readFileSync(statePath, "utf8")).credential).toBe(
      "lease-secret",
    );
    expect(ctx.out.join("\n")).toContain("renew before");
    expect(
      await main(
        [
          "stage",
          "renew",
          "CTC-5742",
          "research",
          "--assertion",
          "drafted research",
        ],
        ctx,
      ),
    ).toBe(0);
    const artifact = join(home, "research.md");
    const bytes = Buffer.from("# Research\nConfirmed source paths.\n");
    writeFileSync(artifact, bytes);
    const evidence = join(home, "evidence.json");
    writeFileSync(
      evidence,
      JSON.stringify({
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    expect(
      await main(
        [
          "stage",
          "done",
          "CTC-5742",
          "research",
          "--artifact",
          artifact,
          "--evidence",
          evidence,
        ],
        ctx,
      ),
    ).toBe(0);
    const paths = calls.map((c) => c.path);
    expect(paths.filter((p) => p === stageRoutes.artifact)).toHaveLength(3); // round, artifact, receipt
    const artifactCalls = calls.filter((c) => c.path === stageRoutes.artifact);
    expect(artifactCalls[1]?.body).toEqual(bytes);
    expect(artifactCalls[2]?.body).toEqual({
      version: 1,
      artifactRef: "r2/research.md",
    });
    expect(
      calls
        .filter((c) => c.path === stageRoutes.coordination)
        .map(
          (c) =>
            (c.body as { records: { event_name: string }[] }).records[0]
              ?.event_name,
        ),
    ).toEqual(["phase.research.started", "phase.research.complete"]);
    expect(calls.filter((c) => c.path === stageRoutes.release)).toHaveLength(1);
    expect(
      calls
        .filter((c) => c.path === stageRoutes.artifact)
        .every(
          (c) =>
            c.headers.get("x-catalyst-lease-credential") === "lease-secret",
        ),
    ).toBe(true);
    const startedIndex = calls.findIndex(
      (c) => c.path === stageRoutes.coordination,
    );
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(calls.some((c) => c.path === issueStatePath)).toBe(false);
  });

  test("downloads prior artifacts to a private, named local directory", async () => {
    const { home, ctx } = setup("plan", {
      priorArtifacts: ["tenant/CTC-5742/research/6/research.md"],
      priorBytes: "# Verified research\n",
    });
    expect(await main(["stage", "start", "CTC-5742", "plan"], ctx)).toBe(0);
    const saved = JSON.parse(
      readFileSync(
        join(
          home,
          ".config",
          "catalyst-cloud",
          "local-stages",
          "CTC-5742.json",
        ),
        "utf8",
      ),
    );
    expect(
      readFileSync(
        join(saved.priorDir, "research", "6", "research.md"),
        "utf8",
      ),
    ).toBe("# Verified research\n");
    expect(ctx.out.join("\n")).toContain(saved.priorDir);
  });

  test("a later phase with the same lease nonce gets its own prior-artifact directory", async () => {
    const { home, ctx } = setup("plan", {
      priorArtifacts: ["tenant/CTC-5742/research/6/research.md"],
    });
    const earlier = join(
      home,
      ".config",
      "catalyst-cloud",
      "local-stages",
      "prior",
      "CTC-5742",
      "research",
      "7",
      "research",
      "6",
    );
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, "research.md"), "# Earlier copy\n");
    expect(await main(["stage", "start", "CTC-5742", "plan"], ctx)).toBe(0);
    const saved = JSON.parse(
      readFileSync(
        join(
          home,
          ".config",
          "catalyst-cloud",
          "local-stages",
          "CTC-5742.json",
        ),
        "utf8",
      ),
    );
    expect(
      readFileSync(
        join(saved.priorDir, "research", "6", "research.md"),
        "utf8",
      ),
    ).toBe("# Prior research\n");
    expect(readFileSync(join(earlier, "research.md"), "utf8")).toBe(
      "# Earlier copy\n",
    );
  });

  test("an expired saved claim is reconciled by a fresh cloud claim", async () => {
    const { home, ctx, calls } = setup();
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const path = join(
      home,
      ".config",
      "catalyst-cloud",
      "local-stages",
      "CTC-5742.json",
    );
    const stale = JSON.parse(readFileSync(path, "utf8"));
    stale.expiresAtMs = 1;
    stale.runtime.expiresAtMs = 1;
    writeFileSync(path, JSON.stringify(stale));
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    expect(
      calls.filter((call) => call.path === stageRoutes.claim),
    ).toHaveLength(2);
  });

  test("a runtime expiry retains the saved proof while the work lease is live", async () => {
    const { home, ctx, calls } = setup();
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const path = join(
      home,
      ".config",
      "catalyst-cloud",
      "local-stages",
      "CTC-5742.json",
    );
    const state = JSON.parse(readFileSync(path, "utf8"));
    state.runtime.expiresAtMs = 1;
    writeFileSync(path, JSON.stringify(state));
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(1);
    expect(
      calls.filter((call) => call.path === stageRoutes.claim),
    ).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8")).credential).toBe(
      "lease-secret",
    );
  });

  test("a frontier mismatch releases without publishing", async () => {
    const { ctx, calls } = setup("plan");
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(2);
    expect(calls.some((c) => c.path === stageRoutes.release)).toBe(true);
    expect(calls.some((c) => c.path === stageRoutes.artifact)).toBe(false);
  });

  test("a refused mismatch release retains the granted lease proof", async () => {
    const { home, ctx } = setup("plan", { releaseRefusal: "busy" });
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(2);
    const state = JSON.parse(
      readFileSync(
        join(
          home,
          ".config",
          "catalyst-cloud",
          "local-stages",
          "CTC-5742.json",
        ),
        "utf8",
      ),
    );
    expect(state).toMatchObject({
      phase: "plan",
      credential: "lease-secret",
      nonce: 7,
    });
  });

  test("a terminal receipt is fenced on disk before its network write", async () => {
    let fenced = false;
    const { home, ctx } = setup("research", {
      onTerminalUpload: (home) => {
        const state = JSON.parse(
          readFileSync(
            join(
              home,
              ".config",
              "catalyst-cloud",
              "local-stages",
              "CTC-5742.json",
            ),
            "utf8",
          ),
        );
        fenced = state.terminalAttempt?.committedOrAmbiguous === true;
      },
    });
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const artifact = join(home, "research.md"),
      evidence = join(home, "evidence.json");
    const bytes = Buffer.from("# Research\nVerified.\n");
    writeFileSync(artifact, bytes);
    writeFileSync(
      evidence,
      JSON.stringify({
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    expect(
      await main(
        [
          "stage",
          "done",
          "CTC-5742",
          "research",
          "--artifact",
          artifact,
          "--evidence",
          evidence,
        ],
        ctx,
      ),
    ).toBe(0);
    expect(fenced).toBe(true);
  });

  test("a wrong artifact digest refuses done before any terminal write, so the claim can be corrected", async () => {
    const { home, ctx, calls } = setup();
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const artifact = join(home, "research.md"),
      evidence = join(home, "evidence.json");
    writeFileSync(artifact, "# Research\n");
    writeFileSync(evidence, JSON.stringify({ artifactSha256: "0".repeat(64) }));
    expect(
      await main(
        [
          "stage",
          "done",
          "CTC-5742",
          "research",
          "--artifact",
          artifact,
          "--evidence",
          evidence,
        ],
        ctx,
      ),
    ).toBe(1);
    expect(calls.filter((c) => c.path === stageRoutes.release)).toHaveLength(0);
    expect(calls.filter((c) => c.path === stageRoutes.artifact)).toHaveLength(
      1,
    );
  });

  test("fail publishes a failure artifact and event without a receipt, then releases", async () => {
    const { ctx, calls } = setup();
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    expect(
      await main(
        ["stage", "fail", "CTC-5742", "research", "--summary", "tests failed"],
        ctx,
      ),
    ).toBe(0);
    const artifacts = calls.filter((c) => c.path === stageRoutes.artifact);
    expect(artifacts).toHaveLength(2);
    const failure = calls
      .filter((c) => c.path === stageRoutes.coordination)
      .at(-1)!.body as {
      records: { event_name: string; attributes: Record<string, unknown> }[];
    };
    expect(failure.records[0]?.event_name).toBe("phase.research.failed");
    expect(failure.records[0]?.attributes).toMatchObject({
      failureMode: "phase_failed",
      artifactRef: "r2/research.md",
    });
    expect(calls.filter((c) => c.path === stageRoutes.release)).toHaveLength(1);
  });

  test("a lease-credential refusal stops all terminal writes without releasing the superseded tenure", async () => {
    const { home, ctx, calls } = setup("research", {
      refuseArtifact: "research.md",
    });
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const artifact = join(home, "research.md"),
      evidence = join(home, "evidence.json");
    const bytes = Buffer.from("# Research\nTested.\n");
    writeFileSync(artifact, bytes);
    writeFileSync(
      evidence,
      JSON.stringify({
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    expect(
      await main(
        [
          "stage",
          "done",
          "CTC-5742",
          "research",
          "--artifact",
          artifact,
          "--evidence",
          evidence,
        ],
        ctx,
      ),
    ).toBe(2);
    expect(
      calls.filter((c) => c.path === stageRoutes.coordination),
    ).toHaveLength(1);
    expect(calls.filter((c) => c.path === stageRoutes.release)).toHaveLength(0);
  });

  test("a rejected app-actor state move surfaces a failed start and releases the claim", async () => {
    const { ctx, calls, issueStatePath } = setup("research", {
      rejectMove: true,
      keying: "leading",
    });
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(2);
    expect(calls.filter((c) => c.path === issueStatePath)).toHaveLength(1);
    expect(calls.filter((c) => c.path === stageRoutes.release)).toHaveLength(1);
    expect(
      calls
        .filter((c) => c.path === stageRoutes.coordination)
        .map(
          (c) =>
            (c.body as { records: { event_name: string }[] }).records[0]
              ?.event_name,
        ),
    ).toEqual(["phase.research.started", "phase.research.failed"]);
  });

  test("leading workflow keying moves the card after the start event", async () => {
    const { ctx, calls, issueStatePath } = setup("research", {
      keying: "leading",
    });
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const startedIndex = calls.findIndex(
      (call) =>
        call.path === stageRoutes.coordination &&
        (call.body as { records?: { event_name?: string }[] }).records?.[0]
          ?.event_name === "phase.research.started",
    );
    const moveIndex = calls.findIndex((call) => call.path === issueStatePath);
    expect(moveIndex).toBeGreaterThan(startedIndex);
    expect(calls[moveIndex]?.body).toEqual({
      issueId: "linear-issue-5742",
      stateId: "state-research",
    });
  });

  test("a terminal publish failure retains the lease so the same receipt and event can be retried", async () => {
    const { home, ctx, calls } = setup("research", {
      failTerminalEventOnce: true,
    });
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const artifact = join(home, "research.md"),
      evidence = join(home, "evidence.json");
    const bytes = Buffer.from("# Research\nVerified.\n");
    writeFileSync(artifact, bytes);
    writeFileSync(
      evidence,
      JSON.stringify({
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    const args = [
      "stage",
      "done",
      "CTC-5742",
      "research",
      "--artifact",
      artifact,
      "--evidence",
      evidence,
    ];
    expect(await main(args, ctx)).toBe(2);
    expect(calls.filter((c) => c.path === stageRoutes.release)).toHaveLength(0);
    const writesBeforeChangedRetry = calls.filter(
      (c) => c.path === stageRoutes.artifact,
    ).length;
    const changed = Buffer.from("# Research\nChanged after the receipt.\n");
    writeFileSync(artifact, changed);
    writeFileSync(
      evidence,
      JSON.stringify({
        artifactSha256: createHash("sha256").update(changed).digest("hex"),
      }),
    );
    expect(await main(args, ctx)).toBe(1);
    expect(calls.filter((c) => c.path === stageRoutes.artifact)).toHaveLength(
      writesBeforeChangedRetry,
    );
    writeFileSync(artifact, bytes);
    writeFileSync(
      evidence,
      JSON.stringify({
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    expect(await main(args, ctx)).toBe(0);
    expect(calls.filter((c) => c.path === stageRoutes.release)).toHaveLength(1);
    expect(
      calls.filter(
        (c) =>
          c.path === stageRoutes.coordination &&
          (c.body as { records?: { event_name?: string }[] })?.records?.[0]
            ?.event_name === "phase.research.complete",
      ),
    ).toHaveLength(2);
  });

  test("a definite first-upload 413 permits a corrected terminal payload", async () => {
    const { home, ctx, calls } = setup("research", {
      rejectTerminalArtifactOnce: true,
    });
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const artifact = join(home, "research.md"),
      evidence = join(home, "evidence.json");
    const writeEvidence = (bytes: Buffer) => {
      writeFileSync(artifact, bytes);
      writeFileSync(
        evidence,
        JSON.stringify({
          artifactSha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
    };
    writeEvidence(Buffer.from("# Research\nToo large in production.\n"));
    const args = [
      "stage",
      "done",
      "CTC-5742",
      "research",
      "--artifact",
      artifact,
      "--evidence",
      evidence,
    ];
    expect(await main(args, ctx)).toBe(2);
    writeEvidence(Buffer.from("# Research\nCorrected.\n"));
    expect(await main(args, ctx)).toBe(0);
    expect(
      calls.filter((call) => call.path === stageRoutes.release),
    ).toHaveLength(1);
  });

  test("a definitive receipt 400 permits corrected evidence before an accepted receipt", async () => {
    const { home, ctx } = setup("research", { rejectReceiptOnce: true });
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const artifact = join(home, "research.md"),
      evidence = join(home, "evidence.json");
    const bytes = Buffer.from("# Research\nVerified.\n");
    writeFileSync(artifact, bytes);
    writeFileSync(
      evidence,
      JSON.stringify({
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    const args = [
      "stage",
      "done",
      "CTC-5742",
      "research",
      "--artifact",
      artifact,
      "--evidence",
      evidence,
    ];
    expect(await main(args, ctx)).toBe(2);
    writeFileSync(
      evidence,
      JSON.stringify({
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
        note: "corrected",
      }),
    );
    expect(await main(args, ctx)).toBe(0);
  });

  test("a rejected retry cannot unfreeze a receipt accepted in an earlier invocation", async () => {
    const { home, ctx, calls } = setup("research", {
      failTerminalEventOnce: true,
      rejectReceiptOnRetry: true,
    });
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const artifact = join(home, "research.md"),
      evidence = join(home, "evidence.json");
    const writeEvidence = (bytes: Buffer) => {
      writeFileSync(artifact, bytes);
      writeFileSync(
        evidence,
        JSON.stringify({
          artifactSha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
    };
    writeEvidence(Buffer.from("# Original\n"));
    const args = [
      "stage",
      "done",
      "CTC-5742",
      "research",
      "--artifact",
      artifact,
      "--evidence",
      evidence,
    ];
    expect(await main(args, ctx)).toBe(2);
    expect(await main(args, ctx)).toBe(2);
    const writesBeforeChangedRetry = calls.filter(
      (call) => call.path === stageRoutes.artifact,
    ).length;
    writeEvidence(Buffer.from("# Changed after receipt\n"));
    expect(await main(args, ctx)).toBe(1);
    expect(
      calls.filter((call) => call.path === stageRoutes.artifact),
    ).toHaveLength(writesBeforeChangedRetry);
  });

  test("a second invocation cannot overwrite lease state during an active command", async () => {
    const { home, ctx, calls } = setup();
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const lock = join(
      home,
      ".config",
      "catalyst-cloud",
      "local-stages",
      "CTC-5742.json.lock",
    );
    writeFileSync(lock, JSON.stringify({ owner: "other", pid: process.pid }));
    const renew = [
      "stage",
      "renew",
      "CTC-5742",
      "research",
      "--assertion",
      "still working",
    ];
    expect(await main(renew, ctx)).toBe(2);
    expect(
      calls.filter((call) => call.path === stageRoutes.renew),
    ).toHaveLength(0);
    unlinkSync(lock);
    expect(await main(renew, ctx)).toBe(0);
  });

  test("stale-lock recovery waits for the exclusive recovery lock", async () => {
    const { home, ctx, calls } = setup();
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const lock = join(
      home,
      ".config",
      "catalyst-cloud",
      "local-stages",
      "CTC-5742.json.lock",
    );
    writeFileSync(
      lock,
      JSON.stringify({ owner: "dead-owner", pid: 99_999_999 }),
    );
    writeFileSync(`${lock}.recovery`, "another recoverer");
    const renew = [
      "stage",
      "renew",
      "CTC-5742",
      "research",
      "--assertion",
      "still working",
    ];
    expect(await main(renew, ctx)).toBe(2);
    expect(
      calls.filter((call) => call.path === stageRoutes.renew),
    ).toHaveLength(0);
    unlinkSync(`${lock}.recovery`);
    expect(await main(renew, ctx)).toBe(0);
    expect(
      calls.filter((call) => call.path === stageRoutes.renew),
    ).toHaveLength(1);
  });

  test("a dead recovery lock can be reclaimed on a later invocation", async () => {
    const { home, ctx } = setup();
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const lock = join(
      home,
      ".config",
      "catalyst-cloud",
      "local-stages",
      "CTC-5742.json.lock",
    );
    writeFileSync(
      lock,
      JSON.stringify({ owner: "dead-owner", pid: 99_999_999 }),
    );
    writeFileSync(
      `${lock}.recovery`,
      JSON.stringify({ owner: "dead-recoverer", pid: 99_999_999 }),
    );
    const renew = [
      "stage",
      "renew",
      "CTC-5742",
      "research",
      "--assertion",
      "still working",
    ];
    expect(await main(renew, ctx)).toBe(2);
    expect(await main(renew, ctx)).toBe(0);
  });

  test("an old nonempty partial recovery lock is reclaimed on retry", async () => {
    const { home, ctx, calls } = setup();
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const lock = join(
      home,
      ".config",
      "catalyst-cloud",
      "local-stages",
      "CTC-5742.json.lock",
    );
    writeFileSync(
      lock,
      JSON.stringify({ owner: "dead-owner", pid: 99_999_999 }),
    );
    writeFileSync(`${lock}.recovery`, '{"owner":');
    utimesSync(`${lock}.recovery`, new Date(0), new Date(0));
    const renew = [
      "stage",
      "renew",
      "CTC-5742",
      "research",
      "--assertion",
      "still working",
    ];
    expect(await main(renew, ctx)).toBe(2);
    expect(await main(renew, ctx)).toBe(0);
    expect(
      calls.filter((call) => call.path === stageRoutes.renew),
    ).toHaveLength(1);
  });

  test("an old partial stage lock left by a killed process is recoverable", async () => {
    const { home, ctx, calls } = setup();
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    const lock = join(
      home,
      ".config",
      "catalyst-cloud",
      "local-stages",
      "CTC-5742.json.lock",
    );
    writeFileSync(lock, "{");
    utimesSync(lock, new Date(0), new Date(0));
    expect(
      await main(
        [
          "stage",
          "renew",
          "CTC-5742",
          "research",
          "--assertion",
          "still working",
        ],
        ctx,
      ),
    ).toBe(0);
    expect(
      calls.filter((call) => call.path === stageRoutes.renew),
    ).toHaveLength(1);
  });

  test("rejects malformed plan scope before publishing the artifact", async () => {
    const { home, ctx, calls } = setup("plan");
    expect(await main(["stage", "start", "CTC-5742", "plan"], ctx)).toBe(0);
    const artifact = join(home, "plan.md"),
      evidence = join(home, "evidence.json");
    const bytes = Buffer.from("# Plan\n");
    writeFileSync(artifact, bytes);
    writeFileSync(
      evidence,
      JSON.stringify({
        artifactSha256: createHash("sha256").update(bytes).digest("hex"),
        scope: {
          status: "declared",
          files: [123],
          packages: [],
          exclusive: [],
        },
      }),
    );
    expect(
      await main(
        [
          "stage",
          "done",
          "CTC-5742",
          "plan",
          "--artifact",
          artifact,
          "--evidence",
          evidence,
        ],
        ctx,
      ),
    ).toBe(1);
    expect(
      calls.filter((call) => call.path === stageRoutes.artifact),
    ).toHaveLength(1);
  });

  test("a 200 release refusal retains the local lease proof and reports failure", async () => {
    const { home, ctx } = setup("research", {
      releaseRefusal: "stale_runtime",
    });
    expect(await main(["stage", "start", "CTC-5742", "research"], ctx)).toBe(0);
    expect(
      await main(
        ["stage", "fail", "CTC-5742", "research", "--summary", "test red"],
        ctx,
      ),
    ).toBe(2);
    expect(
      readFileSync(
        join(
          home,
          ".config",
          "catalyst-cloud",
          "local-stages",
          "CTC-5742.json",
        ),
        "utf8",
      ),
    ).toContain("lease-secret");
  });
});

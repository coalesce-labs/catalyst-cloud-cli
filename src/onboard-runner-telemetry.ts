import { hostname } from "node:os";
import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import { ownedFetch } from "./owned-fetch.js";
import type { OnboardJournal } from "./onboard.js";

export type CustodyFailureCase = "capability_missing" | "result_unverified" | "call_threw";
export interface CustodyFailureDetails {
  custodyFailureCase: CustodyFailureCase;
  custodyErrorClass?: string;
  custodyErrorMessage?: string;
  custodyErrorMessageRedacted?: boolean;
  custodyReason?: string;
  custodyResultInstalled?: boolean;
  custodyAuthorityMatched?: boolean;
}

/** One failure event, using the existing personal login and the tenant-stamping ingest route.
 * The short-lived export token stays in memory. Export failure never erases the setup refusal. */
export async function emitCustodyFailure(
  ctx: Ctx,
  journal: OnboardJournal,
  details: CustodyFailureDetails,
  parent?: AbortSignal,
): Promise<boolean> {
  const cfg = loadConfig(ctx.home);
  if (!cfg?.user || cfg.account !== (journal.account ?? journal.tenant) ||
      cfg.user.id !== journal.membershipId || !journal.baseUrl ||
      normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl)) return false;
  const expiry = cfg.auth ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime() : 0;
  const bearer = cfg.key || (cfg.auth && expiry > 30_000 ? cfg.auth.accessToken : undefined);
  if (!bearer || parent?.aborted) return false;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 5000);
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  const owner = ownedFetch(ctx.fetch, signal, { maxBodyBytes: 4096 });
  let delivered = false;
  try {
    const origin = normalizeBaseUrl(cfg.baseUrl);
    const minted = await owner.fetch(`${origin}/api/v1/telemetry/token`, {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ ttlSeconds: 60 }),
    });
    if (minted.status !== 200) return false;
    const token: unknown = await minted.json();
    if (!token || typeof token !== "object" || !("token" in token) ||
        typeof token.token !== "string" || !/^ctc_tel_[A-Za-z0-9._~-]{1,2048}$/.test(token.token) ||
        !("account" in token) || token.account !== cfg.account ||
        !("scope" in token) || token.scope !== "telemetry:write" ||
        !("endpoint" in token) || token.endpoint !== `${origin}/api/v1/telemetry`) return false;
    const current = loadConfig(ctx.home);
    if (!current?.user || current.account !== cfg.account || current.user.id !== cfg.user.id ||
        normalizeBaseUrl(current.baseUrl) !== origin) return false;
    const attribute = (key: string, value: string | boolean) => ({ key,
      value: typeof value === "boolean" ? { boolValue: value } : { stringValue: value } });
    const attributes = [
      attribute("catalyst.onboarding.run_id", journal.runId),
      attribute("catalyst.onboarding.step", "runner"),
      attribute("catalyst.onboarding.custody.failure_case", details.custodyFailureCase),
      ...Object.entries(details).filter(([key]) => key !== "custodyFailureCase").map(([key, value]) =>
        attribute(key, value)),
    ];
    const response = await owner.fetch(`${origin}/api/v1/telemetry/v1/logs`, {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      body: JSON.stringify({ resourceLogs: [{ resource: { attributes: [
        attribute("service.name", "catalyst-cloud.cli"), attribute("host.name", hostname()),
      ] }, scopeLogs: [{ scope: { name: "catalyst-cloud.cli.onboarding", version: journal.cli },
        logRecords: [{ timeUnixNano: String(BigInt(ctx.now().getTime()) * 1_000_000n),
          severityNumber: 17, severityText: "ERROR", eventName: "onboarding.runner.custody.refused",
          body: { stringValue: "Setup could not verify local storage." }, attributes }] }] }] }),
    });
    const text = await response.text();
    const acknowledgement: unknown = text ? JSON.parse(text) : {};
    if (response.ok && acknowledgement && typeof acknowledgement === "object" && !Array.isArray(acknowledgement)) {
      const partial = "partialSuccess" in acknowledgement ? acknowledgement.partialSuccess : undefined;
      delivered = partial === undefined || !!partial && typeof partial === "object" && !Array.isArray(partial) &&
        (!("rejectedLogRecords" in partial) || partial.rejectedLogRecords === 0 || partial.rejectedLogRecords === "0");
    }
  } catch { delivered = false; }
  finally {
    clearTimeout(timer);
    try { await owner.settle(); } catch { delivered = false; }
  }
  return delivered;
}

import { finishOnTheWeb } from "./consent-browser.js";
import { GITHUB_CONFIRM_ACCESS } from "./onboard-github-copy.js";
import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";
import { pollConsent, type ConsentStatus } from "./onboard-consent.js";
import {
  GITHUB_PERMISSION,
  githubInstallationPage,
  parsePermissions,
  type PermissionsVerdict,
} from "./onboard-permissions.js";

const STATUS = "/api/v1/me/connections/github/workspace";
const HANDOFF = "/connect/github/workspace/handoff";
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const states = new Set([
  "connected",
  "missing-scope",
  "expired-or-revoked",
  "unreachable",
  "not-connected",
]);
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
const nullableText = (v: unknown) => v === null || typeof v === "string";
const orgPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const coverageUnknown = new Set([
  "registry-unavailable",
  "over-bound",
  "not-run",
  "installation-unverified",
  "unreachable",
  "listing-truncated",
]);

type Read = { status: number; body?: unknown } | { reason: string };
interface WorkspaceObservation {
  result: OnboardStepResult;
  unsupported?: boolean;
}
export interface GithubInstallationOptions {
  openBrowser: (url: string, signal?: AbortSignal) => void | Promise<void>;
  wait?: <T>(message: string, work: () => Promise<T>) => Promise<T>;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  consentTimeoutMs?: number;
}

/** A bounded read never rotates credentials or writes a token after the receipt lock is released. */
async function read(
  ctx: Ctx,
  journal: OnboardJournal,
  path: string,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<Read> {
  const cfg = loadConfig(ctx.home);
  if (!cfg?.user) return { reason: "personal_login_required" };
  const personId = cfg.user.id;
  if (
    (journal.account ?? journal.tenant) !== cfg.account ||
    journal.membershipId !== cfg.user.id ||
    !journal.baseUrl ||
    normalizeBaseUrl(journal.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
  )
    return { reason: "github_installation_identity_refused" };
  const expiry = cfg.auth
    ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime()
    : 0;
  const bearer =
    cfg.key ||
    (cfg.auth && Number.isFinite(expiry) && expiry > 30_000
      ? cfg.auth.accessToken
      : undefined);
  if (!bearer) return { reason: "github_installation_login_refresh_required" };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = external
    ? AbortSignal.any([external, deadline.signal])
    : deadline.signal;
  let remove = () => {};
  try {
    return await new Promise<Read>((resolve) => {
      const stopped = () =>
        resolve({
          reason: external?.aborted
            ? "interrupted"
            : "github_installation_status_unavailable",
        });
      if (signal.aborted) {
        stopped();
        return;
      }
      signal.addEventListener("abort", stopped, { once: true });
      remove = () => signal.removeEventListener("abort", stopped);
      Promise.resolve()
        .then(async (): Promise<Read> => {
          if (signal.aborted) return { reason: "interrupted" };
          const response = await ctx.fetch(
            `${normalizeBaseUrl(cfg.baseUrl)}${path}`,
            {
              method: "GET",
              redirect: "error",
              headers: {
                authorization: `Bearer ${bearer}`,
                accept: "application/json",
              },
              signal,
            },
          );
          // Refusal bodies and provider diagnostics are never parsed, returned or printed.
          if (response.status !== 200) return { status: response.status };
          const body: unknown = await response.json();
          const current = loadConfig(ctx.home);
          if (
            !current?.user ||
            current.account !== cfg.account ||
            current.user.id !== personId ||
            normalizeBaseUrl(current.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
          )
            return { reason: "github_installation_identity_refused" };
          return { status: 200, body };
        })
        .then(
          (value) => (signal.aborted ? stopped() : resolve(value)),
          () =>
            signal.aborted
              ? stopped()
              : resolve({ reason: "github_installation_status_unavailable" }),
        );
    });
  } finally {
    clearTimeout(timer);
    remove();
  }
}

function readFailure(value: Read): OnboardStepResult | null {
  if ("reason" in value)
    return value.reason === "github_installation_identity_refused" ||
      value.reason === "personal_login_required"
      ? { state: "refused", reason: value.reason }
      : waiting(value.reason);
  if (value.status === 401 || value.status === 403)
    return { state: "refused", reason: "github_installation_consent_refused" };
  return value.status === 200
    ? null
    : waiting("github_installation_status_unavailable");
}

/** Every reported installation must have a fresh live installation/App-permission probe.
 * This proves installation connectivity, not access to repositories selected later in Q3. */
function observation(body: unknown, now: number): OnboardStepResult {
  const row = object(body);
  if (
    !row ||
    typeof row.connected !== "boolean" ||
    !Array.isArray(row.installations) ||
    !Array.isArray(row.pending) ||
    row.installations.length + row.pending.length > 100
  )
    return waiting("github_installation_status_shape");
  const ids: string[] = [];
  const granted: string[] = [];
  let outdated: OnboardStepResult | undefined;
  let permissionsUnverified = false;
  let unknown = false;
  let allConnected = row.installations.length > 0;
  let checkedAt = now + 30_000;
  for (const value of row.installations) {
    const item = object(value);
    const verification = object(item?.verification);
    if (
      !item ||
      typeof item.installationId !== "string" ||
      !idPattern.test(item.installationId) ||
      ids.includes(item.installationId) ||
      !nullableText(item.githubOrg) ||
      (typeof item.githubOrg === "string" &&
        !orgPattern.test(item.githubOrg)) ||
      !verification
    )
      return waiting("github_installation_status_shape");
    ids.push(item.installationId);
    if (
      verification.source === "none" &&
      verification.state === "not-run" &&
      verification.checkedAt === null
    ) {
      unknown = true;
      allConnected = false;
      continue;
    }
    if (
      verification.source !== "live-probe" ||
      typeof verification.state !== "string" ||
      !states.has(verification.state) ||
      typeof verification.checkedAt !== "number" ||
      !Number.isFinite(verification.checkedAt) ||
      verification.checkedAt < now - 120_000 ||
      verification.checkedAt > now + 30_000
    )
      return waiting("github_installation_status_shape");
    if (
      verification.missing !== undefined &&
      (!Array.isArray(verification.missing) ||
        verification.missing.length > 128 ||
        !verification.missing.every(
          (name) =>
            typeof name === "string" &&
            (/^[A-Za-z0-9_-]{1,128}$/.test(name) ||
              GITHUB_PERMISSION.test(name)),
        ))
    )
      return waiting("github_installation_status_shape");
    checkedAt = Math.min(checkedAt, verification.checkedAt);
    if (verification.state === "unreachable") unknown = true;
    if (verification.state !== "connected") allConnected = false;
    // CTC-4629: the typed verdict must agree with the verification it was derived from.
    const org = typeof item.githubOrg === "string" ? item.githubOrg : null;
    const permissions = parsePermissions(item.permissions, {
      grant: "github-installation",
      action: "review-permissions",
      label: GITHUB_PERMISSION,
      actorFor: (url) =>
        githubInstallationPage(url, item.installationId as string, org, true)
          ?.actor ?? null,
    });
    if (
      permissions === null ||
      (permissions?.state === "current" &&
        verification.state !== "connected") ||
      (permissions?.state === "outdated" &&
        verification.state !== "missing-scope")
    )
      return waiting("github_installation_status_shape");
    if (permissions?.state === "current")
      granted.push(`${org ?? item.installationId}: ${permissions.granted.join(", ")}`);
    if (permissions?.state === "unknown") permissionsUnverified = true;
    if (permissions?.state === "outdated" && !outdated)
      outdated = permissionsOutdated(item.installationId as string, org, permissions);
  }
  for (const value of row.pending) {
    const pending = object(value);
    if (
      !pending ||
      !nullableText(pending.githubOrg) ||
      (typeof pending.githubOrg === "string" &&
        !orgPattern.test(pending.githubOrg)) ||
      typeof pending.requestedAt !== "number" ||
      !Number.isFinite(pending.requestedAt) ||
      pending.requestedAt < 0
    )
      return waiting("github_installation_status_shape");
  }
  if (row.connected !== allConnected)
    return waiting("github_installation_status_shape");
  const coverage = repositoryCoverage(row.repositories, ids);
  if (coverage === null) return waiting("github_installation_status_shape");
  if (unknown) return waiting("github_installation_status_unavailable");
  if (outdated) return outdated;
  // CTC-4680 round 5: a request already waiting for an org owner on GitHub is not a new install.
  if (row.installations.length === 0 && row.pending.length > 0) {
    const org = object(row.pending[0])?.githubOrg;
    return {
      state: "waiting",
      reason: "github_installation_approval_pending",
      evidence: {
        provider: "github",
        ...(typeof org === "string" ? { org } : {}),
      },
    };
  }
  if (!allConnected) return { state: "pending" };
  if (permissionsUnverified) return waiting("github_app_permissions_unverified");
  if (coverage) return coverage;
  return {
    state: "done",
    evidence: {
      provider: "github",
      installation: JSON.stringify(ids),
      checkedAt,
      ...(granted.length ? { granted: granted.join("; ") } : {}),
    },
  };
}

/** A wait whose fix is a page on github.com: polling longer cannot finish it. */
const githubSideAction = (result: OnboardStepResult) =>
  result.state === "waiting" &&
  (result.reason === "github_app_permissions_outdated" ||
    result.reason === "github_app_repository_missing" ||
    result.reason === "github_app_permissions_unverified" ||
    result.reason === "github_app_repository_access_unverified");

/** A pending permission request is the org's to accept on GitHub, never a new installation. */
function permissionsOutdated(
  installation: string,
  org: string | null,
  permissions: Extract<PermissionsVerdict, { state: "outdated" }>,
): OnboardStepResult {
  const login = githubInstallationPage(new URL(permissions.url), installation, org, true)?.login;
  const name = org ?? login;
  return {
    state: "waiting",
    reason: "github_app_permissions_outdated",
    evidence: {
      provider: "github",
      grant: "github-installation",
      installation,
      ...(name ? { org: name } : {}),
      granted: permissions.granted.join(", "),
      missing: permissions.missing.join(", "),
      url: permissions.url,
      actor: permissions.actor,
    },
  };
}

/** CTC-4629: whether the installations reach every repository the account's projects register.
 * `undefined` when covered or when an older cloud sent no verdict; `null` for a malformed one. */
function repositoryCoverage(
  value: unknown,
  installations: readonly string[],
): OnboardStepResult | null | undefined {
  if (value === undefined) return undefined;
  const row = object(value);
  if (!row) return null;
  if (row.state === "unknown")
    return typeof row.reason === "string" && coverageUnknown.has(row.reason)
      ? waiting("github_app_repository_access_unverified")
      : null;
  const names = (list: unknown): list is string[] =>
    Array.isArray(list) &&
    list.length <= 50 &&
    list.every((name) => typeof name === "string" && repositoryPattern.test(name));
  if (!names(row.checked)) return null;
  const checked = row.checked;
  if (row.state === "covered")
    return row.missing === undefined && row.unchecked === undefined ? undefined : null;
  if (
    row.state !== "missing" ||
    !Array.isArray(row.missing) ||
    row.missing.length < 1 ||
    row.missing.length > 50 ||
    !Array.isArray(row.unchecked) ||
    row.unchecked.length > 50 ||
    !row.unchecked.every((value) => {
      const item = object(value);
      return (
        !!item &&
        names([item.repository]) &&
        !checked.includes(item.repository as string) &&
        typeof item.reason === "string" &&
        coverageUnknown.has(item.reason)
      );
    })
  )
    return null;
  const results: OnboardStepResult[] = [];
  for (const value of row.missing) {
    const item = object(value);
    if (
      !item ||
      typeof item.repository !== "string" ||
      !repositoryPattern.test(item.repository) ||
      !checked.includes(item.repository) ||
      !nullableText(item.githubOrg) ||
      (typeof item.githubOrg === "string" && !orgPattern.test(item.githubOrg))
    )
      return null;
    const org = item.githubOrg as string | null;
    if (item.installationId === null) {
      if (item.settingsUrl !== null || item.actor !== null) return null;
      results.push({
        state: "pending",
        reason: "github_app_repository_not_installed",
        evidence: {
          provider: "github",
          repository: item.repository,
          ...(org ? { org } : {}),
        },
      });
      continue;
    }
    if (
      typeof item.installationId !== "string" ||
      !installations.includes(item.installationId) ||
      typeof item.settingsUrl !== "string" ||
      item.settingsUrl.length > 2048
    )
      return null;
    let url: URL;
    try {
      url = new URL(item.settingsUrl);
    } catch {
      return null;
    }
    const page = githubInstallationPage(url, item.installationId, org, false);
    if (!page || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || page.actor !== item.actor) return null;
    results.push({
      state: "waiting",
      reason: "github_app_repository_missing",
      evidence: {
        provider: "github",
        installation: item.installationId,
        ...(org ? { org } : {}),
        repository: item.repository,
        url: url.toString(),
        actor: page.actor,
      },
    });
  }
  // A repository an existing installation lacks is fixed on GitHub; one with no installation at all
  // is this step's own install action, which runs only once nothing else waits.
  return results.find((result) => result.state === "waiting") ?? results[0];
}

function safeHandoff(body: unknown, ctx: Ctx): string | null {
  const row = object(body);
  const cfg = loadConfig(ctx.home);
  if (
    !cfg ||
    !row ||
    typeof row.authorizationUrl !== "string" ||
    row.authorizationUrl.length > 8192 ||
    /[\u0000-\u0020\u007f]/.test(row.authorizationUrl) ||
    typeof row.expiresAt !== "number" ||
    !Number.isFinite(row.expiresAt)
  )
    return null;
  const remaining = row.expiresAt - ctx.now().getTime();
  // Thirty seconds accommodates clock skew; an expired link is never launched.
  if (remaining <= 0 || remaining > 630_000) return null;
  try {
    const url = new URL(row.authorizationUrl);
    const keys = [...url.searchParams.keys()];
    const handoff = url.searchParams.get("handoff");
    if (
      url.protocol !== "https:" ||
      url.origin !== new URL(normalizeBaseUrl(cfg.baseUrl)).origin ||
      url.username ||
      url.password ||
      url.pathname !== HANDOFF ||
      url.hash ||
      keys.length !== 1 ||
      keys[0] !== "handoff" ||
      !handoff ||
      handoff.length > 4096 ||
      /[\s\u0000-\u001f\u007f]/.test(handoff)
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Uses personal bearer App-install routes. Older clouds wait without a browser/session fallback. */
export function githubInstallationAdapter(
  options: GithubInstallationOptions,
): OnboardAdapter {
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const consentTimeoutMs = options.consentTimeoutMs ?? 600_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(consentTimeoutMs) ||
    consentTimeoutMs < 1 ||
    consentTimeoutMs > 600_000
  )
    throw new Error("github_installation_timeout_invalid");
  const inspect = async (
    ctx: Ctx,
    journal: OnboardJournal,
    signal?: AbortSignal,
  ): Promise<WorkspaceObservation> => {
    const result = await read(ctx, journal, STATUS, timeoutMs, signal);
    if ("status" in result && [404, 405].includes(result.status))
      return {
        result: waiting("cloud_capability_unavailable"),
        unsupported: true,
      };
    const failure = readFailure(result);
    return {
      result:
        failure ??
        observation(
          "body" in result ? result.body : undefined,
          ctx.now().getTime(),
        ),
    };
  };
  return {
    check: async (ctx, journal, signal) =>
      (await inspect(ctx, journal, signal)).result,
    act: async (ctx, journal, signal) => {
      const cfg = loadConfig(ctx.home);
      if (!cfg?.user || !["owner", "admin"].includes(cfg.user.role))
        return {
          state: "refused",
          reason: "github_installation_admin_required",
        };
      if (signal?.aborted) return waiting("interrupted");
      const before = await inspect(ctx, journal, signal);
      if (before.result.state !== "pending") return before.result;
      if (before.unsupported) return waiting("cloud_capability_unavailable");
      if (!options.wait) return waiting("github_installation_approval_required");
      const start = await read(
        ctx,
        journal,
        `${STATUS}/start`,
        timeoutMs,
        signal,
      );
      if ("status" in start && [404, 405].includes(start.status))
        return waiting("cloud_capability_unavailable");
      const failure = readFailure(start);
      if (failure) return failure;
      const url = safeHandoff("body" in start ? start.body : undefined, ctx);
      if (!url)
        return {
          state: "refused",
          reason: "github_installation_consent_handoff",
        };
      if (signal?.aborted) return waiting("interrupted");
      const current = loadConfig(ctx.home);
      if (
        !current?.user ||
        current.account !== cfg.account ||
        current.user.id !== cfg.user.id ||
        normalizeBaseUrl(current.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
      )
        return {
          state: "refused",
          reason: "github_installation_identity_refused",
        };
      if (!["owner", "admin"].includes(current.user.role))
        return {
          state: "refused",
          reason: "github_installation_admin_required",
        };
      // The signed URL is transient credential material: only the browser receives it.
      ctx.stderr(GITHUB_CONFIRM_ACCESS);
      let browserUnavailable = false;
      try {
        await options.openBrowser(url, signal);
      } catch {
        if (signal?.aborted) return waiting("interrupted");
        browserUnavailable = true;
        ctx.stderr(finishOnTheWeb(current.baseUrl, "github-install", "install Catalyst on your GitHub organization"));
      }
      let latest: OnboardStepResult = waiting(
        "github_installation_status_unavailable",
      );
      const run = () =>
        pollConsent({
          timeoutMs: consentTimeoutMs,
          signal,
          sleep: options.sleep,
          readStatus: async (pollSignal) => {
            const value = await inspect(ctx, journal, pollSignal);
            latest = value.result;
            if (value.unsupported)
              return {
                outcome: "waiting",
                reason: "cloud_capability_unavailable",
              };
            if (
              latest.reason === "github_installation_login_refresh_required" ||
              githubSideAction(latest)
            )
              return { outcome: "waiting", reason: latest.reason };
            if (latest.state === "done") return { outcome: "connected" };
            if (latest.state === "refused" || latest.state === "failed")
              return { outcome: latest.state, reason: latest.reason };
            return {
              outcome: latest.state === "pending" ? "absent" : "unavailable",
            } satisfies ConsentStatus;
          },
        });
      const result = options.wait
        ? await options.wait("Waiting for GitHub App approval", run)
        : await run();
      // An installation that now exists but still needs a GitHub-side change keeps its action URL.
      if (result.state === "done" || githubSideAction(latest)) return latest;
      return browserUnavailable && result.reason === "consent_timeout"
        ? waiting("github_installation_browser_unavailable")
        : result;
    },
  };
}

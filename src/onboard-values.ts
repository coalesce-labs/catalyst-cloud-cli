import { loadConfig, type Ctx } from "./config.js";
import type { ContractReadinessCheck, ContractTeam } from "./contract-types.js";
import { selectedOnboardTeam } from "./onboard-existing.js";
import { loadFreshTeamContract } from "./onboard-readiness-fresh.js";
import type { OnboardAdapter, OnboardStepResult } from "./onboard.js";
import { valuesFacts } from "./ready-copy.js";

const waiting = (
  reason: string,
  evidence?: OnboardStepResult["evidence"],
): OnboardStepResult => ({
  state: "waiting",
  reason,
  ...(evidence ? { evidence } : {}),
});

/** How long setup waits for the cloud to read a repository's settings, and how often it looks. */
export const VALUES_WAIT_MS = 60_000;
const VALUES_POLL_MS = 10_000;
/** While waiting, one slow read-through can't stretch "up to 1 minute". */
const WAIT_READ_TIMEOUT_MS = 10_000;

type Reading =
  | { kind: "pass" }
  | { kind: "fail"; check: ContractReadinessCheck }
  | { kind: "unread"; repositories: string[] }
  | { kind: "unverified" };

/** The repositories a team's verdict covers, by name, for the one waiting line. */
function teamRepositories(team: ContractTeam | undefined, check?: ContractReadinessCheck): string[] {
  const fromCheck = check ? (valuesFacts(check).repos ?? []).map((row) => row.repo) : [];
  if (fromCheck.length) return fromCheck;
  const registered = (team as { repositories?: { registered?: unknown } } | undefined)?.repositories
    ?.registered;
  return Array.isArray(registered)
    ? registered.filter((name): name is string => typeof name === "string")
    : [];
}

function named(repositories: readonly string[]): string {
  if (!repositories.length) return "this team's repositories";
  if (repositories.length === 1) return repositories[0]!;
  return `${repositories[0]} and ${repositories.length - 1} more`;
}

/** The selected team's `required_values` readiness check decides this step. It passes when the
 * selected repositories declare no required value, or every one has a value. Nothing here reads,
 * imports or prints a value: a missing one is named, with the page where it is set.
 *
 * CTC-4744: the verdict is asked for fresh first (it lasts five minutes and only a readiness read
 * recomputes it). When the cloud has not read the settings yet, setup waits up to a minute on one
 * line, instead of telling the person to run setup again. */
export function onboardValuesAdapter(
  deps: {
    message?: (text: string) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): OnboardAdapter {
  return {
    check: async (ctx: Ctx, journal, signal) => {
      const cfg = loadConfig(ctx.home);
      const teamId = selectedOnboardTeam(journal);
      if (!cfg || !teamId) return waiting("required_values_unverified");
      const read = async (timeoutMs?: number, readSignal = signal): Promise<Reading> => {
        let loaded: Awaited<ReturnType<typeof loadFreshTeamContract>>;
        try {
          // The contract transport owns another timeout. Carry our caller's cancellation through
          // its fetch too, including response-body reads and any credential refresh.
          const readCtx: Ctx = readSignal
            ? {
                ...ctx,
                fetch: (input, init) =>
                  ctx.fetch(input, {
                    ...init,
                    signal: init?.signal
                      ? AbortSignal.any([readSignal, init.signal])
                      : readSignal,
                  }),
              }
            : ctx;
          loaded = await loadFreshTeamContract(readCtx, cfg, [teamId], readSignal, timeoutMs);
        } catch {
          return { kind: "unverified" };
        }
        if (loaded.source === "cache") return { kind: "unverified" };
        const team = loaded.doc.teams.find((row) => row.id === teamId);
        const readiness = team?.readiness;
        const fresh =
          readiness?.checkedAt != null &&
          readiness.expiresAt != null &&
          readiness.expiresAt > ctx.now().getTime();
        // A verdict the cloud could not bring up to date says nothing either way.
        if (!readiness || !fresh) return { kind: "unverified" };
        const check = readiness.checks.find((row) => row.id === "required_values");
        // An older cloud may not send this check at all: that says nothing, it is not an unread.
        if (!check) return { kind: "unverified" };
        if (check.state === "pass") return { kind: "pass" };
        if (check.state === "fail") return { kind: "fail", check };
        return { kind: "unread", repositories: teamRepositories(team, check) };
      };
      let reading = await read();
      if (reading.kind === "unread" && deps.sleep) {
        deps.message?.(
          `Waiting for Catalyst to read the settings of ${named(reading.repositories)} (up to 1 minute)…`,
        );
        // One deadline covers sleep, readiness refresh and contract/body reads. Attempts also
        // bound an injected sleep whose clock stands still.
        const deadline = Date.now() + VALUES_WAIT_MS;
        const owned = new AbortController();
        const waitSignal = signal ? AbortSignal.any([signal, owned.signal]) : owned.signal;
        let stop = () => {};
        const stopped = new Promise<null>((resolve) => {
          stop = () => {
            owned.abort();
            resolve(null);
          };
        });
        const timer = setTimeout(stop, VALUES_WAIT_MS);
        signal?.addEventListener("abort", stop, { once: true });
        try {
          if (signal?.aborted) stop();
          for (
            let attempt = 0;
            reading.kind === "unread" &&
            attempt < VALUES_WAIT_MS / VALUES_POLL_MS &&
            Date.now() < deadline &&
            !waitSignal.aborted;
            attempt++
          ) {
            // Ctrl-C or expiry ends either stage at once, even if an injected promise stalls.
            await Promise.race([
              deps.sleep(Math.min(VALUES_POLL_MS, Math.max(0, deadline - Date.now()))),
              stopped,
            ]);
            if (waitSignal.aborted || Date.now() >= deadline) break;
            const next = await Promise.race([
              read(Math.min(WAIT_READ_TIMEOUT_MS, deadline - Date.now()), waitSignal),
              stopped,
            ]);
            // A result after expiry says nothing about the last observed unread verdict.
            if (waitSignal.aborted || Date.now() >= deadline || !next) break;
            reading = next;
          }
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          owned.abort();
        }
      }
      if (signal?.aborted) return waiting("interrupted");
      if (reading.kind === "pass") return { state: "done", evidence: { team: teamId } };
      if (reading.kind === "fail")
        return waiting("required_values_missing", {
          team: teamId,
          requiredValues: JSON.stringify(valuesFacts(reading.check)),
        });
      if (reading.kind === "unread")
        return waiting("required_values_unread", {
          team: teamId,
          repositories: named(reading.repositories),
        });
      return waiting("required_values_unverified");
    },
  };
}

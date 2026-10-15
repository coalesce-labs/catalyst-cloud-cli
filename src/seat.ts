import { randomUUID } from "node:crypto";
import { flagString, positionals, type ParsedArgs } from "./args.js";
import { DEFAULT_BASE_URL, requireConfig, type Ctx } from "./config.js";
import { UsageError } from "./errors.js";
import { ApiClient, apiClient } from "./transport.js";

const HARNESSES = new Set(["claude", "codex", "opencode"]);

/** The full response goes to stdout for a launcher to capture in an owner-only file. */
export async function cmdSeat(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [action, ...extra] = positionals(args);
  if (action !== "checkout" || extra.length > 0)
    throw new UsageError("seat checkout --size big|med --harness claude,codex,opencode [--session-id ID] [--stage STAGE]");
  const size = flagString(args, "size");
  const stage = flagString(args, "stage");
  if (size !== undefined && size !== "big" && size !== "med")
    throw new UsageError("--size must be big or med");
  if (size === undefined && stage === undefined)
    throw new UsageError("--size or --stage is required");
  const harnesses = flagString(args, "harness")?.split(",");
  if (!harnesses || harnesses.length === 0 || harnesses.some((h) => !HARNESSES.has(h)))
    throw new UsageError("--harness must list claude, codex or opencode, separated by commas");
  const sessionId = flagString(args, "session-id") ?? randomUUID();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId))
    throw new UsageError("--session-id must be one token of at most 128 letters, digits, dots, underscores or hyphens");
  const keyEnv = flagString(args, "key-env");
  if (keyEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(keyEnv))
    throw new UsageError("--key-env must name an uppercase environment variable");
  const key = keyEnv === undefined ? undefined : ctx.env[keyEnv];
  if (keyEnv !== undefined && !key) throw new UsageError(`--key-env ${keyEnv} is empty`);
  const api = key === undefined
    ? apiClient(requireConfig(ctx), ctx)
    : new ApiClient(ctx.env.CATALYST_CLOUD_BASE_URL ?? DEFAULT_BASE_URL, async () => key, ctx.fetch);
  const response = await api.postJson<{
    outcome: string;
    reason?: string;
    [key: string]: unknown;
  }>("/api/v1/agent/credential-checkout", {
    sessionId,
    ...(size === undefined ? {} : { size }),
    ...(stage === undefined ? {} : { stage }),
    harnesses,
  }, { accept: [409] });
  if (response.status !== 200 || response.body.outcome !== "issued") {
    ctx.stderr(`seat checkout refused: ${response.body.reason ?? "unexpected response"}`);
    return 2;
  }
  ctx.stdout(JSON.stringify({ ...response.body, sessionId }));
  return 0;
}

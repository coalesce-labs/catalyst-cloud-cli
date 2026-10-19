// shell-pull.ts — how `catalyst env shell` downloads an image it does not have. Credential-free
// first: Catalyst's own image is public, so that is the whole story for it and the cloud is never
// asked. Only when that is refused, and only for a signed-in person whose contract serves the route,
// does it ask the workspace for a short-lived download credential, use it for that one pull, and only
// for the repository the credential covers. The password lives in the throwaway config file alone.
import type { Ctx } from "../config.js";
import { loadConfig } from "../config.js";
import { loadContract } from "../contract.js";
import type { TenantContract } from "../contract-types.js";
import { RUNNER_HOST_IMAGES } from "../onboard-runner.js";
import { readLocalRepositoryName } from "../onboard-settings-context.js";
import { apiClient } from "../transport.js";
import type { DockerConfigJson, EnvShellDocker } from "./shell-docker.js";

export interface ShellRefusal {
  code: string;
  message: string;
  names?: string[];
}

/** A non-empty `auths`, so the Docker CLI does not fall back to the platform's credential store. */
export const CREDENTIAL_FREE_CONFIG: DockerConfigJson = { auths: { "https://index.docker.io/v1/": {} } };
export const PULL_USERNAME = "x-catalyst-pull";

/** Docker's rule: the first path component is a registry when it has a "." or ":" or is "localhost". */
export function registryOf(ref: string): string {
  const name = ref.split("@", 1)[0] ?? ref;
  const slash = name.indexOf("/");
  if (slash < 0) return "docker.io";
  const first = name.slice(0, slash);
  return first.includes(".") || first.includes(":") || first === "localhost" ? first : "docker.io";
}

/** The contract's own path for the credential route: POST, ending in `/registry/pull-credential`. */
export function pullCredentialRoute(doc: TenantContract): string | null {
  return doc.routes.find((r) => r.method === "POST" && r.path.endsWith("/registry/pull-credential"))?.path ?? null;
}

export interface PullCredential {
  registry: string;
  repository: string;
  username: typeof PULL_USERNAME;
  password: string;
  expiresAtMs: number;
}

const REGISTRY_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[0-9]{1,5})?$/;
const REPOSITORY_RE = /^[a-z0-9]+(?:(?:[._-]|__)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._-]|__)[a-z0-9]+)*)*$/;
const PASSWORD_RE = /^[\x21-\x7e]{8,4096}$/;

/** Strict: anything but the CTC-2565 answer shapes is `invalid`, never a partial credential. */
export function parsePullCredential(
  body: unknown,
  nowMs: number,
): { kind: "issued"; credential: PullCredential } | { kind: "refused"; refusal: string } | { kind: "invalid" } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { kind: "invalid" };
  const answer = body as Record<string, unknown>;
  if (answer.issued === false)
    return typeof answer.refusal === "string" && /^[a-z_]{1,64}$/.test(answer.refusal)
      ? { kind: "refused", refusal: answer.refusal }
      : { kind: "invalid" };
  if (answer.issued !== true) return { kind: "invalid" };
  const { registry, repository, username, password, expiresAtMs } = answer;
  if (
    typeof registry !== "string" ||
    !REGISTRY_HOST_RE.test(registry) ||
    typeof repository !== "string" ||
    repository.length > 255 ||
    !REPOSITORY_RE.test(repository) ||
    username !== PULL_USERNAME ||
    typeof password !== "string" ||
    !PASSWORD_RE.test(password) ||
    typeof expiresAtMs !== "number" ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= nowMs
  )
    return { kind: "invalid" };
  return { kind: "issued", credential: { registry, repository, username, password, expiresAtMs } };
}

/** Covers only `<registry>/<repository>[:tag]@sha256:…`, never a sibling that shares a prefix. */
export function credentialCovers(ref: string, credential: Pick<PullCredential, "registry" | "repository">): boolean {
  const prefix = `${credential.registry}/${credential.repository}`;
  if (!ref.startsWith(prefix)) return false;
  return /^(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?@sha256:[0-9a-f]{64}$/.test(ref.slice(prefix.length));
}

const REFUSAL_REASONS: Record<string, string> = {
  disabled: "download credentials are not turned on for your workspace",
  not_configured: "download credentials are not turned on for your workspace",
};

function withoutStop(text: string): string {
  return text.replace(/[.\s]+$/, "");
}

export async function downloadImage(input: {
  ref: string;
  host: string;
  root: string;
  ctx: Ctx;
  docker: EnvShellDocker;
  notify: (line: string) => void;
  readRepositoryName?: (root: string) => Promise<string | null>;
}): Promise<{ ok: true; credential: "none" | "issued" } | { ok: false; refusal: ShellRefusal }> {
  const { ref, host, ctx, docker, notify } = input;
  notify(
    ref === RUNNER_HOST_IMAGES.runner
      ? "  Downloading it with no credential (about 2.3 GB, once per image)…"
      : "  Downloading it with no credential…",
  );
  const anonymous = await docker.pull(ref, host, CREDENTIAL_FREE_CONFIG);
  if (anonymous.ok) {
    notify("  Downloaded.");
    return { ok: true, credential: "none" };
  }
  const refused = `Could not download ${ref} with no credential: ${withoutStop(anonymous.detail) || "docker pull failed"}.`;
  const refuse = (code: string, message: string) => ({ ok: false as const, refusal: { code, message } });

  const cfg = loadConfig(ctx.home);
  if (!cfg)
    return refuse(
      "image_download_refused",
      `${refused} If this image needs your workspace's permission, sign in with catalyst login and run this again.`,
    );
  const credentialRefused = (reason: string) =>
    refuse("credential_refused", `Your workspace did not issue a download credential for ${ref}: ${reason}.`);
  let route: string | null;
  try {
    route = pullCredentialRoute((await loadContract(ctx, cfg)).doc);
  } catch (error) {
    return credentialRefused(withoutStop(error instanceof Error ? error.message : String(error)));
  }
  if (!route)
    return refuse("image_download_refused", `${refused} Your Catalyst Cloud does not issue download credentials.`);
  const repositoryName = await (input.readRepositoryName ?? readLocalRepositoryName)(input.root);
  const [owner, name, ...extra] = repositoryName?.split("/") ?? [];
  if (!owner || !name || extra.length > 0)
    return refuse(
      "repository_unknown",
      "This checkout's origin is not a GitHub repository, so your workspace cannot issue it a download credential.",
    );

  notify("  The download needs permission. Asking your workspace for a short-lived download credential…");
  let body: unknown;
  try {
    body = (await apiClient(cfg, ctx).postJson(route, { owner, name }, { accept: [200] })).body;
  } catch {
    return credentialRefused("the request was refused");
  }
  const nowMs = ctx.now().getTime();
  const answer = parsePullCredential(body, nowMs);
  if (answer.kind === "invalid") return credentialRefused("the answer was not understood");
  if (answer.kind === "refused")
    return credentialRefused(
      answer.refusal === "unknown_repository"
        ? `${owner}/${name} is not a repository in your workspace`
        : (REFUSAL_REASONS[answer.refusal] ?? "the request was refused"),
    );
  const credential = answer.credential;
  if (!credentialCovers(ref, credential))
    return refuse(
      "credential_out_of_scope",
      `Your workspace issued a download credential for ${credential.registry}/${credential.repository}, which does not cover ${ref}. Nothing was sent to ${registryOf(ref)}.`,
    );
  const minutes = Math.max(1, Math.floor((credential.expiresAtMs - nowMs) / 60_000));
  notify(`  Downloading it with a short-lived credential your workspace issued (valid for ${minutes} minutes)…`);
  const auth = Buffer.from(`${credential.username}:${credential.password}`).toString("base64");
  const issued = await docker.pull(ref, host, { auths: { [credential.registry]: { auth } } });
  if (issued.ok) {
    notify("  Downloaded.");
    return { ok: true, credential: "issued" };
  }
  const detail = withoutStop(issued.detail.split(credential.password).join("[redacted]").split(auth).join("[redacted]"));
  return refuse(
    "image_download_refused",
    `Could not download ${ref} with the credential your workspace issued: ${detail || "docker pull failed"}.`,
  );
}

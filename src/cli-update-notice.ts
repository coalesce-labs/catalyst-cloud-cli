import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configDirFor, publishedCachePathFor, type Ctx } from "./config.js";
import { newestCliVersion } from "./published.js";
import { semverOlder } from "./semver.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RELEASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** A notice never installs anything, shares setup's frame or writes machine-readable stdout. */
export async function maybePrintPublishedUpdateNotice(
  ctx: Ctx,
  options: {
    interactive: boolean;
    json: boolean;
    command: string;
    version: string;
  },
): Promise<void> {
  if (
    !options.interactive ||
    options.json ||
    options.command === "setup" ||
    options.command === "onboard"
  )
    return;
  const directory = configDirFor(ctx.home);
  const state = join(directory, "update-notice.json");
  const published = publishedCachePathFor(ctx.home);
  const now = ctx.now();
  if (!Number.isFinite(now.getTime())) return;
  try {
    // Optional metadata must not follow a user-created link or replace a special file.
    for (const path of [
      join(ctx.home, ".config"),
      directory,
      state,
      published,
      `${published}.tmp`,
    ]) {
      try {
        const info = lstatSync(path);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
          return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      }
    }
    try {
      const previous: unknown = JSON.parse(readFileSync(state, "utf8"));
      if (
        previous &&
        typeof previous === "object" &&
        "checkedAt" in previous &&
        typeof previous.checkedAt === "string"
      ) {
        const age = now.getTime() - Date.parse(previous.checkedAt);
        if (age >= 0 && age < DAY_MS) return;
      }
    } catch {
      /* Missing or malformed optional metadata can be refreshed. */
    }
    mkdirSync(directory, { recursive: true });
    const temporary = `${state}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({ version: 1, checkedAt: now.toISOString() }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      renameSync(temporary, state);
    } finally {
      rmSync(temporary, { force: true });
    }
    // Record the attempt before the bounded lookup, including failures, so offline commands do
    // not repeatedly contact npm. Reuse ready's anonymous request and version cache. Once this
    // install has read an approved release, that is the version named (CTC-6708).
    const reply = await newestCliVersion(ctx);
    if (
      reply.latest &&
      RELEASE.test(reply.latest) &&
      semverOlder(options.version, reply.latest)
    ) {
      ctx.stderr(
        reply.source === "approved"
          ? `Catalyst ${reply.latest} is approved for this workspace. Update with: catalyst update`
          : `Catalyst ${reply.latest} is out. Update with: npm install -g @catalyst-cloud/cli@latest`,
      );
    }
  } catch {
    /* An optional update notice must never stop the requested command. */
  }
}

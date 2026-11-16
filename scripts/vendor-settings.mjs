#!/usr/bin/env node
// Generate the shared whole-file validator. Never hand-edit vendor/settings/index.js.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = "ac9fd5d07d717d1f15cac931dc2e7af796cd0e39";
const target = join(root, "vendor/settings");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const declaration = `export type FullSettingsValidation =
  | { ok: false; errors: string[] }
  | { ok: true; errors: []; linearTeam: string; variableNames: string[]; secretNames: string[] };
export declare function validateFullSettings(text: string): FullSettingsValidation;
`;
// Raw validator issues can contain user keys, literals or secret material. This boundary returns
// a fixed error only; on success it projects validated identifiers rather than the settings tree.
const entry = `import { validateCatalystSettings } from "./packages/settings/src/validate.ts";
export function validateFullSettings(text) {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 1048576)
      return { ok: false, errors: ["Settings file could not be fully validated"] };
    const result = validateCatalystSettings(text);
    if (!result.ok || !result.settings?.project)
      return { ok: false, errors: ["Settings file could not be fully validated"] };
    const entries = result.environment?.environment ?? [];
    return { ok: true, errors: [], linearTeam: result.settings.project.linear_team,
      variableNames: entries.filter((entry) => entry.secret !== true).map((entry) => entry.name).sort(),
      secretNames: entries.filter((entry) => entry.secret === true).map((entry) => entry.name).sort() };
  } catch {
    return { ok: false, errors: ["Settings file could not be fully validated"] };
  }
}
`;
const sourceRepo = process.env.CATALYST_SETTINGS_SOURCE;
const check = process.argv.includes("--check");
if (!sourceRepo && check) {
  const provenance = JSON.parse(
    readFileSync(join(target, "provenance.json"), "utf8"),
  );
  if (provenance.commit !== commit || provenance.entrySha256 !== sha(entry))
    throw new Error("Unexpected settings validator provenance");
  for (const [file, hash] of Object.entries(provenance.runtimeSha256)) {
    if (sha(readFileSync(join(target, file))) !== hash)
      throw new Error(`Generated settings drift: ${file}`);
  }
  process.exit(0);
}
if (!sourceRepo)
  throw new Error(
    "Set CATALYST_SETTINGS_SOURCE to a checkout containing the pinned cloud commit",
  );
if (
  execFileSync("bun", ["--version"], { encoding: "utf8" }).trim() !== "1.3.14"
)
  throw new Error("Generate settings with Bun 1.3.14 for deterministic output");
mkdirSync(join(root, "node_modules"), { recursive: true });
const temporary = mkdtempSync(join(root, "node_modules/.settings-vendor-"));
const provenance = {
  repository: "coalesce-labs/catalyst-cloud",
  commit,
  bundler: "bun@1.3.14",
  entrySha256: sha(entry),
  sourceSha256: {},
  runtimeSha256: {},
};
try {
  const paths = execFileSync(
    "git",
    [
      "-C",
      sourceRepo,
      "ls-tree",
      "-r",
      "--name-only",
      commit,
      "packages/settings",
      "packages/environment",
      "packages/protocol",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(
      (file) =>
        (/\/src\/.+\.ts$/.test(file) && !/\.(test|spec)\.ts$/.test(file)) ||
        /\/package\.json$/.test(file),
    )
    .sort();
  for (const file of paths) {
    const bytes = execFileSync("git", [
      "-C",
      sourceRepo,
      "show",
      `${commit}:${file}`,
    ]);
    const dest = join(temporary, file);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    provenance.sourceSha256[file] = sha(bytes);
  }
  mkdirSync(join(temporary, "node_modules/@catalyst-cloud"), {
    recursive: true,
  });
  for (const name of ["environment", "protocol"])
    symlinkSync(
      join(temporary, "packages", name),
      join(temporary, "node_modules/@catalyst-cloud", name),
    );
  writeFileSync(join(temporary, "entry.ts"), entry);
  execFileSync(
    "bun",
    [
      "build",
      "./entry.ts",
      "--target=node",
      "--external=smol-toml",
      "--external=yaml",
      "--outfile",
      "./index.js",
    ],
    { cwd: temporary, stdio: "inherit" },
  );
  const outputs = {
    "index.js": readFileSync(join(temporary, "index.js")),
    "index.d.ts": Buffer.from(declaration),
  };
  for (const [file, bytes] of Object.entries(outputs))
    provenance.runtimeSha256[file] = sha(bytes);
  outputs["provenance.json"] = Buffer.from(
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  mkdirSync(target, { recursive: true });
  for (const [file, bytes] of Object.entries(outputs)) {
    if (check) {
      if (!bytes.equals(readFileSync(join(target, file))))
        throw new Error(`Generated settings drift: ${file}`);
    } else writeFileSync(join(target, file), bytes);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

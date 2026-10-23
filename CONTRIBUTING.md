# Contributing

## Development

```sh
bun install
bun run typecheck
bun run test
```

Installing from a git ref (`npm install -g github:coalesce-labs/catalyst-cloud-skills#<branch>`) does **not** give you the CLI, and no document offers it as a way in. npm runs `prepare` in the clone with no `node_modules` at all, so there is no compiler to build `dist/` with; the install now fails loudly and leaves nothing on PATH, which is the whole fix — before 0.2.1 it exited 0 and wrote a `catalyst-skills` shim pointing at a file that was never packed. To try an unreleased branch, clone it and `npm install && npm link`. `test/git-install-rail.test.ts` holds this: if npm ever starts giving `prepare` a toolchain, the rail has to work all the way to a runnable shim before the README may advertise it.

The skills under `skills/` are the source of truth for the published package. The `files` field in `package.json` ships them verbatim, and the customer's own agent installs them: the Claude Code plugin reads them from `.claude-plugin/plugin.json`, and `npx skills add` copies them. The CLI's `install` verb copies the same directories as a repair path. Edit them here and nowhere else.

They are product copy. Before you change a skill, the README or an eval case, read `.agents/rules/public-text.md`: published text describes AI accounts as token-billed and never names any other kind, and `test/public-text.test.ts` enforces it. Write them headless first (see `.agents/rules/public-text.md`): a new verb in `src/capabilities.ts` replaces every page link for that step in the same change.

## Releases

The CLI is one member of Catalyst's shared release train: every member shares one MAJOR.MINOR, so a MINOR moves only in a coordinated release with the SDK, the installer and the schema packages. Before you bump, load the `release-train` skill (`.agents/skills/release-train/SKILL.md`) and run its train-status script.

1. Bump `version` in `package.json`, then run `npm run version:sync` so `.claude-plugin/plugin.json`, the forwarder in `packages/catalyst-skills`, and every skill's provenance line carry the new version.
2. Add a `CHANGELOG.md` entry under a `## <version>` heading. The CLI prints that entry's first line to customers when they update.
3. Push a tag `skills-bundle-v<version>` whose version matches `package.json` exactly. The `skills-bundle publish` workflow rejects a tag that does not name the version being published.
4. The workflow runs the whole test suite with coverage before `npm publish`. That suite carries the pack-and-install smoke: it packs the real tarball, installs it into a clean directory, and runs the installed `login`, `install`, `status`, `contract`, `ready` and `replica schema` against a fixture `/me` server. A broken publish cannot ship.

One release publishes two packages at one version. `@catalyst-cloud/cli` (this directory) is the CLI, with the `catalyst` command and the deprecated `catalyst-skills` name. `@catalyst-cloud/catalyst-skills` (`packages/catalyst-skills`) is a forwarder that depends on exactly that version of `@catalyst-cloud/cli`, so a machine whose daily job still installs the old name gets the same release. The workflow publishes the CLI first and the forwarder second, and skips a version that is already on npm, so re-running a half-finished release completes it.

Publishing never happens from a laptop; the `skills-bundle publish` workflow is the only publish path. The npm credential is the repository secret `NPM_PUBLISH_TOKEN`, an automation token with publish rights on the `@catalyst-cloud` scope.

A manual `workflow_dispatch` run of the workflow publishes with `--dry-run` by default, so the whole path can be rehearsed without uploading anything.

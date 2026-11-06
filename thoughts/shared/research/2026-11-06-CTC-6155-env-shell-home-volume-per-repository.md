---
date: 2026-11-06T12:58:00+00:00
researcher: Claude (research-codebase skill, CATALYST_PHASE=research)
git_commit: 2f11ab3a73810d7f1972ae9c8603374e4df2e8f1
branch: CTC-6155
git_main_sha: 2f11ab3a73810d7f1972ae9c8603374e4df2e8f1
git_merge_base: 2f11ab3a73810d7f1972ae9c8603374e4df2e8f1
repository: catalyst-cloud-cli
topic: "CLI env shell: the writable home volume must not be shared across repositories (homeVolumeFor, src/env/shell-plan.ts)"
tags: [research, codebase, env-shell, shell-plan, docker-volume, homeVolumeFor, security]
status: complete
last_updated: 2026-11-06
last_updated_by: Claude (research-codebase skill)
type: research
source_ticket: CTC-6155
---

# Research: CLI env shell home volume is shared across repositories (CTC-6155)

**Date**: 2026-11-06T12:58:00+00:00 **Researcher**: Claude (research-codebase skill) **Git Commit**: 2f11ab3a73810d7f1972ae9c8603374e4df2e8f1 **Branch**: CTC-6155 **Repository**: catalyst-cloud-cli

## Research Question

Ticket CTC-6155, "CLI env shell: the writable home volume must not be shared across repositories". The cited location is `src/env/shell-plan.ts` (`homeVolumeFor`, ~line 35). The ticket says every repository using the same image shares the whole writable home volume (image-only volume naming), so code run in repository A can leave a `.bash_profile` that runs when repository B opens, with B's checkout and declared secrets available; it asks to scope the volume per repository. Acceptance: "a test that fails on a1126ea9 and passes with the fix."

Research scope requested:

- every caller of `homeVolumeFor` and how the volume name is used (create, mount, cleanup/prune, docs, help text, tests);
- what identifies "a repository" in the env shell code path (checkout path, git remote, config);
- existing tests under `test/` for env shell/check;
- volume-name stability and compatibility concerns (existing users' volumes, cleanup commands);
- the acceptance test: a test that fails on `a1126ea9` and passes with the fix.

## Summary

The defect is present exactly as described, both at the reviewed commit `a1126ea9` and at this checkout's HEAD `2f11ab3` (release 0.16.46). `homeVolumeFor(image)` (`src/env/shell-plan.ts:39-42`) returns `catalyst-env-home-<first 12 hex of the image's @sha256 digest>` (or the first 12 hex of `sha256(image)` when the string has no digest). It takes the image string and nothing else. It has one production caller, `shellRunArgs` (`src/env/shell-plan.ts:80`), which emits `--mount type=volume,src=<name>,dst=/home/catalyst` and also sets `HOME=/home/catalyst` (`src/env/shell-plan.ts:81-84`). `shellRunArgs` has one production caller, `runEnvShell` (`src/env/shell.ts:224`). The mount is unconditional, so `catalyst env shell` and `catalyst env shell --check` both use it. Any two repositories opened with the same image therefore mount the same volume as `$HOME`. The default image is a single digest-pinned constant (`RUNNER_HOST_IMAGES.runner`, `src/onboard-runner.ts:55-62`), so in the default case every repository on the machine shares one home volume.

Nothing in the volume-name code path knows about a repository. `ShellRunInput` (`src/env/shell-plan.ts:48-62`) carries `image`, `root` (the realpath of the checkout, bind-mounted at `/workspace`), `gitCommonDir`, toolchains, passed variable names, `tty` and `checkNames`. `runEnvShell` already computes a GitHub `owner/name` (`readLocalRepositoryName`, `src/onboard-settings-context.ts:30-81`) at `src/env/shell.ts:179-180` before it builds the argv, but only uses it for the "Environment for ..." line and the `--check --json` `repository` field; it is not a field of `ShellRunInput`. No `.catalyst/catalyst.toml` field names a repository (`src/env/shell-declaration.ts:17-20`).

No other code reads, lists, labels, removes or prunes `catalyst-env-home-*` volumes, and no README, help text or CHANGELOG entry mentions the volume. The only prose is two code comments (`src/env/shell-plan.ts:1-2`, `:38`). Tests pin the name in exactly four places, all in `test/env-shell-plan.test.ts` (`:31`, `:32`, `:44`, `:87`). No existing test builds argv for two different repositories and compares their volume mounts, so nothing currently fails on the image-only naming. The files the acceptance test would touch (`src/env/shell-plan.ts`, `src/env/shell.ts`, `test/env-shell-plan.test.ts`, `test/env-shell.test.ts`) are identical to `a1126ea9` in every volume-related line, so a test written against this HEAD that asserts distinct volumes for distinct repositories fails on `a1126ea9` as well.

## Detailed Findings

### 1. The volume name: `homeVolumeFor`

**What exists**

- `src/env/shell-plan.ts:38` doc comment: "One home volume per image digest: downloaded toolchains and history persist, a new image starts fresh." This is the only stated rationale (the PR #407 description has none; see section 8).
- `src/env/shell-plan.ts:39-42`:
  - regex `/@sha256:([0-9a-f]{12})/` takes the first 12 hex of the digest;
  - fallback `createHash("sha256").update(image).digest("hex").slice(0, 12)` when the string has no `@sha256:`;
  - result `catalyst-env-home-<12 hex>`.
- The function is at line 39 here; the ticket cites line 35 and the function sat at line 33 at `a1126ea9` (checked against the blob at that commit). The body is identical at both commits. `shell-plan.ts` differs between the two commits only in the start script (CTC-6389 `mise where` loop at `:20-23`, CTC-6153 non-login shell at `:31-34`).
- `import { createHash } from "node:crypto"` at `:5` is already used by this function only; it is the codebase's one name-from-hash site for Docker resources.

**Callers (complete list)**

| Where | What |
|---|---|
| `src/env/shell-plan.ts:80` | the only production call: `` `type=volume,src=${homeVolumeFor(input.image)},dst=${HOME}` `` inside `shellRunArgs` |
| `test/env-shell-plan.test.ts:8` | import |
| `test/env-shell-plan.test.ts:30-33` | direct unit test of the name |
| `dist/env/shell-plan.js:35`, `:58` | compiled copy; `dist/` is gitignored and untracked (`git ls-files dist` is empty), not a source of truth |

A repo-wide search for `homeVolumeFor`, `catalyst-env-home` and `env-home` (excluding `node_modules`, `.git`; including `src/`, `test/`, `skills/`, `evals/`, `packages/`, `vendor/`, `scripts/`, `.agents/`, `bin/`, `README.md`, `CHANGELOG.md`) finds nothing else. Other `catalyst-env-*` strings are temp-directory prefixes, not volume names (for example `catalyst-env-pull-` at `src/env/shell-docker.ts:133`, `catalyst-env-shell-` at `test/env-shell.test.ts:111`).

### 2. How the volume is created and mounted (`shellRunArgs`)

**What exists**

- `src/env/shell-plan.ts:65-115` builds the single `docker run` argv for both modes (`mode: "shell" | "check"`, `:49`).
- Order of the mounts (`:76-80`): `--mount type=bind,src=<root>,dst=/workspace` (`:77`), then `--mount type=bind,src=<gitCommonDir>,dst=<gitCommonDir>` only for a worktree whose shared `.git` is outside `root` (`:78`), then `--mount type=volume,src=<homeVolumeFor(image)>,dst=/home/catalyst` (`:79-80`).
- The volume is created implicitly by Docker the first time `--mount type=volume,src=<name>` names a volume that does not exist. The argv carries no `--name`, `--label` or `docker volume create` call. The container is `--rm` (`:69`), which removes the container and not the named volume.
- `HOME` is set to the mount point: `HOME = "/home/catalyst"` (`:13`), `-e HOME=/home/catalyst` (`:83-84`). `MISE_SYSTEM_DATA_DIR=/opt/catalyst/toolchain` and `MISE_SHARED_INSTALL_DIRS` (`:85-88`) point at the image's own toolchain, outside the volume. What lives in the volume is therefore the container user's whole `$HOME`: shell startup files, shell history, and whatever mise downloads under its default per-user data dir when the image lacks a declared version.
- Declared variables with a value are passed by name only (`-e NAME`, `:104`; header comment `:3-4`); values come from the client process environment (`runEnv`, `src/env/shell.ts:234-235`). They are present in the container for both `shell` and `check` runs, and the workspace is the bind-mounted checkout.

**What reads the volume's contents (the ticket's attack path)**

- Shell mode with no toolchains declared ends in `exec bash -l` (`src/env/shell-plan.ts:35`). A login bash reads `/etc/profile` and then the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile` (standard bash behaviour, not code in this repo).
- Shell mode with toolchains declared ends in `exec mise exec "$@" -- bash` (`:34`). CTC-6153 deliberately made this a non-login shell (comment `:31-33`), so `.bash_profile` is not read on that path. The comment says "a terminal gets ~/.bashrc and piped input keeps non-interactive semantics", so `~/.bashrc` is read when stdin is a terminal. The `a1126ea9` form was `mise exec ... -- bash -l` (login, reads `.bash_profile`), which is the form the review cited; at HEAD the `.bash_profile` path remains for the no-toolchain branch and `.bashrc` for the toolchain branch. Both live in the shared volume.
- `check` mode never starts bash (`:24-30`, `exit 0`), but it runs `mise where` / `mise install` with the same `HOME` (`:23`). Whether mise reads configuration or plugin state from `$HOME` in a way that is exploitable was not verified here.
- The repo's own test confirms the profile files are read from the fake `HOME` for the CTC-6153 behaviour: `test/env-shell-plan.test.ts:213-214` writes `home/.bash_profile` (PATH reset) and `home/.bashrc`.

### 3. What identifies "a repository" in the env shell path

The path in `runEnvShell` (`src/env/shell.ts:83` onward):

| Identifier | Where computed | Form | Stability | In `ShellRunInput`? |
|---|---|---|---|---|
| `root` | `src/env/shell.ts:106-111`: `--root` flag, else `git rev-parse --show-toplevel` from cwd (`gitTopLevel`, `:53`, `:108`), else cwd; then `realpathSync` | absolute realpath string; refused if it contains a comma or line break (`unmountable`, `:67-71`, `:118-119`) | path-dependent: differs per clone location, per linked worktree (`--show-toplevel` in a linked worktree returns that worktree's directory), per machine/user; two symlinks to one directory collapse | yes, `root` (`src/env/shell-plan.ts:51-52`; `src/env/shell.ts:227`) |
| `gitCommonDir` | `src/env/shell.ts:204-219`: `git rev-parse --path-format=absolute --git-common-dir` in `root` (`:54-55`), realpath'd; kept only if outside `root` | absolute path or `null` | `null` for an ordinary checkout (common dir is `<root>/.git`, inside root) and outside git; for a linked worktree it is the main checkout's `.git`, shared by every worktree of that clone | yes, `gitCommonDir` (`src/env/shell-plan.ts:53-54`) |
| GitHub `owner/name` | `readLocalRepositoryName` (`src/onboard-settings-context.ts:30-81`), called at `src/env/shell.ts:179-180` (`(await readRepositoryName(root)) ?? basename(root)`) and again only on a refused anonymous pull at `src/env/shell-pull.ts:136` | lowercase `owner/name` | stable across paths, clones, worktrees and machines (reads `git config --local --get-all remote.origin.url`, which linked worktrees share). `null` unless there is exactly one origin URL and it is `git@github.com:` or `https://github.com/` with a valid owner/name (`:55-77`); other hosts, `ssh://`, `http://`, no origin or multiple origins give `null` | no; held in the local const `repository` (`src/env/shell.ts:180`) and the `deps.readRepositoryName` seam (`src/env/shell.ts:24`) |
| `basename(root)` | `src/env/shell.ts:180` fallback | directory name | not unique across repositories | no |
| cloud `repoId` | `src/repository-id.ts:3-5`; settings-authority and onboard paths only (`src/env/settings-authority.ts:24`, `src/onboard-settings-context.ts:119-121`) | opaque id matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$` | stable but needs a sign-in and cloud reads | no; `env shell` needs no sign-in (`src/env.ts:5-6`, `README.md:324`) |
| declaration contents | `readShellDeclaration`, `src/env/shell-declaration.ts:31-50` | `ShellDeclaration = { toolchains, variables }` (`:17-20`); toolchain entries reject any key but `name`/`version` (`:70-71`) | n/a | no field names a repository or id; the only name-like field in the wider schema is `project.linear_team` (a Linear team key), which the shell path never reads |

Other facts about identity in this path:

- The declaration file is `<root>/.catalyst/catalyst.toml`, read through `readLocalSettings(root)` (`src/env/settings-authority.ts:106-156`), which refuses symlinks, non-realpath roots, files over 1 MiB and files that change between reads.
- `runEnvShell` calls `git` through `gitPath` (`src/env/shell.ts:33-52`): 3 s timeout, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, no prompt, stdout accepted only if absolute path.
- Test seams for identity: `EnvShellDeps.readRepositoryName`, `gitTopLevel`, `gitCommonDir` (`src/env/shell.ts:24-26`).
- The image digest identifies the image, not the repository; there is no other per-repository state anywhere on the env shell path.

### 4. Existing hash/slug patterns for per-key names (facts for naming)

- `src/env/shell-plan.ts:41`: `createHash("sha256").update(image).digest("hex").slice(0, 12)` (12 hex).
- `src/update-sdk.ts:215-222` (`takeProjectLock`): `` `${createHash("sha256").update(dir).digest("hex").slice(0, 32)}.lock` `` under `configDirFor(home)/sdk-update-locks`; keyed by a directory path.
- `src/env/onboard-draft-store.ts:9, 73-78`: cloud ids become filenames; ids matching `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` are used raw, others become `repo@<sha256 hex>.toml`.
- `src/onboard-settings-context.ts:27-28`: `repoKey = (repo) => `${repo.owner}/${repo.name}`.toLowerCase()`.
- Docker volume names used elsewhere are validated before use as `--mount src=`: `src/runner-update-fleet.ts:880-888` accepts `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/` (an `owner/name` string contains `/`, so it would not be a valid volume name as is). The `--mount` value is comma-separated, which is why `unmountable` refuses paths with commas (`src/env/shell.ts:67-71`).
- No Docker resource in the CLI is named per repository today. `src/env/` has no Docker `--name` or `--label` use; labels exist only for runner resources (`dev.catalystcloud.attempt.host-id`, `dev.catalystcloud.attempt.id`, `dev.catalystcloud.session-network`, `dev.catalystcloud.custody-token`; `src/runner.ts:22-23`, `src/onboard-runner.ts:49`, `src/onboard-runner-custody.ts:640-641`).

### 5. Cleanup, pruning and compatibility of existing volumes

- Nothing in the CLI removes, lists or prunes `catalyst-env-home-*`. `EnvShellDocker` (`src/env/shell-docker.ts:20-27`) exposes only `server`, `endpoint`, `imagePresent`, `pull`, `run` (docker subcommands `version`, `context inspect`, `image inspect`, `pull`, `run`).
- The only volume deletion is `catalyst runner uninstall`, `src/runner.ts:409-422`:
  - lists `docker volume ls --filter label=<ATTEMPT_HOST_LABEL>=<hostId>` (`:420`);
  - keeps names matching `/^catalyst-[A-Za-z0-9_.-]+$/` whose label equals the host id (`:421`);
  - runs `docker volume rm` on them (`:425`).
  The env shell volume carries no label (`src/env/shell-plan.ts:79-80`), so it is not selected, though its name does fit the name pattern. Compose volumes are removed only when labelled with the compose project (`src/runner.ts:25`, `:447-455`).
- The only "prune" mention is advice text, `src/onboard-runner-disk.ts:388` ("docker system prune").
- `src/legacy.ts` (`catalyst legacy`) removes a fixed list of launchd/systemd/bin/data-dir leftovers and has no Docker entries; `src/env/legacy.ts` converts `catalyst.env.json` to TOML and is unrelated to Docker.
- Volume naming history: the name was introduced by PR #407 (merge commit `bd22c9144c0c6c9f6914e2a6aa34280a3c506c9d`, 2026-10-19) and has not changed. This checkout is a one-commit shallow clone (`git rev-parse --is-shallow-repository` prints `true`), so local `git log` cannot show history; the PR file list came from the GitHub API.
- Existing users have volumes named `catalyst-env-home-<12 hex>`, created implicitly and holding whatever the home directory accumulated (including any file a previous run left). A new naming scheme does not read or migrate them: Docker would create a new, empty volume for the new name, and the old ones remain on the user's Docker engine, unreferenced by the CLI, until removed by hand (`docker volume rm`/`prune`). Docker's `--rm` leaves them behind in any case. There is no label on them to identify them later except the name prefix.
- Consequence of a smaller sharing scope for what "persist" means: the doc comment's goal (toolchains and history survive between runs, `:38`) is per volume; `src/env/shell.ts:76` tells the user "the first start downloads any version the image lacks", so each separately-named volume starts empty and re-downloads versions the image lacks.

### 6. User-facing text, docs and help

- No help text, README or CHANGELOG text mentions the home volume, persistence of history/toolchains, or home-directory startup files.
  - `README.md:324`: describes `env shell` and `--check` (image, toolchain, variables, Docker needed, no sign-in, first-run download of about 2.3 GB). The README's "what it writes on your machine" list (`README.md` around `:337-345`) does not list the volume.
  - `CHANGELOG.md:143` (the 0.16.20 entry): "New: `catalyst env shell` opens your repository's declared environment ... on `PATH`."
  - Usage and flag help: `src/args.ts:702` (`env` usage line), `src/args.ts:452-464` (`--env-file`, `--image`, `--check`), `src/cli.ts:244` (top-level help), `src/capabilities.ts:78` (capability entry, `since: "0.16.20"`).
  - Dispatch: `src/cli.ts:771-772` -> `cmdEnv` -> `src/env.ts:47` -> `runEnvShell`.
- Runtime messages that touch the area: `src/env/shell.ts:76` (first start downloads missing toolchain versions), `:241` (uid note), `:257` ("Your repository is at /workspace. Type exit to leave.").
- Skills, evals, packages, scripts, `.agents` and `bin` contain no mention of the env shell home volume.

### 7. Existing tests

Run model: `bun run test` is `vitest run` (`package.json:43`); `vitest.config.ts` includes `test/**/*.test.ts`, runs files sequentially (`fileParallelism: false`) with `CATALYST_SKILLS_OFFLINE=1`; CI runs `bun run typecheck` (`tsc --noEmit`, `tsconfig.json` includes `src` and `test`) and `bun run test:coverage` (thresholds statements 90, branches 85, functions 85, lines 90). Docker is not required: it is always an injected port, a fake script on `PATH` or absent. In this container `docker` is not installed. The five env shell test files (`env-shell-plan`, `env-shell`, `env-shell-docker`, `env-shell-declaration`, `env-shell-pull`; 78 tests) pass at this HEAD without Docker (`bunx vitest run` on those files, run during this research); a sub-agent's run that also included `env-check.test.ts` counted 85 tests, all passing.

| File | What it tests | Volume-related lines |
|---|---|---|
| `test/env-shell-plan.test.ts` | pure `homeVolumeFor`, `toolchainSpecs`, `shellRunArgs`, `parseCheckOutput`, and the start script (against fake `mise`/`bash`) | `:30-33` name test; `:44` full-argv `toEqual` containing `type=volume,src=catalyst-env-home-a19f7b0859a9,dst=/home/catalyst`; `:83-87` exact mount list in the worktree test |
| `test/env-shell.test.ts` | `main(["env","shell",...])` through `runEnvShell` with a recording docker port | none pin the volume. `:462` counts two `--mount` words for the common-dir-inside-root case, which would change only if a `--mount` word were added |
| `test/env-shell-docker.test.ts` | the real `spawnEnvShellDocker` wrapper with a fake `docker` on `PATH` | none (`ARGV` at `:253` has no volume) |
| `test/env-shell-declaration.test.ts` | `readShellDeclaration`, `resolveShellVariables`, reserved names | none |
| `test/env-shell-pull.test.ts` | `downloadImage`, pull-credential flow; fake docker implements only `pull` | none; `ROOT = "/work/checkout"` (`:23`) is a fake string |
| `test/env-check.test.ts` | `catalyst env check` / `env migrate` (settings TOML validator) | not on the env shell path; no Docker, volume or git |

Fixture details that matter for a new test:

- `test/env-shell-plan.test.ts:15-28`: `IMAGE` is `ghcr.io/coalesce-labs/catalyst-runner@sha256:a19f7b0859a9...` (not the default runner image); `base = { image, root: "/Users/ana/src/web", gitCommonDir: null, toolchains, passNames, checkNames }` is spread into `shellRunArgs({ ...base, mode, tty })`. No repository exists on disk and no remote or name is carried. A new required `ShellRunInput` field would be a `tsc --noEmit` error at every `shellRunArgs({...base})` call (`:40, :60, :67, :82, :93`) until `base` gains it; vitest itself does not typecheck.
- `test/env-shell.test.ts:105-135`: `beforeEach` makes `repo = realpathSync(mkdtempSync(.../catalyst-env-shell-))` and writes `.catalyst/catalyst.toml` (the `OAKMONT` declaration); `deps()` stubs `readRepositoryName: async () => "oakmont-labs/web"` and `gitCommonDir: async () => null` for every test (`:126-127`); the helper `shell(args, docker, over)` runs `main(["env","shell","--root", repo, ...args], ctx, deps(docker, over))` and accepts per-call overrides of those deps (`:134-135`). `recordingPort()` (`:57-99`) captures `rec.runs[n].argv`; one port can accumulate several runs. Precedents for a second repository directory: `:306-314` (a second temp dir with `writeDeclaration`), `:454-465`, and `:141-143` (real checkout with an overridden repository name). The only test that runs real `git` in the shell path is `:438-451` (`git init`, no remote); the only fixture that sets a git remote is `test/onboard-settings-context.test.ts:307-308`.
- No existing test extracts the volume mount from an argv captured via `main`, and none sets two different repositories against one image.

Which existing assertions the current literal names would affect if the name gained a repository component: `test/env-shell-plan.test.ts:31`, `:32` (anchored regex `^catalyst-env-home-[0-9a-f]{12}$`), `:44` and `:87`. No assertion in the other five files depends on the volume string.

### 8. The `a1126ea9` baseline and the acceptance test

- `a1126ea9` (full SHA `a1126ea903b313a937e3f17b98572771ce428f64`) is "fix(cli): CTC-3550 - env shell keeps DOCKER_* values off the docker client and drops non-null assertions", the head of PR #407 (CTC-3550, merged 2026-10-19T03:20:28Z as `bd22c9144c0c6c9f6914e2a6aa34280a3c506c9d`). It is not present in this container's one-commit shallow clone (`git cat-file -t a1126ea9` fails and `git fetch origin a1126ea9` by short SHA fails); its blobs were read through `gh api .../contents/<path>?ref=a1126ea903b313a937e3f17b98572771ce428f64`.
- Comparison of those blobs with this HEAD:
  - `src/env/shell-plan.ts`: 145 lines vs 151. `homeVolumeFor` is at `:33` there and `shellRunArgs` mounts it at `:74` (here `:39` and `:80`). The only differences are the start script lines (CTC-6389, CTC-6153).
  - `src/env/shell.ts`: 312 lines both; one difference at line 151, `resolveShellVariables(..., { env, envFiles })` vs `{ env, envFiles, platform: deps.platform }`. The `readRepositoryName` call is at `:179-180` and `shellRunArgs` at `:224` in both.
  - `test/env-shell-plan.test.ts`: 217 lines vs 284 (extra tests added since); the volume assertions are at the same four line numbers (`:31`, `:32`, `:44`, `:87`).
  - `test/env-shell.test.ts`: 523 lines both; 6 differing lines, all about the bun version and image digest in display strings, none about volumes.
- Check run 117884939589 on `a1126ea9` is "Independent Agent Review" by the Catalyst Cloud Connector app (conclusion `failure`, completed 2026-10-19T04:09:12Z, after the merge, "this is the PR's ONE review (it merged with zero reviews)"). Its P2 finding, verbatim: "src/env/shell-plan.ts:35: Every repository using the same image shares the entire writable home volume. Code run in repository A can leave a `.bash_profile` that executes automatically when repository B opens, with B's mounted checkout and declared secrets available. Image-only volume naming allows persistent execution and credential access across repositories." The same review raised five other P1/P2 findings, at `src/env/shell-declaration.ts:102`, `src/env/shell-plan.ts:28`, `src/env/shell-plan.ts:72`, `src/env/shell-docker.ts:139` and `src/env/shell-pull.ts:174` (these line numbers are as at `a1126ea9`, not at this HEAD); the follow-ups CTC-6152 (#409), CTC-6153 (#410) and CTC-6389 (#439) are merged and none touched the volume. PR #407 had no reviews or review comments.
- No PR matches CTC-6155 (`gh pr list --search CTC-6155 --state all` returned `[]`); a remote branch `CTC-6155` exists and points at `2f11ab3a73810d7f1972ae9c8603374e4df2e8f1`, the same as `main`.
- What a "fails on a1126ea9, passes with the fix" test needs to observe, from the structure above:
  - The failing condition is observable at the argv level: for one `image`, two inputs that represent two different repositories produce an identical `type=volume,src=...` word at `a1126ea9` and (after the fix) different ones.
  - At `a1126ea9`, any assertion that two repositories get different volume names fails regardless of how the repository is represented, so the test does not depend on which identity the fix picks as long as it drives the repositories through the public entry points (`main(["env","shell", "--root", <repoA|repoB>, ...])` with a recording docker port, or `shellRunArgs` with differing `root`).
  - A pure `shellRunArgs` test with only different `root` values would pass only if the fix keys on `root`; a test through `main` that varies `readRepositoryName` per call would pass only if the fix keys on the repository name; a test varying both discriminates between designs. The test should also check that the same repository run twice gets the same volume (stability), which the image-only scheme already satisfies and which any fix must keep.
  - `tsc --noEmit` covers `test/`, so a test that passes a field that `ShellRunInput` does not have at `a1126ea9` fails typecheck there in addition to failing at runtime; vitest alone would fail on the assertion.

## Code References

- `src/env/shell-plan.ts:38-42` - `homeVolumeFor(image)`: `catalyst-env-home-` + 12 hex of the image digest (or `sha256(image)`); the doc comment states the per-image-digest rationale.
- `src/env/shell-plan.ts:48-62` - `ShellRunInput`: `mode, image, root, gitCommonDir, toolchains, passNames, tty, checkNames`; no repository identity beyond `root`/`gitCommonDir`.
- `src/env/shell-plan.ts:76-80` - the three `--mount` entries; the home volume at `:79-80`.
- `src/env/shell-plan.ts:13`, `:81-84` - `HOME=/home/catalyst` and `-e HOME=/home/catalyst`.
- `src/env/shell-plan.ts:17-36` - `ENV_SHELL_START_SCRIPT`; `:34` `exec mise exec "$@" -- bash`; `:35` `exec bash -l`; `:24-30` check mode, no shell.
- `src/env/shell-plan.ts:104` - passed variables as `-e NAME` words.
- `src/env/shell.ts:106-111` - root resolution (`--root`, `git rev-parse --show-toplevel`, cwd; `realpathSync`).
- `src/env/shell.ts:179-180` - `readRepositoryName(root)` (GitHub `owner/name`) with `basename(root)` fallback; display only.
- `src/env/shell.ts:204-219` - git common dir for linked worktrees.
- `src/env/shell.ts:224-233` - the single production call of `shellRunArgs`.
- `src/env/shell.ts:24-26` - dependency-injection seams `readRepositoryName`, `gitTopLevel`, `gitCommonDir`.
- `src/env/shell-pull.ts:136-137` - second use of the repository name (pull credential request).
- `src/onboard-settings-context.ts:30-81` - `readLocalRepositoryName`.
- `src/env/shell-declaration.ts:17-20` - `ShellDeclaration` (no repository field).
- `src/onboard-runner.ts:55-63` - `RUNNER_HOST_IMAGES`, `IMAGE_REF`; the default image digest.
- `src/runner.ts:409-425` - label-scoped volume removal on `runner uninstall`; the only `docker volume rm` in the CLI.
- `test/env-shell-plan.test.ts:30-33, 44, 83-87` - literal pins of the volume name; `:15-28` `IMAGE` and `base`; `:213-214` profile-file fixture.
- `test/env-shell.test.ts:105-135, 306-314, 438-466` - fixture, `deps()`/`shell()` helpers, second-directory and git precedents.

## Architecture Documentation

- `catalyst env shell` is one function (`runEnvShell`, `src/env/shell.ts:83`) that resolves the root, reads the declaration, resolves variables, checks the Docker engine, ensures the image, resolves the git common directory, builds one argv in the pure module `src/env/shell-plan.ts` (the module header says it spawns, reads no file and sees no variable's value, `:1-4`), and runs `docker` through the injectable `EnvShellDocker` port (`src/env/shell-docker.ts:20-27`). `--check` and the shell differ only by mode, `-i`/`-t` and `CATALYST_ENV_NAMES` (`src/env/shell-plan.ts:64`).
- The repository's checkout is a bind mount at `/workspace`; the user's home inside the container is a Docker named volume at `/home/catalyst`; the toolchain store is in the image at `/opt/catalyst/toolchain`. Secrets are never written to argv: names only, values via the docker client's environment.
- The volume lifecycle is implicit: created on first use by Docker, never labelled, never listed or removed by the CLI.
- Repository identity elsewhere in the CLI is derived on demand from git (`remote.origin.url`, toplevel) or from the cloud (`repoId`); per-key names elsewhere hash the key (`sha256(...).slice(0, N)`).

## Historical Context (from thoughts/)

- This checkout has no `thoughts/` directory (it is not initialised in this container); the only prior artifact for this ticket is the intake record, which restates the ticket (classification bug, scope small, single repository `coalesce-labs/catalyst-cloud-cli`, no cross-repository work). `RESULT.md` at the repo root is an unrelated CTC-5723 record.
- The GitHub history above (PR #407, check run 117884939589, PRs #409, #410, #439) is the only history found. The volume's intent ("downloaded toolchains and history persist, a new image starts fresh") appears only in the source comment at `src/env/shell-plan.ts:38`.

## Open Questions

- What "a repository" means for the volume: the checkout path (`root`), the GitHub `owner/name`, or something else. Facts above: `root` differs per worktree and clone, and the compare-by-path semantics change if a checkout directory is reused for a different repository; `owner/name` is stable across clones and worktrees but is `null` for non-GitHub or multi-origin repositories, where the only fallback in this path is `basename(root)`, which is not unique; forks have different owners. These are design inputs for the plan, not decided here.
- Whether `--check` should share the repository's volume or use none: it runs `mise where`/`mise install` against `HOME` (`src/env/shell-plan.ts:23`) and passes the same declared variables, but starts no shell.
- Whether anything should happen to existing `catalyst-env-home-<image digest>` volumes (leave, document, or provide cleanup); nothing in the CLI references them and they have no label.
- Whether the user-facing docs (`README.md:324`, `CHANGELOG.md`) should describe what persists in the home volume; currently they say nothing.
- Whether a per-repository volume's cost is acceptable: each repository re-downloads declared toolchain versions the image lacks (`src/env/shell.ts:76`).
- The `.bashrc` path (non-login shell under `mise exec`, interactive terminal) and the `.bash_profile` path (`bash -l` with no declared toolchains) are both reads of files in the shared `$HOME`; the `a1126ea9` form used `bash -l` for both. Whether mise itself reads `$HOME` configuration in `check` mode was not verified.
- The test could not be run against `a1126ea9` in this container (commit absent from the shallow clone, no Docker, no network git fetch by short SHA); the failing-on-baseline claim above is by comparison of the baseline blobs, not by execution.

## Related Documents

- Ticket text: `/workspace/tmp/catalyst-runner-artifact-aeGX9r/ticket.md`
- Intake record: `/workspace/tmp/catalyst-runner-artifact-aeGX9r/prior/intake.json`
- GitHub: PR #407 https://github.com/coalesce-labs/catalyst-cloud-cli/pull/407 ; check run https://github.com/coalesce-labs/catalyst-cloud-cli/runs/117884939589 ; follow-ups #409, #410, #439

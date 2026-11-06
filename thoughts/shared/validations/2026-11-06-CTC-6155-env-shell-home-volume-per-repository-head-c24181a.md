---
date: 2026-11-06
source_ticket: CTC-6155
repository: catalyst-cloud-cli
plan: thoughts/shared/plans/2026-11-06-CTC-6155-env-shell-home-volume-per-repository.md
pr: coalesce-labs/catalyst-cloud-cli#618
---

# Validation Report: per-repository env shell home volume (head after review fix)

**Plan**: `thoughts/shared/plans/2026-11-06-CTC-6155-env-shell-home-volume-per-repository.md`
**Validated**: 2026-11-06, fresh run; revised after the different-family review of 6775ac8 returned FAIL (see Code Review Findings)
**Validation Status**: PASS

## Summary

The home volume name is now `catalyst-env-home-<image12>-<sha256(root + NUL + inode:birthtime)[0:24]>`, so two checkouts on one image no longer share a home volume, and a different repository cloned to a deleted repository's path no longer inherits that volume. The two CTC-6155 tests fail on `a1126ea9` for the volume-naming reason and pass at this head. `npm run typecheck` is clean and no reward-hacking pattern appears in the diff. The security audit step is skipped because the repo configures no dependency audit.

## Validation Source

- `git_commit`: c4f654cda133f4dd0ba8e5a7b78c57ebe2fe1fc9 (the fix for F4; the documents-only commit that records this report follows it). Earlier results were made at c24181a, 6775ac8, fa0856c, 9dcbde4 and f409694
- `branch`: CTC-6155
- `git_main_sha`: 7ec44daa2d30e842c57cdb0bdab71d1afa2ab461
- `git_merge_base`: 7ec44daa2d30e842c57cdb0bdab71d1afa2ab461

### Main movement since the plan

The plan's merge base was 2f11ab3. `git log 2f11ab3..7ec44da` holds one commit, 7ec44da (CTC-6156, #617), which changed `src/env/shell-plan.ts`, `src/env/shell.ts` and both env-shell test files, all plan-referenced. It was merged into the branch (b1300c4, c24181a). It moved the plan's line numbers (the mount is now at `src/env/shell-plan.ts:115`, not 80) and does not count against conformance. The branch now sits directly on main: the branch diff against 7ec44da is only the CTC-6155 change plus documents. No `deviations.json` exists for this ticket.

## Plan Conformance

✓ Phase 1: Per-repository home volume. `homeVolumeFor(image, root, identity)` is at `src/env/shell-plan.ts:52` and its only call passes `input.root` and `input.rootIdentity` (`src/env/shell-plan.ts:120`). `root` is the realpath'd directory bind-mounted at `/workspace` (`src/env/shell.ts:146`); `checkoutIdentity` (`src/env/shell.ts:54`) reads the inode and birth time of the root and of its own `.git` entry (read with `lstat`, never followed) through `identityFromStat` (`src/env/shell.ts:42`), called at `src/env/shell.ts:264`.
⚠ Declared deviation (review-driven): the plan keyed the name on the path alone and put path reuse out of scope ("What We're NOT Doing"). The ticket asks for the volume to be scoped per repository, and the ticket wins, so the key gained the directory identity and `ShellRunInput` gained the field `rootIdentity`. Planned: `homeVolumeFor(image, root)`. Actual: `homeVolumeFor(image, root, identity)`. Reason: finding F1 below. Evidence: the fix commits and their red-to-green tests. Further review-driven changes (F2, F3, F4) made the identity depend on the birth time alone, never on the change time. Materiality: material, declared. No origin URL or git common dir feeds the name. Both `shell` and `check` share `shellRunArgs`, so they use the same volume.
✓ Tests: the new pure test is at `test/env-shell-plan.test.ts:41`, an identity test at `test/env-shell-plan.test.ts:50`, the format test follows, and the integration tests are at `test/env-shell.test.ts:541` and `test/env-shell.test.ts:559`. The four pinned names were updated; the CTC-6156 tests merged from main use `homeMountForRoot`.
✓ Diff scope against main: `src/env/shell-plan.ts`, two test files and thoughts documents. No README, CHANGELOG or version change, as planned.
✓ The new tests were written with the fix commit (23a56a8 in history); the pre-fix failure is shown below by running them against `a1126ea9`.

## Code Review Findings

- Matches plan: all items above; deviations: none.
- F1 (code-review FAIL from the different-family review of 6775ac8, `src/env/shell-plan.ts:52`): the key identified a path, not a repository. If repository A is deleted and B cloned at the same path, B mounted A's volume and A's `~/.bash_profile` ran with B's checkout and secrets. Class: valid; I reproduced it by running the new path-reuse test against the old source, where it failed with identical volume words. Resolution: the key now also includes the directory's inode and birth time, read with a read-only `stat` of the already-realpath'd root (`src/env/shell.ts:54`). A recreated directory gets a new birth time, which neither the container nor any file in the checkout can set. Why not the alternatives: a marker file or git state in the checkout is writable from the container and would dirty `git status`; the origin URL or common dir are steerable; a host-side registry adds state and still needs a deletion signal. The name stays 55 hex characters, is stable across runs and shared by `shell` and `--check`, and non-git roots and linked worktrees work since no git call is made. Residual: on a filesystem with no birth time, Node reports the change time, so the code falls back to the inode alone (path reuse is then only caught when the inode differs); a restored backup or moved checkout starts a fresh home.
- F2 (code-review FAIL from the different-family review of fa0856c, `src/env/shell.ts:54`): `checkoutIdentity` fell back to the inode alone when birth time equalled change time. A newly created root has equal times on coarse-timestamp filesystems (reproduced on overlayfs), so the first entry added at the root moved the change time and the same checkout switched volumes. Class: valid; reproduced with `npx vitest run test/env-shell.test.ts -t "one checkout keeps"` against the previous logic: `expected '8929256779:1793977243672048086' to be '8929256779'`. Resolution: the identity is `inode:birthtime` whenever the platform reports a birth time above zero (`identityFromStat`, `src/env/shell.ts:42`); the change time is never read. A birth time does not change while the directory exists, so adding, removing or changing root entries keeps the name. Tests: the pure `test/env-shell-plan.test.ts:57` and the real-filesystem `test/env-shell.test.ts:602` (a fresh directory, then entries added, changed and removed, then a second `env shell` run after a file is added to the checkout).
- F3 (code-review FAIL from the different-family review of 9dcbde4, `src/env/shell.ts:42`): where the filesystem reports no birth time the key was the inode alone, so if A is deleted and B cloned at the same path with A's inode reused, B got A's home volume and A's startup file. Class: valid (the ticket's own threat). Resolution, fail closed: `identityFromStat` (`src/env/shell.ts:42`) returns null when the birth time is zero, `checkoutIdentity` (`src/env/shell.ts:54`) passes it on, and `shellRunArgs` then mounts `type=volume,dst=/home/catalyst` with no source (`src/env/shell-plan.ts:121`): an anonymous volume that `--rm` removes with the container, so no name exists for any other run to mount. `shell` and `--check` both get a fresh home. Cost, accepted: toolchains download again on every run on such filesystems. Docker populates a new anonymous volume from the image's /home/catalyst content as it does a named one; Docker is not installed in this environment, so that behaviour is documented Docker behaviour, not something I ran. Test: `test/env-shell-plan.test.ts:70` asserts no `catalyst-env-home-` word in either mode; it failed on the previous source (`expected 'type=volume,src=catalyst-env-home-a19…' to be 'type=volume,dst=/home/catalyst'`) and passes now. The persistent `inode:birthtime` path is unchanged.
- F4 (code-review FAIL from the different-family review of f409694, `src/env/shell.ts:42`): replace repository A in place by emptying the same root directory and putting B's contents and `.git` into it. The root keeps its inode and birth time, so B got A's named volume and A's `~/.bash_profile`. Class: valid; reproduced by the new test `test/env-shell.test.ts:570` against the previous source (`expected 'type=volume,src=catalyst-env-home-598…' not to be ...`). Resolution: the identity is now the inode and birth time of the root and of its own `.git` entry (`checkoutIdentity`, `src/env/shell.ts:54`, reads it with `lstat` and never follows it; a directory for a clone, a file for a linked worktree), plus the host path. Replacing a repository in place creates a new `.git`, so the volume changes. A `.git` symlink planted from the container has its own identity, which cannot equal another checkout's, and nothing is written through it. The result is null, hence the anonymous home of F3, when the root or its `.git` has no birth time or when there is no `.git` (a non-git `--root`: toolchains download again on every run there). Stability: a birth time does not change while the entry exists, and git writes inside `.git` without re-creating it, so the name survives root-entry changes and `.git` writes; some worktree operations rewrite the `.git` file, which only rotates the volume and never shares one. Boundary, stated plainly: if a person keeps A's existing `.git` and repoints it at B (set-url, fetch, checkout), git treats it as the same repository. A's hooks and config in that `.git` already persist, so the home volume adds nothing an attacker did not already have; this case is out of scope by definition, and the origin URL and other checkout-writable data stay out of the key. Tests: `test/env-shell-plan.test.ts:57` (pure), `test/env-shell.test.ts:570` (in-place replacement), `test/env-shell.test.ts:582` (planted `.git` symlink), `test/env-shell.test.ts:597` (no `.git`, anonymous in both modes), `test/env-shell.test.ts:602` (stable across root and `.git` writes).
- Residual (1), a reused inode on a filesystem with no birth time: CLOSED by F3.
- Residual (2), accepted follow-up (the reviewer accepted it): where Node synthesizes the birth time from the change time (no statx, for example blocked by a sandbox; not on Node 24's supported kernels), the name changes whenever entries at the root change. That checkout gets a fresh home volume (toolchains download again) and never shares one.
- review-code (own pass, before F1): no finding at confidence 80 or above. The change is a two-line pure function edit and a call-site edit; comments and header are accurate; the merge of main left no conflict residue.
- review-security: no finding at confidence 70 or above after the fix. The volume key is the host path and directory identity read before Docker starts, so code in the container cannot steer it (the `.git/config` origin and the worktree common dir are deliberately excluded). The name is fixed-width hex, so nothing reaches `--mount` unquoted.
- Residual, already recorded in the plan as out of scope: the common-dir mount (`src/env/shell.ts:246`) is chosen by files inside the checkout; a separate ticket is suggested. Old shared `catalyst-env-home-<12 hex>` volumes remain on disk, unmounted.
- scan-reward-hacking: grep of the added lines in `src` and `test` for `as any`, `as unknown`, `@ts-`, `eslint-disable`, `biome-ignore`, `.skip`, `.only` and non-null assertions found none. No tsconfig change.

## Automated Verification Results

✓ `npm run typecheck` (`tsc --noEmit`) exit 0 at the fix head
✓ `npx vitest run test/env-shell-plan.test.ts test/env-shell.test.ts` at the fix head: 60 passed
✗ `npx vitest run test/env-shell.test.ts -t "one checkout keeps"` with the previous `checkoutIdentity` logic: 1 failed (inode-only versus `inode:birthtime`), the red run for F2; it passes with the fix
✗ `npx vitest run test/env-shell.test.ts -t "deleted repository"` with `src/` stashed back to 6775ac8: 1 failed (`expected 'type=volume,src=catalyst-env-home-598…' not to be ...`), the red run for F1; it passes with the fix
✓ `npx vitest run test/env-shell-plan.test.ts test/env-shell.test.ts -t "two repositories on one image|two checkouts with the same origin"` at head: 2 passed (re-run at c24181a, before the fix for F1)
✗ the same command in a temporary worktree at `a1126ea9` (fetched via `git fetch origin refs/pull/407/head`, since `git fetch origin a1126ea9` was refused) with this head's two test files copied in: 2 failed, both with `AssertionError: expected 'type=volume,src=catalyst-env-home-a19…' not to be 'type=volume,src=catalyst-env-home-a19…'`. Both checkouts got the same image-only volume word. This is the expected acceptance failure. The worktree was removed afterwards.
- No lint script or dependency audit is configured in `package.json`.
- The gate `bun run typecheck && bun run test:coverage` is run last, after this commit; its result is in `/tmp/catalyst-runner-artifact-Plf6Ak/gate-validate.md`.

### Manual Testing Required

- [ ] With Docker, run `catalyst env shell` in two checkouts and check `docker volume ls --filter name=catalyst-env-home-` shows two 55-character names, and `--check` reuses the first.

## Scenarios

- met: Home volume scoped per repository: `homeVolumeFor(image, root, identity)` hashes the mounted checkout path and its directory identity into the name (`src/env/shell-plan.ts:52`, `src/env/shell-plan.ts:120`), so repository A's shell cannot leave a profile in repository B's volume
- met: Acceptance test that fails on a1126ea9 and passes with the fix: both CTC-6155 tests failed at a1126ea9 with identical image-only volume words and pass at c24181a
- met: Volume not steerable from inside the checkout: the key is the realpath'd host root plus its inode and birth time, not the origin URL or common dir, and the integration test holds both equal across two checkouts and still gets different volumes
- met: --check uses the same volume as the shell: `test/env-shell.test.ts:541` asserts it
- met: Same path reused by a different repository: a directory deleted and re-created at the same path gets a different home volume, and `--check` still shares the shell's (`test/env-shell.test.ts:559`, red before the fix, green after; filesystems with no birth time get an anonymous home, see F3)
- met: One checkout keeps its volume when entries at its root or inside .git change: `test/env-shell.test.ts:602` and `test/env-shell-plan.test.ts:57`, red on the previous logic, green after
- met: Repository replaced in place in the same root directory: B put into A's emptied root with a new `.git` gets a different home volume (`test/env-shell.test.ts:570`, red on the previous source, green after); a planted `.git` symlink cannot reach another checkout's volume (`test/env-shell.test.ts:582`); the boundary of a repointed existing `.git` is stated under F4
- met: A checkout with no .git gets an anonymous home: `test/env-shell.test.ts:597`
- met: No named home volume when the filesystem reports no birth time: `test/env-shell-plan.test.ts:70` asserts the anonymous `type=volume,dst=/home/catalyst` mount in both modes, so a re-created directory with a reused inode cannot inherit an old home (red on the previous source, green after)
- met: Volume name valid for Docker at any path: the format test asserts 55 characters of hex for awkward roots and unpinned images

## Recommendations

- Merge when the gate result is green. File the common-dir mount as a separate ticket, as the plan says.

```catalyst-validation-ladder
{"version":1,"steps":[
  {"step":"plan-conformance","verdict":"PASS","materiality":"material","declared":true,"detail":"Phase 1 implemented; one declared review-driven deviation: key adds directory inode and birth time (F1 path reuse, F2 stability, F3 no birth time gives an anonymous home, F4 the key also holds the checkout's own .git entry), ShellRunInput gains rootIdentity"},
  {"step":"type-safety","verdict":"PASS","detail":"npm run typecheck exit 0 at fix head; reward-hacking scan of added lines found nothing; no lint script configured"},
  {"step":"code-review","verdict":"PASS","detail":"review-code: own pass clean; the different-family review findings F1 (src/env/shell-plan.ts:52, path reuse), F2 (identity stability), F3 (no birth time) and F4 (src/env/shell.ts:42, in-place replacement) are fixed; F3 (inode-only key) is closed by an anonymous home volume and F4 (in-place replacement, src/env/shell.ts:42) by keying on the checkout's own .git entry; residual 2 accepted as follow-up and re-checked at the fix head","findings":[{"path":"src/env/shell-plan.ts","line":52},{"path":"src/env/shell.ts","line":42}]},
  {"step":"security-review","verdict":"PASS","detail":"review-security: no finding at or above 70; volume key is the host path the container cannot change"},
  {"step":"security-audit","verdict":"SKIPPED","detail":"no dependency audit configured in this repo; the diff adds no dependency"}
]}
```

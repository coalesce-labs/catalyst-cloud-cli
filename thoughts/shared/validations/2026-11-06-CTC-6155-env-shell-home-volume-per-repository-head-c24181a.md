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

- `git_commit`: d9935d2f911b2f8b6cdf64c85c40596d47663862 (the fix for F2; the documents-only commit that records this report follows it). Earlier results were made at c24181a, 6775ac8 and fa0856c
- `branch`: CTC-6155
- `git_main_sha`: 7ec44daa2d30e842c57cdb0bdab71d1afa2ab461
- `git_merge_base`: 7ec44daa2d30e842c57cdb0bdab71d1afa2ab461

### Main movement since the plan

The plan's merge base was 2f11ab3. `git log 2f11ab3..7ec44da` holds one commit, 7ec44da (CTC-6156, #617), which changed `src/env/shell-plan.ts`, `src/env/shell.ts` and both env-shell test files, all plan-referenced. It was merged into the branch (b1300c4, c24181a). It moved the plan's line numbers (the mount is now at `src/env/shell-plan.ts:115`, not 80) and does not count against conformance. The branch now sits directly on main: the branch diff against 7ec44da is only the CTC-6155 change plus documents. No `deviations.json` exists for this ticket.

## Plan Conformance

✓ Phase 1: Per-repository home volume. `homeVolumeFor(image, root, identity)` is at `src/env/shell-plan.ts:52` and its only call passes `input.root` and `input.rootIdentity` (`src/env/shell-plan.ts:120`). `root` is the realpath'd directory bind-mounted at `/workspace` (`src/env/shell.ts:121`); `checkoutIdentity` (`src/env/shell.ts:47`) reads its inode and birth time through `identityFromStat` (`src/env/shell.ts:32`), called at `src/env/shell.ts:251`.
⚠ Declared deviation (review-driven): the plan keyed the name on the path alone and put path reuse out of scope ("What We're NOT Doing"). The ticket asks for the volume to be scoped per repository, and the ticket wins, so the key gained the directory identity and `ShellRunInput` gained the field `rootIdentity`. Planned: `homeVolumeFor(image, root)`. Actual: `homeVolumeFor(image, root, identity)`. Reason: finding F1 below. Evidence: the fix commits and their red-to-green tests. A second review-driven change (F2) made the identity depend on the birth time alone, never on the change time. Materiality: material, declared. No origin URL or git common dir feeds the name. Both `shell` and `check` share `shellRunArgs`, so they use the same volume.
✓ Tests: the new pure test is at `test/env-shell-plan.test.ts:40`, an identity test at `test/env-shell-plan.test.ts:49`, the format test follows, and the integration tests are at `test/env-shell.test.ts:529` and `test/env-shell.test.ts:552`. The four pinned names were updated; the CTC-6156 tests merged from main use `homeMountForRoot`.
✓ Diff scope against main: `src/env/shell-plan.ts`, two test files and thoughts documents. No README, CHANGELOG or version change, as planned.
✓ The new tests were written with the fix commit (23a56a8 in history); the pre-fix failure is shown below by running them against `a1126ea9`.

## Code Review Findings

- Matches plan: all items above; deviations: none.
- F1 (code-review FAIL from the different-family review of 6775ac8, `src/env/shell-plan.ts:52`): the key identified a path, not a repository. If repository A is deleted and B cloned at the same path, B mounted A's volume and A's `~/.bash_profile` ran with B's checkout and secrets. Class: valid; I reproduced it by running the new path-reuse test against the old source, where it failed with identical volume words. Resolution: the key now also includes the directory's inode and birth time, read with a read-only `stat` of the already-realpath'd root (`src/env/shell.ts:47`). A recreated directory gets a new birth time, which neither the container nor any file in the checkout can set. Why not the alternatives: a marker file or git state in the checkout is writable from the container and would dirty `git status`; the origin URL or common dir are steerable; a host-side registry adds state and still needs a deletion signal. The name stays 55 hex characters, is stable across runs and shared by `shell` and `--check`, and non-git roots and linked worktrees work since no git call is made. Residual: on a filesystem with no birth time, Node reports the change time, so the code falls back to the inode alone (path reuse is then only caught when the inode differs); a restored backup or moved checkout starts a fresh home.
- F2 (code-review FAIL from the different-family review of fa0856c, `src/env/shell.ts:47`): `checkoutIdentity` fell back to the inode alone when birth time equalled change time. A newly created root has equal times on coarse-timestamp filesystems (reproduced on overlayfs), so the first entry added at the root moved the change time and the same checkout switched volumes. Class: valid; reproduced with `npx vitest run test/env-shell.test.ts -t "one checkout keeps"` against the previous logic: `expected '8929256779:1793977243672048086' to be '8929256779'`. Resolution: the identity is `inode:birthtime` whenever the platform reports a birth time above zero (`identityFromStat`, `src/env/shell.ts:32`); the change time is never read. A birth time does not change while the directory exists, so adding, removing or changing root entries keeps the name. Tests: the pure `test/env-shell-plan.test.ts:57` and the real-filesystem `test/env-shell.test.ts:568` (a fresh directory, then entries added, changed and removed, then a second `env shell` run after a file is added to the checkout).
- Residual, stated exactly and not closed. (1) On a filesystem that reports no birth time (zero: some network, FUSE and older Linux filesystems), only the inode is in the key, so a directory re-created at the same path with a reused inode shares the old volume. An attacker needs the person to delete repository A and clone another repository to the very same path on such a filesystem, and the inode to be reused, which ext-style filesystems often do. It is not closed here because every other identity is either writable from the container or the checkout (a marker file, git state, the origin URL), or needs a host registry plus a signal that the directory was deleted, which is a product decision. (2) Where Node synthesizes the birth time from the change time (no statx, for example blocked by a sandbox; not the case on Node 24's supported kernels), the name changes whenever entries at the root change: that checkout gets a fresh home volume (toolchains download again) and never shares one.
- review-code (own pass, before F1): no finding at confidence 80 or above. The change is a two-line pure function edit and a call-site edit; comments and header are accurate; the merge of main left no conflict residue.
- review-security: no finding at confidence 70 or above after the fix. The volume key is the host path and directory identity read before Docker starts, so code in the container cannot steer it (the `.git/config` origin and the worktree common dir are deliberately excluded). The name is fixed-width hex, so nothing reaches `--mount` unquoted.
- Residual, already recorded in the plan as out of scope: the common-dir mount (`src/env/shell.ts:221`) is chosen by files inside the checkout; a separate ticket is suggested. Old shared `catalyst-env-home-<12 hex>` volumes remain on disk, unmounted.
- scan-reward-hacking: grep of the added lines in `src` and `test` for `as any`, `as unknown`, `@ts-`, `eslint-disable`, `biome-ignore`, `.skip`, `.only` and non-null assertions found none. No tsconfig change.

## Automated Verification Results

✓ `npm run typecheck` (`tsc --noEmit`) exit 0 at the fix head
✓ `npx vitest run test/env-shell-plan.test.ts test/env-shell.test.ts` at the fix head: 56 passed
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
- met: --check uses the same volume as the shell: `test/env-shell.test.ts:529` asserts it
- met: Same path reused by a different repository: a directory deleted and re-created at the same path gets a different home volume, and `--check` still shares the shell's (`test/env-shell.test.ts:552`, red before the fix, green after; residual on filesystems with no birth time is stated under Code Review Findings)
- met: One checkout keeps its volume when entries at its root change: `test/env-shell.test.ts:568` and `test/env-shell-plan.test.ts:57`, red on the previous logic, green after
- met: Volume name valid for Docker at any path: the format test asserts 55 characters of hex for awkward roots and unpinned images

## Recommendations

- Merge when the gate result is green. File the common-dir mount as a separate ticket, as the plan says.

```catalyst-validation-ladder
{"version":1,"steps":[
  {"step":"plan-conformance","verdict":"PASS","materiality":"material","declared":true,"detail":"Phase 1 implemented; one declared review-driven deviation: key adds directory inode and birth time (F1 path reuse, F2 stability), ShellRunInput gains rootIdentity"},
  {"step":"type-safety","verdict":"PASS","detail":"npm run typecheck exit 0 at fix head; reward-hacking scan of added lines found nothing; no lint script configured"},
  {"step":"code-review","verdict":"PASS","detail":"review-code: own pass clean; the different-family review findings F1 (src/env/shell-plan.ts:52, path reuse) and F2 (src/env/shell.ts:47, identity stability) are fixed; residual on birth-time-less filesystems stated in the report and re-checked at the fix head","findings":[{"path":"src/env/shell-plan.ts","line":52},{"path":"src/env/shell.ts","line":47}]},
  {"step":"security-review","verdict":"PASS","detail":"review-security: no finding at or above 70; volume key is the host path the container cannot change"},
  {"step":"security-audit","verdict":"SKIPPED","detail":"no dependency audit configured in this repo; the diff adds no dependency"}
]}
```

---
date: 2026-11-06
source_ticket: CTC-6155
repository: catalyst-cloud-cli
plan: thoughts/shared/plans/2026-11-06-CTC-6155-env-shell-home-volume-per-repository.md
pr: coalesce-labs/catalyst-cloud-cli#618
---

# Validation Report: per-repository env shell home volume (head c24181a)

**Plan**: `thoughts/shared/plans/2026-11-06-CTC-6155-env-shell-home-volume-per-repository.md`
**Validated**: 2026-11-06, fresh run at the head below; no earlier result reused
**Validation Status**: PASS

## Summary

The home volume name is now `catalyst-env-home-<image12>-<sha256(root)[0:24]>`, so two checkouts on one image no longer share a home volume. The two CTC-6155 tests fail on `a1126ea9` for the volume-naming reason and pass at this head. `npm run typecheck` is clean and no reward-hacking pattern appears in the diff. The security audit step is skipped because the repo configures no dependency audit.

## Validation Source

- `git_commit`: c24181a30f06c047977bdf0dc4af655c728c0871
- `branch`: CTC-6155
- `git_main_sha`: 7ec44daa2d30e842c57cdb0bdab71d1afa2ab461
- `git_merge_base`: 7ec44daa2d30e842c57cdb0bdab71d1afa2ab461

### Main movement since the plan

The plan's merge base was 2f11ab3. `git log 2f11ab3..7ec44da` holds one commit, 7ec44da (CTC-6156, #617), which changed `src/env/shell-plan.ts`, `src/env/shell.ts` and both env-shell test files, all plan-referenced. It was merged into the branch (b1300c4, c24181a). It moved the plan's line numbers (the mount is now at `src/env/shell-plan.ts:115`, not 80) and does not count against conformance. The branch now sits directly on main: the branch diff against 7ec44da is only the CTC-6155 change plus documents. No `deviations.json` exists for this ticket.

## Plan Conformance

✓ Phase 1: Per-repository home volume. `homeVolumeFor(image, root)` is at `src/env/shell-plan.ts:49` and its only call passes `input.root` (`src/env/shell-plan.ts:115`). `root` is the realpath'd directory bind-mounted at `/workspace` (`src/env/shell.ts:111`). `ShellRunInput` is unchanged. No origin URL or git common dir feeds the name. Both `shell` and `check` share `shellRunArgs`, so they use the same volume.
✓ Tests: the new pure test is at `test/env-shell-plan.test.ts:39`, the format test follows it, and the integration test is at `test/env-shell.test.ts:529`. The four pinned names were updated; the CTC-6156 tests merged from main use `homeMountForRoot`.
✓ Diff scope against main: `src/env/shell-plan.ts`, two test files and thoughts documents. No README, CHANGELOG or version change, as planned.
✓ The new tests were written with the fix commit (23a56a8 in history); the pre-fix failure is shown below by running them against `a1126ea9`.

## Code Review Findings

- Matches plan: all items above; deviations: none.
- review-code: no finding at confidence 80 or above. The change is a two-line pure function edit and a call-site edit; comments and header are accurate; the merge of main left no conflict residue.
- review-security: no finding at confidence 70 or above. The volume key is the host path chosen before Docker starts, so code in the container cannot steer it (the `.git/config` origin and the worktree common dir are deliberately excluded). The name is fixed-width hex, so nothing reaches `--mount` unquoted.
- Residual, already recorded in the plan as out of scope: the common-dir mount (`src/env/shell.ts:211`) is chosen by files inside the checkout; a separate ticket is suggested. Old shared `catalyst-env-home-<12 hex>` volumes remain on disk, unmounted.
- scan-reward-hacking: grep of the added lines in `src` and `test` for `as any`, `as unknown`, `@ts-`, `eslint-disable`, `biome-ignore`, `.skip`, `.only` and non-null assertions found none. No tsconfig change.

## Automated Verification Results

✓ `npm run typecheck` (`tsc --noEmit`) exit 0
✓ `npx vitest run test/env-shell-plan.test.ts test/env-shell.test.ts -t "two repositories on one image|two checkouts with the same origin"` at head: 2 passed
✗ the same command in a temporary worktree at `a1126ea9` (fetched via `git fetch origin refs/pull/407/head`, since `git fetch origin a1126ea9` was refused) with this head's two test files copied in: 2 failed, both with `AssertionError: expected 'type=volume,src=catalyst-env-home-a19…' not to be 'type=volume,src=catalyst-env-home-a19…'`. Both checkouts got the same image-only volume word. This is the expected acceptance failure. The worktree was removed afterwards.
- No lint script or dependency audit is configured in `package.json`.
- The gate `bun run typecheck && bun run test:coverage` is run last, after this commit; its result is in `/tmp/catalyst-runner-artifact-Plf6Ak/gate-validate.md`.

### Manual Testing Required

- [ ] With Docker, run `catalyst env shell` in two checkouts and check `docker volume ls --filter name=catalyst-env-home-` shows two 55-character names, and `--check` reuses the first.

## Scenarios

- met: Home volume scoped per repository: `homeVolumeFor(image, root)` hashes the mounted checkout path into the name (`src/env/shell-plan.ts:49`, `src/env/shell-plan.ts:115`), so repository A's shell cannot leave a profile in repository B's volume
- met: Acceptance test that fails on a1126ea9 and passes with the fix: both CTC-6155 tests failed at a1126ea9 with identical image-only volume words and pass at c24181a
- met: Volume not steerable from inside the checkout: the key is the realpath'd host root, not the origin URL or common dir, and the integration test holds both equal across two checkouts and still gets different volumes
- met: --check uses the same volume as the shell: `test/env-shell.test.ts:529` asserts it
- met: Volume name valid for Docker at any path: the format test asserts 55 characters of hex for awkward roots and unpinned images

## Recommendations

- Merge when the gate result is green. File the common-dir mount as a separate ticket, as the plan says.

```catalyst-validation-ladder
{"version":1,"steps":[
  {"step":"plan-conformance","verdict":"PASS","materiality":"plan-only","detail":"Phase 1 implemented as planned at c24181a; main's CTC-6156 moved line numbers only; no deviations"},
  {"step":"type-safety","verdict":"PASS","detail":"npm run typecheck exit 0; reward-hacking scan of added lines found nothing; no lint script configured"},
  {"step":"code-review","verdict":"PASS","detail":"review-code: no finding at or above 80"},
  {"step":"security-review","verdict":"PASS","detail":"review-security: no finding at or above 70; volume key is the host path the container cannot change"},
  {"step":"security-audit","verdict":"SKIPPED","detail":"no dependency audit configured in this repo; the diff adds no dependency"}
]}
```

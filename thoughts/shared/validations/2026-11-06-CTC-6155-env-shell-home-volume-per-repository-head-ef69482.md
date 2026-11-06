---
date: 2026-11-06
source_ticket: CTC-6155
repository: catalyst-cloud-cli
plan: thoughts/shared/plans/2026-11-06-CTC-6155-env-shell-home-volume-per-repository.md
pr: coalesce-labs/catalyst-cloud-cli#618
git_commit: ef69482c0f2ebbfeac5812769a7a9828c2a2cffc
branch: CTC-6155
git_main_sha: 7ec44daa2d30e842c57cdb0bdab71d1afa2ab461
git_merge_base: 7ec44daa2d30e842c57cdb0bdab71d1afa2ab461
---

# Validation Report: per-repository env shell home volume (head ef69482)

**Validation Status**: PASS

## Summary

The source and tests at ef69482 are identical to the previously validated 04df97d: the only commit since then (`ef69482`) edits a validation document. The home volume is now named `catalyst-env-home-<image12>-<24 hex of sha256(root NUL identity)>`, where identity is the inode and birth time of the checkout root and of its own `.git`. With no identity the run gets an anonymous volume. I re-read the code and re-ran the checks at this head. Typecheck and the full test suite pass. I found no defect.

Main movement: main is at the merge base, so nothing moved since the branch point.

### Implementation Status

✓ Phase 1: Per-repository home volume - implemented. `homeVolumeFor(image, root, identity)` at `src/env/shell-plan.ts:55`, used at `src/env/shell-plan.ts:122`; `checkoutIdentity(root)` at `src/env/shell.ts:54` fills `rootIdentity` at `src/env/shell.ts:264`. `shell` and `check` share `shellRunArgs`, so both mount the same volume.
✓ Tests: the two-repository test (`test/env-shell-plan.test.ts:41`), the name-shape test and the identity tests are committed.
⚠ Declared deviation (plan-only): the plan keyed on `root` alone and accepted path reuse as out of scope. The code adds directory identity and an anonymous-volume fallback. This is stricter and stays inside the ticket's intent. No `deviations.json` exists, so it is undeclared in that file, but the PR description and earlier validations record it.

### Code Review Findings

- review-code: no finding at confidence 80 or above. The origin URL and git common dir are not in the name. `.git` is read with `lstat` (`src/env/shell.ts:56`), so a planted symlink gets its own identity.
- review-security: no finding at 70 or above. Code in A cannot choose B's volume name: root is realpath'd on the host, and inode and birth time cannot be set from the container. The worktree common-dir mount stays a separate path the plan names as out of scope, and the diff does not touch it. Residual: A's own `.git` repointed at B keeps A's volume, as the comment at `src/env/shell.ts:44` documents.
- Reward-hacking scan of the diff against main (`as any`, `as unknown`, `@ts-*`, lint suppressions, `.skip`, `.only`): no hits.
- Source scope: only `src/env/shell-plan.ts`, `src/env/shell.ts`, and the env-shell tests changed.

### Automated Verification Results

✓ `bun run typecheck` exit 0
✓ `bunx vitest run` exit 0: 230 files passed, 1 skipped; 5657 tests passed, 2 skipped
✗ `bun audit` lists advisories that are already on main. The diff changes no `package.json` or `bun.lock`, so it adds none.
✓ Acceptance: the earlier validation (`thoughts/shared/validations/2026-11-06-CTC-6155-env-shell-home-volume-per-repository-head-04df97d.md`) ran the two-roots test in a worktree of a1126ea9, where it failed, and it passes here. The source has not changed since.

### Manual Testing Required

- [ ] With Docker, run `catalyst env shell` in two checkouts and confirm `docker volume ls --filter name=catalyst-env-home-` shows two distinct 55-character names. This container has no Docker.
- [ ] Plant `~/.bash_profile` in A's shell and confirm B's shell does not run it.

### Recommendations

- Merge. Optionally add a `deviations.json` or update the plan's "NOT doing" line on path reuse.

## Scenarios

- met: Scope the volume per repository: two checkouts on one image get different home volume names (`src/env/shell-plan.ts:122`), covered by `test/env-shell-plan.test.ts:41`.
- met: Code run in repository A can leave a .bash_profile that runs when repository B opens: B's volume name derives from B's host path and directory identity, and nothing A writes (origin URL, common dir, `.git` symlink) enters it.
- met: Acceptance: a test that fails on a1126ea9 and passes with the fix: the two-roots test fails on a1126ea9 (shown by the earlier validation at an identical source) and passes at this head.

```catalyst-validation-ladder
{"version":1,"steps":[
{"step":"plan-conformance","verdict":"PASS","materiality":"plan-only","detail":"Per-repository volume implemented and traced from root to the docker argv. Key is stricter than planned (adds directory identity, anonymous volume when none); the plan's path-reuse exclusion is stale. Source unchanged since 04df97d."},
{"step":"type-safety","verdict":"PASS","detail":"bun run typecheck exit 0; vitest run 5657 passed, 0 failed; reward-hacking scan of the diff found nothing."},
{"step":"code-review","verdict":"PASS","detail":"review-code: no finding at 80 or above."},
{"step":"security-review","verdict":"PASS","detail":"review-security: no finding at 70 or above; the name is not derived from checkout-writable data."},
{"step":"security-audit","verdict":"PASS","detail":"bun audit lists existing advisories; the diff changes no dependency, so none is attributable to it."}
]}
```

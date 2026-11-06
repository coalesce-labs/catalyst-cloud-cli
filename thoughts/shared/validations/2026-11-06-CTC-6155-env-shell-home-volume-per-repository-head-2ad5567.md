---
date: 2026-11-06
source_ticket: CTC-6155
repository: catalyst-cloud-cli
plan: thoughts/shared/plans/2026-11-06-CTC-6155-env-shell-home-volume-per-repository.md
pr: coalesce-labs/catalyst-cloud-cli#618
---

# Validation Report: per-repository env shell home volume

**Plan**: `thoughts/shared/plans/2026-11-06-CTC-6155-env-shell-home-volume-per-repository.md`
**Validated**: 2026-11-06, every result below from runs made in this round at the head named here
**Validation Status**: PASS

## Validation Source

- `git_commit`: 2f5f87a3b11d92d9ef146e29e12bfd124fb08a29
- `branch`: CTC-6155
- `git_main_sha`: 2f11ab3a73810d7f1972ae9c8603374e4df2e8f1
- `git_merge_base`: 2f11ab3a73810d7f1972ae9c8603374e4df2e8f1

Main had not moved past the plan's merge base when `origin/main` was fetched. The head differs from the PR's earlier head 2ad5567 by documentation only. No `deviations.json` exists for this ticket.

## Scenarios

- met: Scope the volume per repository
- met: Acceptance: a test that fails on a1126ea9 and passes with the fix

Basis. Per repository: `homeVolumeFor(image, root)` (`src/env/shell-plan.ts:42-46`) hashes the checkout path into the volume name, and its only call site passes `input.root` (`src/env/shell-plan.ts:84`). Acceptance: `a1126ea9` was fetched through `refs/pull/407/head` (exit 0). In a temporary worktree there, with this branch's two test files copied in, both CTC-6155 tests failed (`test/env-shell-plan.test.ts` "two repositories on one image ..." and `test/env-shell.test.ts` "two checkouts with the same origin name ...") with `AssertionError: expected 'type=volume,src=catalyst-env-home-a19...' not to be ...`, so both repositories got the same volume word. At this head the same two tests pass (2 passed, 36 skipped by the name filter).

## Implementation Status

✓ Phase 1: Per-repository home volume. The diff against the main SHA touches `src/env/shell-plan.ts`, `test/env-shell-plan.test.ts`, `test/env-shell.test.ts` and the research, plan and validation documents. `ShellRunInput` is unchanged.

## Automated Verification Results

✓ `npm run typecheck` exit 0
✓ `npx vitest run` exit 0: 230 files passed, 1 skipped; 5635 tests passed, 2 skipped
✓ `npx vitest run test/env-shell-plan.test.ts test/env-shell.test.ts -t "two repositories on one image|two checkouts with the same origin"` at head: 2 passed
✗ the same command at a1126ea9 with the branch's test files: 2 failed (expected, this is the acceptance proof)
Not run: `test:coverage`; no lint script exists in `package.json`.

## Type-safety gate (validate-type-safety with scan-reward-hacking)

Verdict PASS, base 2f11ab3a73810d7f1972ae9c8603374e4df2e8f1, validate stage (record, never fix).
- Tooling: `bun.lock` present; no `.trunk/`, biome or eslint config, so no linter.
- Step 0: `"strict": true` at `tsconfig.json:9`; the branch changes no tsconfig (`git diff <base> -- '*tsconfig*.json'` is empty).
- Step 1: `npm run typecheck` exit 0.
- Step 2: scan-reward-hacking over the three changed code files with `--base`: a grep of the added lines for patterns 1-7, 9 and 10 (`as unknown as`, `as any`, void tricks, underscore locals, `@ts-*`, non-null assertions, `forEach(async`, lint suppressions, `.skip`/`.only`, `xit`/`fit`) found no match (grep exit 1); patterns 11 and 12 have an empty tsconfig diff. Zero findings.
- Step 3: `tsconfig.json` has no `exclude` entry; no test exclusion.
- Step 4: `npx vitest run` exit 0 (above). PR 618 checks at head 2f5f87a (`gh pr checks`): check, check (node 26), matrix, CodeQL, Summary, bun-runtime and Analyze jobs pass; Mergify and one notifier job are skipped or neutral.
- Step 5: SKIPPED, no linter detected.

## Code Review Findings

review-code skill, base 2f11ab3a73810d7f1972ae9c8603374e4df2e8f1. Scope script: status review, ancestry proven, 3 code files (`src/env/shell-plan.ts`, `test/env-shell-plan.test.ts`, `test/env-shell.test.ts`). Verdict PASS, no finding at confidence 80 or above.
- Guidelines: no CLAUDE.md or AGENTS.md; the two `.agents/rules` files scope to README, skills and release files, not these paths.
- Diff bugs: `homeVolumeFor` has one caller and it passes the new argument; the four pinned names in the tests match the new format.
- History: the change does not undo a recent commit (recent commits on the file are CTC-3550, CTC-6153, CTC-6389).
- Prior review comments: `gh api` shows 0 review comments and 0 reviews on PR 618.
- In-code guidance: no `NEVER`, `MUST`, `invariant` or sync marker in `src/env/shell-plan.ts`.
- Matches plan: yes. Deviations: none. Plan-declared limits, not defects: old shared volumes stay on disk unused; a host path reused for a different repository keeps its volume.

## Security Review

review-security skill, same base. Scope: status review, ancestry proven. Verdict PASS, no confirmed or informational finding. `root` comes from `--root` or git, then `realpathSync` (`src/env/shell.ts:106-111`), and reaches the volume name only as a 24-hex sha256 prefix (`src/env/shell-plan.ts:44-45`), so it cannot add to the `--mount` value. The change removes the shared writable home. The common-dir mount (`src/env/shell-plan.ts:82`) was not changed by this diff; the plan sends it to a follow-up ticket.

## Manual Testing Required

- [ ] With Docker, run `catalyst env shell` in two checkouts, then `docker volume ls --filter name=catalyst-env-home-`: expect two distinct 55-character names, and `--check` reusing the first.
- [ ] Append `echo PWNED >> ~/.bashrc` in checkout A's shell, then open B's shell on a terminal: `PWNED` must not print.

## Recommendations

- Merge-ready. File the common-dir follow-up ticket the plan names.

```catalyst-validation-ladder
{"version":1,"steps":[
  {"step":"plan-conformance","verdict":"PASS","materiality":"plan-only","detail":"single phase implemented as planned; CTC-6155 tests fail at a1126ea9 (2 failed) and pass at head 2f5f87a; typecheck exit 0; vitest exit 0, 5635 passed"},
  {"step":"type-safety","verdict":"PASS","detail":"validate-type-safety base 2f11ab3: tsc --noEmit exit 0, scan-reward-hacking 0 matches on added lines, no tsconfig exclude, vitest exit 0, lint skipped (none configured); PR checks pass"},
  {"step":"code-review","verdict":"PASS","detail":"review-code: no finding at >=80, 5 lenses, 3 code files against 2f11ab3"},
  {"step":"security-review","verdict":"PASS","detail":"review-security: no finding; root reaches the volume name only as a sha256 hex prefix"},
  {"step":"security-audit","verdict":"SKIPPED","detail":"no dependency changes in the diff; no audit run"}
]}
```

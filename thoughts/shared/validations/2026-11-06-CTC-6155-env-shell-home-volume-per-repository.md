---
date: 2026-11-06
source_ticket: CTC-6155
repository: catalyst-cloud-cli
plan: thoughts/shared/plans/2026-11-06-CTC-6155-env-shell-home-volume-per-repository.md
pr: coalesce-labs/catalyst-cloud-cli#618
---

# Validation Report: per-repository env shell home volume

**Plan**: `thoughts/shared/plans/2026-11-06-CTC-6155-env-shell-home-volume-per-repository.md`
**Validated**: 2026-11-06
**Validation Status**: PASS

## Validation Source

- `git_commit`: 23a56a859944bffd0e2c6e6dd604d77293495b55
- `branch`: CTC-6155
- `git_main_sha`: 2f11ab3a73810d7f1972ae9c8603374e4df2e8f1
- `git_merge_base`: 2f11ab3a73810d7f1972ae9c8603374e4df2e8f1

Main has not moved since the plan (plan merge base equals the main SHA), so there is no main movement to report. No `deviations.json` exists for this ticket.

## Scenarios

- met: Scope the volume per repository
- met: Acceptance: a test that fails on a1126ea9 and passes with the fix

## Context Status

✅ Ready for PR creation.

### Implementation Status

✓ Phase 1: Per-repository home volume - fully implemented. `homeVolumeFor(image, root)` at `src/env/shell-plan.ts:42` names the volume `catalyst-env-home-<12 hex image>-<24 hex sha256(root)>` (`src/env/shell-plan.ts:43-45`). Its one call site passes `input.root` (`src/env/shell-plan.ts:84`), the same host path bind-mounted at `/workspace`, so `shell` and `--check` share one name per folder and two folders on one image no longer share a home. `ShellRunInput` is unchanged. The diff touches only `src/env/shell-plan.ts`, the two test files and the research and plan documents, as the plan said.

### Ticket requirements checked against the code

- Scope the volume per repository: met. The name now depends on the mounted checkout path (`src/env/shell-plan.ts:43-45`), which code inside the container cannot change; the origin URL and git common dir are deliberately not used.
- Acceptance test: `test/env-shell-plan.test.ts:39` (pure argv builder) and `test/env-shell.test.ts:468` (through `main`) compare the volume words of two roots on one image.

### Acceptance proof against a1126ea9

`a1126ea9` was not fetchable by SHA (`git fetch origin a1126ea9` fails: it is not a branch tip). It was fetched through `refs/pull/407/head`, and it exists as a commit. In a temporary worktree at `a1126ea9` (removed afterwards) with the branch's two test files copied in:

- `test/env-shell-plan.test.ts -t "two repositories on one image"`: 1 failed. `AssertionError: expected 'type=volume,src=catalyst-env-home-a19...' not to be 'type=volume,src=catalyst-env-home-a19...'`, so both repositories get the identical volume word. That is the defect the ticket names.
- Running both whole files there gave 15 failures. Most are noise, because `a1126ea9` is older than main and lacks later changes the tests rely on, so the single named test above is the evidence.
- A cleaner check: the PR's parent (`2f11ab3`, current main) `src/` with the branch's tests gave 6 failed, 32 passed, including both CTC-6155 tests (`test/env-shell-plan.test.ts:39`, `test/env-shell.test.ts:468`), the format test (`test/env-shell-plan.test.ts:48`) and the updated pinned-name assertions.
- At PR head both files pass: 38 of 38.

### Automated Verification Results

✓ `npx vitest run test/env-shell-plan.test.ts test/env-shell.test.ts` exit 0, 38 passed
✓ `npm run typecheck` (`tsc --noEmit`) exit 0
✓ `npx vitest run` exit 0, 5635 passed, 2 skipped (1 file skipped)
Not run: `test:coverage` (the plan checks it; the full suite passes), a lint script (none in `package.json`).

### Type-safety gate (`validate-type-safety`, with `scan-reward-hacking`)

Verdict PASS, run at base `2f11ab3a73810d7f1972ae9c8603374e4df2e8f1`.
- Step 0, tsconfig: `"strict": true` is set (`tsconfig.json:9`); the branch changes no tsconfig.
- Step 1, type check: `npm run typecheck` (`tsc --noEmit`) exit 0.
- Step 2, `scan-reward-hacking` with `--base` over `src/env/shell-plan.ts`, `test/env-shell-plan.test.ts` and `test/env-shell.test.ts`: PASS. None of the 12 patterns matches any added line (no `as any`, `as unknown as`, `@ts-*` directive, non-null assertion, `forEach(async`, lint suppression, `.skip` or `.only`, or tsconfig change). Zero findings.
- Step 3, test inclusion: no tsconfig excludes tests.
- Step 4, tests: `npx vitest run` exit 0, 5635 passed, 2 skipped. PR 618 checks at the head are all passing or skipped as optional (`check`, `check (node 26)`, `matrix`, CodeQL).
- Step 5, lint: SKIPPED, no linter configured (no `.trunk/`, biome or eslint config).

### Code Review Findings

Produced by the `review-code` skill.

Verdict PASS. Scope: base `2f11ab3a73810d7f1972ae9c8603374e4df2e8f1`, ancestry proven, 3 code files reviewed (`src/env/shell-plan.ts`, `test/env-shell-plan.test.ts`, `test/env-shell.test.ts`). All five lenses ran: guidelines (the repo has no CLAUDE.md or AGENTS.md; `.agents/rules/public-text.md` scopes to README and skills only), diff bugs, history, prior review comments (PR 618 has no review comments) and in-code guidance. No finding at confidence 80 or above.
- Matches plan: `src/env/shell-plan.ts:42-46` and its one call site `src/env/shell-plan.ts:84`, with no other caller of `homeVolumeFor`.
- Deviations: none.
- Potential issues: none from the skill. Plan-declared, not defects: old shared volumes stay on disk unused, and the same host path later reused for a different repository keeps its volume.

### Security review (`review-security`)

Verdict PASS, no confirmed or informational findings. The input is `root`, a `realpathSync` result from `--root` or git (`src/env/shell.ts:106-111`). It reaches the volume name only through a sha256 hex digest (`src/env/shell-plan.ts:44-45`), so the name is fixed-length hex and cannot inject into the `--mount` argument or the docker argv. The change removes the cross-repository shared writable home that the ticket reports. The common-dir mount remains a separate path that the plan assigns to a follow-up ticket; it is not introduced by this diff.

### Manual Testing Required

- [ ] With Docker, run `catalyst env shell` in two checkouts, then `docker volume ls --filter name=catalyst-env-home-`: expect two distinct 55-character names, and `--check` reusing the first.
- [ ] Append `echo PWNED >> ~/.bashrc` in checkout A's shell, open B's shell on a terminal: `PWNED` must not print.

### Recommendations

- Merge-ready. File the common-dir follow-up ticket the plan names.

```catalyst-validation-ladder
{"version":1,"steps":[
  {"step":"plan-conformance","verdict":"PASS","materiality":"plan-only","detail":"single phase implemented as planned; no undeclared deviations; tests fail at a1126ea9 and at 2f11ab3 src, pass at head"},
  {"step":"type-safety","verdict":"PASS","detail":"validate-type-safety (with scan-reward-hacking --base 2f11ab3): tsc --noEmit exit 0, 0 reward-hacking matches, no test exclusion, vitest 5635 passed, lint skipped (none configured); PR checks green"},
  {"step":"code-review","verdict":"PASS","detail":"review-code skill: no findings at >=80 across 5 lenses; 3 code files reviewed against 2f11ab3"},
  {"step":"security-review","verdict":"PASS","detail":"review-security skill: no findings; root reaches the volume name only as a sha256 hex digest"},
  {"step":"security-audit","verdict":"SKIPPED","detail":"no dependency changes in the diff; no audit run"}
]}
```

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

### Code Review Findings

- Matches plan: signature change, one call site, comments, four pinned names and the new tests.
- Deviations: none found.
- Potential issues: old shared `catalyst-env-home-<12 hex>` volumes stay on disk, unused (a decision the plan made explicit). The worktree common-dir mount is a separate write path the plan assigned to a follow-up ticket.

### Manual Testing Required

- [ ] With Docker, run `catalyst env shell` in two checkouts, then `docker volume ls --filter name=catalyst-env-home-`: expect two distinct 55-character names, and `--check` reusing the first.
- [ ] Append `echo PWNED >> ~/.bashrc` in checkout A's shell, open B's shell on a terminal: `PWNED` must not print.

### Recommendations

- Merge-ready. File the common-dir follow-up ticket the plan names.

```catalyst-validation-ladder
{"version":1,"steps":[
  {"step":"plan-conformance","verdict":"PASS","materiality":"plan-only","detail":"single phase implemented as planned; no undeclared deviations; tests fail at a1126ea9 and at 2f11ab3 src, pass at head"},
  {"step":"type-safety","verdict":"PASS","detail":"tsc --noEmit exit 0; vitest full suite 5635 passed; no lint script in this repo; no type escapes in the diff"},
  {"step":"code-review","verdict":"PASS","detail":"manual diff read: no defects found"},
  {"step":"security-review","verdict":"PASS","detail":"manual read: path hashed with sha256, fixed-length hex name, no injection; fix closes the cross-repo home sharing"},
  {"step":"security-audit","verdict":"SKIPPED","detail":"no dependency changes in the diff; no audit run"}
]}
```

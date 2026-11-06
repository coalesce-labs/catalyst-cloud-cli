---
source_ticket: CTC-6155
repository: catalyst-cloud-cli
plan: thoughts/shared/plans/2026-11-06-CTC-6155-env-shell-home-volume-per-repository.md
pr: coalesce-labs/catalyst-cloud-cli#618
git_commit: 04df97df450439271b79b3d9dae2cb343a7fd528
---

# Validation Report: per-repository env shell home volume (head 04df97d)

**Validation Status**: PASS (the Docker checks need a Docker engine this container lacks; see Scenarios)

## Summary

## Validation Source

- `git_commit`: 04df97df450439271b79b3d9dae2cb343a7fd528
- `branch`: CTC-6155
- `git_main_sha`: 7ec44daa2d30e842c57cdb0bdab71d1afa2ab461
- `git_merge_base`: 7ec44daa2d30e842c57cdb0bdab71d1afa2ab461

Main has not moved since the merge base. Branch code changes: `src/env/shell-plan.ts`, `src/env/shell.ts`, `test/env-shell-plan.test.ts`, `test/env-shell.test.ts`. This round reads the code at the head, not the earlier validation documents.

### Implementation Status

- The plan keyed the volume on `sha256(root)` alone. Later review rounds extended it (commits b80e5ff, d9935d2, 38e5a4f, c4f654c). The name is now `catalyst-env-home-<image12>-<sha256(root NUL identity)[0:24]>` (`src/env/shell-plan.ts:52`). The identity is the inode and birth time of the root and of its own `.git` (`src/env/shell.ts:54`). With no birth time or no `.git` the run gets an anonymous volume, `type=volume,dst=...`, removed by `--rm` (`src/env/shell-plan.ts:120`).
- This goes beyond the plan, which accepted path reuse as out of scope. It is stricter and stays inside the ticket's intent. Materiality: plan-only (the plan's "NOT doing" line on path reuse is stale).
- Trace: `root` is the realpath at `src/env/shell.ts:146`, `rootIdentity` is set at `src/env/shell.ts:264`, `homeVolumeFor` is called at `src/env/shell-plan.ts:122`, and the result is the `--mount type=volume,src=...,dst=$HOME` argv word. Neither the origin URL nor `gitCommonDir` enters the name.
- `shell` and `check` share `shellRunArgs`, so both get the same volume.

### Code Review Findings

- review-code: no finding at confidence 80 or above. Identity inputs (inode, birth time) cannot be set from inside the container. `.git` is read with `lstat`, so a planted symlink gets its own identity (test at `test/env-shell.test.ts:582`).
- review-security: no finding at 70 or above. Cross-repository write through the home volume is closed. A's code cannot reach B's volume through the origin URL, the common dir, a symlinked `.git`, path reuse, or emptying and refilling the root. The worktree common-dir mount remains a separate path that the plan already named as out of scope, and it is not in this diff.
- Reward-hacking scan of the diff against `7ec44da`: no `as any`, `as unknown`, `@ts-*`, lint suppressions, `.skip`, `.only`, or non-null assertions.
- Residual (documented in the code comment at `src/env/shell.ts:44`): a person who repoints A's own `.git` at B keeps A's volume. A's `.git` hooks persist anyway.

### Automated Verification Results

- `bunx vitest run test/env-shell-plan.test.ts test/env-shell.test.ts`: 60 passed.
- `bun run typecheck`: exit 0.
- `bun audit`: lists advisories already on main. The diff touches no `package.json` or `bun.lock`, so it adds none.
- Acceptance test, run in a temporary worktree of a1126ea9 (fetched through `refs/pull/407/head`, worktree removed afterwards): the two-roots test fails with `expected 'type=volume,src=catalyst-env-home-a19...' not to be ...`. The same test passes at the head. It matches the committed test at `test/env-shell-plan.test.ts:41`.
- The full repository gate runs last, after this commit. Its result is in `gate-validate.md`, which the orchestrator reads.

### Manual Testing Required

- [ ] With Docker, run `catalyst env shell` in two checkouts and check `docker volume ls --filter name=catalyst-env-home-` shows two distinct 55-character names. This container has no Docker.

```catalyst-validation-ladder
{"steps":[
{"step":"plan-conformance","verdict":"PASS","materiality":"plan-only","detail":"Per-repository volume implemented and traced from root to the docker argv. Key is stricter than planned (adds directory identity, anonymous volume when none); the plan's path-reuse exclusion is stale. Tests added; no file outside src/env and test/env-shell*."},
{"step":"type-safety","verdict":"PASS","detail":"typecheck exit 0; 60 env-shell tests pass; reward-hacking scan of the diff found nothing."},
{"step":"code-review","verdict":"PASS","detail":"review-code: no finding at 80 or above."},
{"step":"security-review","verdict":"PASS","detail":"review-security: no finding at 70 or above; name is not derived from checkout-writable data."},
{"step":"security-audit","verdict":"PASS","detail":"bun audit lists existing advisories; the diff changes no dependency, so none is attributable to it."}
]}
```

## Scenarios

- met: Volume scoped per repository: two checkouts on one image get different home volume names, traced from `root` and its identity to the `--mount type=volume,src=` word.
- met: Stable per checkout, same for check: one checkout keeps its name across runs and between `shell` and `--check`, including when entries at its root or inside `.git` change.
- met: Name not steerable from the checkout: origin URL and git common dir are not in the name, and a planted `.git` symlink gets its own identity.
- met: Reused path gets a fresh home: a repository cloned to a deleted one's path, or put into an emptied root, gets its own volume.
- met: Valid Docker volume name: fixed 55 hex characters for any root, and an anonymous volume when no identity is available.
- met: Acceptance test: the two-roots test fails on a1126ea9 and passes at the head; proven in a temporary worktree, removed afterwards.
- unread: Live Docker check (two checkouts, `docker volume ls`, planted `.bashrc` not run in B): no Docker engine in this container.

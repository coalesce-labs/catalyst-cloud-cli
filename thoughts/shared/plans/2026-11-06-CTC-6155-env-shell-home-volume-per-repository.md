---
date: 2026-11-06T13:01:53+00:00
researcher: claude
git_commit: b32e89e25a9b08a5c555f2c374b57ba4454a590c
branch: CTC-6155
git_main_sha: 2f11ab3a73810d7f1972ae9c8603374e4df2e8f1
git_merge_base: 2f11ab3a73810d7f1972ae9c8603374e4df2e8f1
repository: catalyst-cloud-cli
topic: "Scope the env shell home volume to the mounted checkout, so repositories no longer share one $HOME"
tags: [plan, implementation, env-shell, shell-plan, docker-volume, homeVolumeFor, security]
status: ready_for_implementation
last_updated: 2026-11-06
last_updated_by: claude
type: implementation_plan
source_ticket: CTC-6155
source_research: "[[2026-11-06-CTC-6155-env-shell-home-volume-per-repository]]"
---

# CTC-6155: per-repository env shell home volume, implementation plan

## Overview

`catalyst env shell` (and `--check`) mounts a Docker named volume as the container user's `$HOME`. The name comes from the image alone (`src/env/shell-plan.ts:38-42`), and it is mounted at `src/env/shell-plan.ts:79-80`. Every repository opened with the same image therefore shares one home directory. With the default image that means every repository on the machine. Code run in repository A can leave `~/.bashrc` or `~/.bash_profile` in that volume, and it runs the next time repository B's shell opens, with B's checkout mounted at `/workspace` and B's declared secrets in the environment. HEAD reads `.bash_profile` on the no-toolchain branch (`src/env/shell-plan.ts:35`, `exec bash -l`) and `.bashrc` on the toolchain branch when stdin is a terminal (`src/env/shell-plan.ts:34`).

The fix keys the volume on the image and on the exact host directory the run bind-mounts at `/workspace`, which is `root`. The name becomes `catalyst-env-home-<12 hex of image>-<24 hex of sha256(root)>`. `root` is already a field of `ShellRunInput` (`src/env/shell-plan.ts:51-52`), so the interface does not change. The change is one function signature, its one call site, two comments and the tests.

Acceptance, from the ticket: there is a test that fails on `a1126ea9` and passes with the fix, and the volume is scoped per repository.

This plan was made unattended (`CATALYST_PHASE` set). Every choice the skill would have put to a person is decided below. Each records the reasoning and the options rejected.

## Current State Analysis

- `homeVolumeFor(image)` at `src/env/shell-plan.ts:38-42` returns `catalyst-env-home-` followed by the first 12 hex of the image's `@sha256:` digest. When the image has no digest, it uses the first 12 hex of `sha256(image)`. It takes no other input.
- That function has one caller, `shellRunArgs`, at `src/env/shell-plan.ts:76-80`. `shellRunArgs` in turn has one production caller, `runEnvShell`, at `src/env/shell.ts:224-233`. Both `shell` and `check` modes build their argv there, so both mount the volume.
- `root` is resolved on the host at `src/env/shell.ts:106-111`, from `--root` or else `git rev-parse --show-toplevel` from cwd, then `realpathSync`. It is the only thing bind-mounted at `/workspace` (`src/env/shell-plan.ts:77`).
- The GitHub `owner/name` is read at `src/env/shell.ts:179-180`. `readLocalRepositoryName` (`src/onboard-settings-context.ts:30-81`) gets it from `git config --local --get-all remote.origin.url`. It is used only for display and for the `--check --json` `repository` field.
- Nothing in the CLI lists, labels or removes `catalyst-env-home-*` volumes. `catalyst runner uninstall` removes only volumes that carry the attempt-host label (`src/runner.ts:409-425`).
- Four assertions pin the current name, all in `test/env-shell-plan.test.ts`: lines 31 and 32 (inside `test/env-shell-plan.test.ts:30-33`), line 44 (inside the full-argv test `test/env-shell-plan.test.ts:39-57`) and line 87 (inside the worktree test `test/env-shell-plan.test.ts:81-89`). Nothing in `test/env-shell.test.ts` pins it.
- Baseline equivalence (from the research, by comparing blobs fetched through the GitHub API, because `a1126ea9` is not in this shallow clone): at `a1126ea9` the function body, its call in `shellRunArgs`, the `ShellRunInput` shape, the `shellRunArgs` call in `runEnvShell` and the test fixtures are identical to HEAD in every volume-related line. Only line numbers differ. At HEAD the function is at line 39 and the mount at line 80.

## Desired End State

- For one image, two different checkout directories get two different home volumes.
- One checkout gets the same volume on every run, and the same volume for `--check` as for the shell.
- Nothing inside the checkout, the git config or the remote URL can make repository A's run use repository B's volume.
- The volume name matches Docker's local-driver rule `^[A-Za-z0-9][A-Za-z0-9_.-]+$` and is a fixed 55 characters. That is far below the 255-byte filename limit under `/var/lib/docker/volumes/`.
- `bun run typecheck`, `bun run test` and `bun run test:coverage` pass.

### Key Discoveries:

- `root` is the right identity because the volume then follows the mounted content exactly. The only repository content inside the container is the directory bind-mounted at `/workspace` (`src/env/shell-plan.ts:76-78`), and that is `root`. A volume keyed on `root` is only ever mounted next to that same directory. Code running in A can write A's checkout and A's volume, and nothing else that this change names.
- The GitHub `owner/name` is attacker-controlled. `readLocalRepositoryName` reads `remote.origin.url` from the checkout's own `.git/config` (`src/onboard-settings-context.ts:37-52`). That file is inside the read-write `/workspace` mount, so code in A can set A's origin to B's URL. A name-keyed volume would then hand A's next run B's volume, which is exactly the collision the ticket forbids. The codebase-analyzer sub-agent confirmed this empirically with git 2.55.0. It is also `null` for non-GitHub, `ssh://`, multi-origin or no-origin repositories (`src/onboard-settings-context.ts:30-81`), and the fallback `basename(root)` (`src/env/shell.ts:180`) is not unique.
- The worktree common dir is attacker-controlled as well. `git rev-parse --git-common-dir` (`src/env/shell.ts:53-55`, used at `src/env/shell.ts:204-219`) follows the worktree's `.git` file and `commondir` files, which sit inside the mounted checkout. Rewriting them redirects the result, and the sub-agent confirmed that empirically. So it must not feed the volume name.
- `root` resolved without `--root` can be redirected by `core.worktree` in `.git/config` (sub-agent, tested). The redirect changes the mounted directory and the volume together, though. If cwd A resolves to B's path, B is mounted, B's declaration is read and B's volume is used. No A content is in that container, because a common dir inside root is not mounted (`src/env/shell.ts:214`). The invariant "volume = f(image, mounted directory)" still holds.
- Naming precedent: the codebase already turns a path into a name with `createHash("sha256").update(dir).digest("hex").slice(0, 32)` (`src/update-sdk.ts:222`). It already validates volume names with `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/` (`src/runner-update-fleet.ts:887`).
- Docker constraints (external-research sub-agent, from moby `daemon/names/names.go` and `daemon/volume/local/local.go`): local volume names must match `^[a-zA-Z0-9][a-zA-Z0-9_.-]+$`, which means at least 2 characters. The local driver enforces this. Docker sets no length cap of its own. The name is one path component, so the filesystem's NAME_MAX (255 bytes) applies, and Docker Desktop's VM is the same. Commas split a `--mount` value. A hex-only suffix needs no quoting.
- Test seams: `recordingPort()` (`test/env-shell.test.ts:57-99`), the per-test `repo` (`test/env-shell.test.ts:110-116`), and the `deps()` and `shell()` helpers with per-call overrides (`test/env-shell.test.ts:118-135`). A second temp checkout follows the pattern in `test/env-shell.test.ts:453-466`.

## Decisions (made unattended; the alternatives are recorded)

1. **What counts as "a repository": the realpath'd checkout directory `root`, hashed.** Chosen because it is the one identity the container cannot influence. It is fixed on the host before Docker starts, and it is exactly the directory mounted at `/workspace`, so the volume can never be shared with content from another directory. It needs no new input, no sign-in and no git call. `ShellRunInput.root` is already there.
   - **Null `owner/name` is not an issue**, because the name is never consulted. Non-GitHub, multi-origin and non-git directories get a per-directory volume like everything else.
   - **Rejected: GitHub `owner/name`.** Code in A writes it through `.git/config`, so A can claim B's identity. It is also `null` in common cases, and the only fallback, `basename(root)`, collides between repositories that share a directory name.
   - **Rejected: `owner/name` combined with `root`.** This adds nothing to separation, since `root` alone already separates repositories. Its only effect is that a repository whose origin changes gets a new volume, at the price of a git call on the naming path.
   - **Rejected: `gitCommonDir` or the main checkout's path, to share one volume across a clone's linked worktrees.** The worktree's own `.git` and `commondir` files choose it, so it is container-influenceable.
   - **Rejected: the cloud `repoId`.** It needs a sign-in and a cloud read, and `env shell` needs neither (`README.md:324`).
   - **Accepted consequences:** each linked worktree and each clone gets its own volume. Moving a checkout starts a fresh home. Each new volume re-downloads any declared toolchain version the image lacks (`src/env/shell.ts:76`). If the person deletes repository A and clones repository B into the very same path, B inherits A's volume. That is the person's own choice of directory, and it falls outside the ticket's cross-repository path, which is two repositories open side by side. It is recorded under "What We're NOT Doing".
2. **Name shape: `catalyst-env-home-<image12>-<root24>`.**
   - `<image12>` is unchanged from today: the first 12 hex of the digest, or of `sha256(image)`. This keeps the existing rationale "a new image starts fresh" (`src/env/shell-plan.ts:38`).
   - `<root24>` is the first 24 hex (96 bits) of `sha256(root)`, hashing the UTF-8 string. 24 hex makes an accidental collision between the directories on one machine negligible. The container cannot pick `root`, so there is no chosen-input attack to size against. 24 hex also keeps the name short.
   - Both components are fixed-width lowercase hex joined by `-`, so the name is unambiguous and always matches Docker's charset. Total length is 18 + 12 + 1 + 24 = 55 characters, whatever the path length or characters. Spaces, Unicode and `=` never reach the name. Commas and line breaks in `root` are already refused before this point (`src/env/shell.ts:118-119`).
   - **Rejected: a slug of the path.** Paths can exceed 255 bytes and contain characters Docker refuses.
   - **Rejected: one hash over `image + root`.** That drops the readable image component and gains nothing.
   - **Rejected: keeping 12 hex for the root.** It is workable, but 24 hex costs nothing.
3. **`--check` uses the same per-repository volume as the shell.** No code is needed: both modes share `shellRunArgs`. `--check` runs `mise where` and `mise install` with the same `HOME` (`src/env/shell-plan.ts:23`). Sharing the volume makes `--check` warm the cache the shell then uses, and it reports what the shell will actually see. The repository's own volume is not a cross-repository channel.
   - **Rejected: no volume (ephemeral home) for `--check`.** It would re-download on every check, could report a state that differs from the shell's, and adds a mode branch to the argv builder.
   - **Rejected: a separate check volume.** It brings no security gain within one repository.
4. **Existing `catalyst-env-home-<12 hex>` volumes are left alone, with no label and no cleanup command.** After the fix the CLI never mounts them again, which also stops any file already planted in the shared volume from reaching another repository. They are unreferenced data on the person's Docker engine, removable with `docker volume rm`.
   - **Rejected: adding a label now** (`--mount ...,volume-label=` works only at first creation, per the moby source). Nothing would read it, and that is scope beyond the ticket.
   - **Rejected: a cleanup verb or automatic removal.** Deleting a person's data unprompted is riskier than leaving it, and no verb exists to extend. `catalyst runner uninstall` (`src/runner.ts:409-425`) keeps ignoring these volumes, because it filters by label.
5. **No README, CHANGELOG or version change in this PR.**
   - The repo's fix PRs touch only `src/` and `test/`. The follow-ups to the same review (#409, #410, #439) changed only `src/env/*` and `test/env-shell*`.
   - CHANGELOG entries are written under a `## <version>` heading by the release PR (CONTRIBUTING.md, "Releases" step 2). `CHANGELOG.md` has no "Unreleased" section, and its newest heading is `## 0.16.46`.
   - Version bumps go through the release train (`.agents/rules/release-train.md:12`) and are not part of a fix.
   - The README says nothing about the home volume today. Adding product copy is out of scope and would bring in `.agents/rules/public-text.md`.
   - The PR description carries suggested release-note text for whoever cuts the next patch release: "`catalyst env shell` now keeps a separate home directory for each repository folder, so files one repository's shell leaves in its home no longer reach another's. Each folder starts with a fresh home; toolchain versions the image lacks are downloaded again once. Older shared homes are no longer used; remove them with `docker volume ls --filter name=catalyst-env-home-` and `docker volume rm`."
6. **Commit and PR convention:** `fix(env): CTC-6155 — <outcome>`, the same form as `fix(env): CTC-6153 — ...`.

## What We're NOT Doing

- No change to `ShellRunInput`, `runEnvShell`'s inputs, the start script or any other argv word.
- No label, listing, migration or removal of old volumes, and no new verb.
- No README, CHANGELOG, `package.json` version or release-train change.
- No defence for the same path being reused for a different repository later. The volume follows the directory.
- **Follow-up, out of scope:** the worktree common-dir mount (`src/env/shell.ts:204-219`, mounted read-write at `src/env/shell-plan.ts:78`) is chosen by files inside the checkout. Code in A could redirect A's next run to mount another clone's `.git` read-write, which allows hooks. That is a separate cross-repository write path, unrelated to the home volume. Report it as a new ticket rather than widening this one.
- No change to `.bashrc` and `.bash_profile` reading. Within one repository the home is that repository's own.

## Implementation Approach

The fix is a one-parameter change to a pure function, done test-first:

1. Add tests that state the per-repository property, through both the pure argv builder and `main`. Run them to see them fail for the right reason, with identical volume words.
2. Change `homeVolumeFor(image)` to `homeVolumeFor(image, root)` and pass `input.root` at its one call site.
3. Update the four pinned name assertions and the two comments.

## Phase 1: Per-repository home volume

### Overview

Both modes, `shell` and `check`, mount `catalyst-env-home-<image12>-<sha256(root)[0:24]>`.

### Tests First (Red):

#### 1. New pure tests in `test/env-shell-plan.test.ts`

Add them after the existing `homeVolumeFor` test (`test/env-shell-plan.test.ts:30-33`):

```ts
const homeMount = (argv: string[]) => argv.find((word) => word.startsWith("type=volume,")) ?? "";

test("two repositories on one image get different home volumes; one repository keeps its own (CTC-6155)", () => {
  const web = homeMount(shellRunArgs({ ...base, mode: "shell", tty: true }));
  const api = homeMount(shellRunArgs({ ...base, root: "/Users/ana/src/api", mode: "shell", tty: true }));
  expect(api).not.toBe(web);
  expect(homeMount(shellRunArgs({ ...base, mode: "shell", tty: false }))).toBe(web);
  expect(homeMount(shellRunArgs({ ...base, mode: "check", tty: false }))).toBe(web);
  expect(homeMount(shellRunArgs({ ...base, mode: "shell", tty: true, gitCommonDir: "/Users/ana/src/api/.git" }))).toBe(web);
});

test("the home volume name is a valid Docker volume name of fixed length for any root", () => {
  for (const root of ["/Users/ana/src/web", "/home/a b/ünï=code", `/${"x".repeat(400)}`, "C:\\Users\\ana\\web"]) {
    for (const image of [IMAGE, "not-pinned"]) {
      const name = homeVolumeFor(image, root);
      expect(name).toMatch(/^catalyst-env-home-[0-9a-f]{12}-[0-9a-f]{24}$/);
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]+$/);
      expect(name).toHaveLength(55);
    }
  }
});
```

- **Why the first test fails on HEAD and on `a1126ea9`.** `shellRunArgs` passes only `input.image` to `homeVolumeFor` (`src/env/shell-plan.ts:80`, and line 74 at `a1126ea9`). Both calls therefore produce `type=volume,src=catalyst-env-home-a19f7b0859a9,dst=/home/catalyst`, and `expect(api).not.toBe(web)` fails. The test uses only APIs that exist unchanged at `a1126ea9` (`shellRunArgs`, `ShellRunInput`, the `base` fixture), so it typechecks there and fails on the assertion alone. That makes it the ticket's acceptance test. The `gitCommonDir` line pins that the common dir does not steer the name.
- **Why the second test fails.** At HEAD and at `a1126ea9`, the call `homeVolumeFor(image, root)` is a `tsc --noEmit` error (expected 1 argument). Under vitest the extra argument is ignored, and the 12-hex-only name fails the `-[0-9a-f]{24}$` match and the length check.

#### 2. New integration test in `test/env-shell.test.ts`

Add it inside `describe("catalyst env shell (interactive)")`, after `test/env-shell.test.ts:453-466`:

```ts
test("two checkouts with the same origin name and common dir get different home volumes; --check shares the shell's (CTC-6155)", async () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), "catalyst-env-other-")));
  const common = realpathSync(mkdtempSync(join(tmpdir(), "catalyst-env-common-")));
  try {
    writeDeclaration(other, OAKMONT);
    const over = { readRepositoryName: async () => "oakmont-labs/web", gitCommonDir: async () => common };
    const homeOf = (port: ReturnType<typeof recordingPort>) =>
      port.rec.runs[0]?.argv.find((word) => word.startsWith("type=volume,")) ?? "";
    const a = recordingPort();
    expect(await shell([], a.docker, over)).toBe(0);
    const b = recordingPort();
    expect(await main(["env", "shell", "--root", other], ctx, deps(b.docker, over))).toBe(0);
    expect(homeOf(b)).not.toBe(homeOf(a));
    const again = recordingPort();
    expect(await shell(["--check"], again.docker, over)).toBe(0);
    expect(homeOf(again)).toBe(homeOf(a));
    expect(homeOf(a)).toMatch(/^type=volume,src=catalyst-env-home-[0-9a-f]{12}-[0-9a-f]{24},dst=\/home\/catalyst$/);
  } finally {
    rmSync(other, { recursive: true, force: true });
    rmSync(common, { recursive: true, force: true });
  }
});
```

- **Why it fails on HEAD and on `a1126ea9`.** Both runs use the same default image, `RUNNER_HOST_IMAGES.runner`, and the name depends only on the image. Both argv words are therefore `type=volume,src=catalyst-env-home-<default digest 12>,dst=/home/catalyst`, and `expect(homeOf(b)).not.toBe(homeOf(a))` fails.
- It drives the real entry point, `main` to `runEnvShell` to `shellRunArgs`, with the repository name and the common dir held identical across the two checkouts. That models A forging B's origin URL and common dir. Only an identity based on `root` passes.
- It uses only seams that exist at `a1126ea9` (`EnvShellDeps.readRepositoryName`, `EnvShellDeps.gitCommonDir`), so it typechecks there. `test/env-shell.test.ts` is otherwise the same as at `a1126ea9` apart from display strings.

#### 3. Existing assertions that must change (they pin the old name)

| Location | Today | After |
|---|---|---|
| Line 30 title and lines 31-32, in `test/env-shell-plan.test.ts:30-33` | `homeVolumeFor(IMAGE)` → `"catalyst-env-home-a19f7b0859a9"`; `homeVolumeFor("not-pinned")` matches `^catalyst-env-home-[0-9a-f]{12}$` | Retitle to "homeVolumeFor names the volume by the image digest's first 12 hex and the checkout path's sha256". Assert `homeVolumeFor(IMAGE, "/Users/ana/src/web")` is `"catalyst-env-home-a19f7b0859a9-0e7676587a0a89966444e3c9"`, and `homeVolumeFor("not-pinned", "/Users/ana/src/web")` matches `^catalyst-env-home-[0-9a-f]{12}-0e7676587a0a89966444e3c9$`. The one-argument call would also be a `tsc` error. |
| Line 44, in the full-argv test `test/env-shell-plan.test.ts:39-57` | `type=volume,src=catalyst-env-home-a19f7b0859a9,dst=/home/catalyst` | `type=volume,src=catalyst-env-home-a19f7b0859a9-0e7676587a0a89966444e3c9,dst=/home/catalyst` |
| Line 87, in the worktree test `test/env-shell-plan.test.ts:81-89` | same old word | same new word as line 44 (the root there is `/Users/ana/src/web` too) |

`0e7676587a0a89966444e3c9` is `sha256("/Users/ana/src/web")`'s first 24 hex, computed with Node's `crypto` while writing this plan. For reference, `/Users/ana/src/api` gives `539bc1bdd2ac2c25c9fa830b`. Nothing in `test/env-shell.test.ts`, `test/env-shell-docker.test.ts`, `test/env-shell-pull.test.ts` or `test/env-shell-declaration.test.ts` pins the name. The `--mount` count at line 462 (in `test/env-shell.test.ts:453-466`) is unchanged, because no mount is added.

**Red check:** run `bunx vitest run test/env-shell-plan.test.ts test/env-shell.test.ts` before touching `src/`. The two "different volumes" tests must fail on `not.toBe`, and the format test on the regex. `bun run typecheck` must report the new two-argument `homeVolumeFor` calls, which is expected until Green.

### Implementation (Green):

#### 1. `src/env/shell-plan.ts`

Replace `src/env/shell-plan.ts:38-42`:

```ts
/** One home volume per image digest and checkout: downloaded toolchains and history persist for this
 *  repository folder, a new image starts fresh, and no other repository's shell ever mounts it (CTC-6155).
 *  Keyed on the host path mounted at /workspace, which nothing inside the container can change; never on the
 *  origin URL or git common dir, which the checkout's own files decide. */
export function homeVolumeFor(image: string, root: string): string {
  const digest = /@sha256:([0-9a-f]{12})/.exec(image)?.[1] ?? createHash("sha256").update(image).digest("hex").slice(0, 12);
  const checkout = createHash("sha256").update(root).digest("hex").slice(0, 24);
  return `catalyst-env-home-${digest}-${checkout}`;
}
```

At `src/env/shell-plan.ts:80`, change `homeVolumeFor(input.image)` to `homeVolumeFor(input.image, input.root)`.

`ShellRunInput` (`src/env/shell-plan.ts:48-62`) is unchanged, so there is no new required field and no `tsc --noEmit` fallout at `src/env/shell.ts:224-233` or at the `shellRunArgs({ ...base })` calls in `test/env-shell-plan.test.ts`. The only typecheck effect is the `homeVolumeFor` arity, which matters only to the tests listed above. There are no other callers (`dist/` is untracked build output).

Update the header comment at `src/env/shell-plan.ts:1-4` so that "the home volume's name" reads "the home volume's name (per image and checkout)". Optional, but keep it accurate.

### Refactor (if needed):

None expected. If the inline `homeMount` helper is wanted in both test files, keep two local copies. Test files here do not share helpers.

### Success Criteria:

#### Automated Verification:

- [ ] Red observed first: the new tests fail on `not.toBe` and on the format regex before `src/` changes.
- [ ] `bunx vitest run test/env-shell-plan.test.ts test/env-shell.test.ts` passes.
- [ ] `bun run typecheck` (`tsc --noEmit`, which covers `src` and `test`) passes.
- [ ] `bun run test` passes in full.
- [ ] `bun run test:coverage` stays at or above the thresholds in `vitest.config.ts`.
- [ ] `git diff --stat origin/main` shows only `src/env/shell-plan.ts`, `test/env-shell-plan.test.ts` and `test/env-shell.test.ts`, plus this plan.

#### Manual Verification:

- [ ] With Docker available, run `catalyst env shell` in two different checkouts, then `docker volume ls --filter name=catalyst-env-home-`. Expect two distinct 55-character names. Re-running in the first checkout reuses its name, and `--check` there uses the same one.
- [ ] Repository-A-to-B scenario: in checkout A's shell, run `echo 'echo PWNED' >> ~/.bashrc; exit`. Open checkout B's shell on a terminal with a toolchain declared. `PWNED` is not printed.
- [ ] The old `catalyst-env-home-<12 hex>` volume is still present and no longer mounted.

---

## Testing Strategy

Approach: test-driven, Red then Green then Refactor, in one phase. The change is a single pure function.

- **Unit (pure argv builder):** the cross-repository property, stability, `check` = `shell`, `gitCommonDir` independence, and the Docker charset and length for awkward paths and unpinned images, all in `test/env-shell-plan.test.ts`.
- **Integration (through `main` with a recording docker port):** two real temp checkouts with the same claimed origin name and the same common dir get different volumes, and `--check` reuses the shell's, in `test/env-shell.test.ts`.
- **Acceptance mapping:**
  - "Fails on `a1126ea9`": the two "different home volumes" tests use only APIs present unchanged at `a1126ea9`, and at that commit both inputs produce the identical word `catalyst-env-home-<12 hex>`.
  - Caveat carried from the research: `a1126ea9` is absent from this shallow clone, so the baseline failure is established by the identical volume lines at that commit, compared through the GitHub API, not by executing the tests there. Implementation can confirm it by checking out the test files onto a `gh`-fetched `a1126ea9` tree, if the network allows.
- No Docker is needed: every test uses the injected port or the pure builder.
- **Plan-time trial:** the two "different home volumes" tests were run against a throwaway copy of HEAD's `src/` and `test/` while this plan was written. The checkout was not modified.
  - Before the Green change, both failed on `not.toBe` with identical `catalyst-env-home-<12 hex>` words.
  - After the Green change and the pinned-name updates above, both passed, and `tsc --noEmit` printed no errors.
  - The one other failure in that copy was "--check in this repository's own checkout". That test reads `.catalyst/` from the real repo root, which the copy lacked, so it is unrelated to this change.

## Verification

- Automated: the commands in Phase 1's Automated Verification.
- Manual: the Docker checks in Phase 1's Manual Verification.
- Review focus: confirm that the name is never derived from `repository` (`src/env/shell.ts:179-180`) or `gitCommonDir`.

## Performance Considerations

Two `sha256` calls on short strings per run, which is negligible. The cost to people: each checkout's first shell starts with an empty home, so toolchain versions the image lacks download once per checkout instead of once per image. That was accepted in Decision 1.

## Migration Notes

There is no migration. Old volumes keep their data and are no longer mounted. The suggested release-note text in Decision 5 tells people how to remove them.

## Files in scope

- `src/env/shell-plan.ts`: `homeVolumeFor` gains a `root` parameter, and the call and the comments change.
- `test/env-shell-plan.test.ts`: two new tests, plus updates to the pinned names at lines 31, 32, 44 and 87.
- `test/env-shell.test.ts`: one new integration test.
- Read and unchanged: `src/env/shell.ts`, `src/onboard-settings-context.ts`, `src/runner.ts`, `README.md`, `CHANGELOG.md`, `package.json`.

## References

- Ticket: CTC-6155, from the post-merge App review of PR #407 (CTC-3550) at `a1126ea9`, check run 117884939589.
- Research: `thoughts/shared/research/2026-11-06-CTC-6155-env-shell-home-volume-per-repository.md`
- Similar naming: `src/update-sdk.ts:222` (path to sha256 slice); volume-name validation `src/runner-update-fleet.ts:887`.
- Prior fix PRs on the same file and their scope: #409 (CTC-6152), #410 (CTC-6153), #439 (CTC-6389).

# CTC-5723 — research result (evidence-based root cause)

Ticket: "A Mac runner re-installed over an existing catalyst-host project should run phases, so that
its thoughts custody mounts match what the supervisor checks instead of every grant failing at
launch."

Repo: `coalesce-labs/catalyst-cloud-skills`, branch `CTC-5723`, base `5f796de9cbae4c52c9b5c6eb28c6413c7d8d6f78`.

## 1. The `/host_mnt` lead: NOT CONFIRMED (evidence gap recorded)

The task asked for one real refused-container log capturing expected mount source / read-only vs
Engine-actual mount source / read-only, from existing read-only mini-2 evidence.

What the existing read-only evidence actually contains
(`thoughts/repos/catalyst/shared/research/2026-10-12-unattended-run-root-causes.md` §6, read-only;
host observations were taken over ssh before mini-2 was drained):

- The supervisor's alerts on mini-2 were `darwin_thoughts_custody_mount_mismatch` three times
  (13:46:09Z–13:46:41Z), then `darwin_thoughts_custody:engine_identity` at 13:46:50Z, then
  `host_acquisition_budget_exhausted` from 13:47:12Z.
- The firing check is the supervisor's post-create check in catalyst-cloud
  (`apps/host-agent/src/supervisor/thoughts-custody.ts:254-270`, called from
  `apps/host-agent/src/supervisor/lifecycle.ts:1077-1110`): the supervisor creates the phase
  container, reads the Engine's own mount list, and compares each bind's source and read-only flag
  to the authority's expected list as exact strings.
- On the supervisor's own container, Docker Desktop reports short-syntax binds as
  `/host_mnt/Users/ryan/...` while long-syntax binds are reported as `/Users/ryan/...`. The
  evidence itself labels the session-container translation "**Lead, not proven**" and states:
  "Reading the actual Engine mounts of one refused container (the alert should log them) would
  settle it."

No refused-container expected/actual mount log exists anywhere in the available evidence
(searched the shared thoughts store for `host_mnt`, `mount_mismatch`, expected/actual mount
records). mini-2 is drained (supervisor stopped 13:48:57Z, 0 slots) and the task forbids changing
the mini-2 runtime or credentials; this sandbox has no mini-2 route anyway.

**Gap recorded: the `/host_mnt` translation cause is unconfirmed.** Per the host-roll addendum,
the conditional normalization fix in `coalesce-labs/catalyst-cloud` is therefore NOT made. No
cross-repo branch was created. Making that edit speculatively — or "confirming" the cause from the
supervisor-container observation alone — would overstate the evidence. The related
criterion "mismatch output names mount target, expected source + ro, actual" lives with that
supervisor-side check in catalyst-cloud (`apps/host-agent`), which this carrier must not modify;
it remains open there together with the unconfirmed cause.

## 2. The stale-image lead: refuted on facts, but it exposed a real installer defect

The flow-doctor brief's lead ("the supervisor still runs the Sep 5 image 3331ebc4 … which
predates CTC-5506's custody code") is wrong on its facts (same evidence doc §6):

- `3331ebc4…` was built 2026-10-11T12:20Z, not 2026-09-05. Its revision `744846f8` is not a commit
  on GitHub, so it is a local candidate build.
- It already contains the custody code — it is the image raising the custody alerts. It is also
  the digest this repo pins at the base commit (`src/onboard-runner.ts` `RUNNER_HOST_IMAGES.supervisor`).
- So "onboard did not recreate the supervisor on a current image" did not happen on mini-2: the
  running supervisor was already the current pin.

That a **local candidate build** is the enrolled image is exactly what makes the installer defect
below bite: a local-only digest can be evicted from the engine, and nothing in the installer could
ever repair it.

## 3. Source-verified installer behavior on re-install over an existing project (this repo)

All line numbers at base `5f796de`:

1. **The custody state silently keeps the enrolled producer helper image.**
   `src/onboard-runner-custody.ts:240-265`: on an existing state the installer sets
   `producerSupervisorImage = row.supervisorImage` ("The enrolled producer attests its helper
   image. A runtime update does not re-enroll it.") and runs the signed bootstrap proof against
   that old digest (`:320`), never against the current pin.
2. **Re-install hard-fails once the enrolled digest is evicted.**
   `src/onboard-runner-custody.ts:275` requires the engine to still cache the enrolled digest
   (`producer_helper_cache_unavailable` otherwise), and
   `src/onboard-runner-custody.ts:427-429,453` inspects it separately. A local candidate digest
   that Docker Desktop pruned makes every re-install refuse with
   `runner_thoughts_custody_unavailable` — the supervisor is then never recreated and phases
   cannot run. Worse, the producer itself keeps requesting that digest for every custody exchange
   (vendored `producer.mjs`, `observeEngine`: `state.config.supervisorImage`, cache-only), so
   every grant's custody exchange fails for good with no self-repair path.
3. **The compose side already recreates the supervisor on the current pin.**
   `src/onboard-runner.ts` act() rewrites `.env` (`CATALYST_SUPERVISOR_IMAGE` = current pin,
   `:849-881`, `:1125-1180`) and runs `docker compose … up --detach` (`:560-567`, `:1239`); a
   changed image/env is a config change Compose recreates on. The check side flags a live
   container on an older digest of the same repository as changed
   (`:332-353`, `:1023-1029`; test "saved intent and a live old supervisor do not satisfy the
   current release"). The only thing that can block this path on macOS is the custody failure in
   (2), which aborts act() before `composeUp`.

## 4. Root cause (installer half, this repo)

A Mac runner re-installed over an existing catalyst-host project cannot repair its Darwin thoughts
custody when the enrolled producer helper image no longer matches the current pin — the state is
silently kept on the old digest (`producerSupervisorImage = row.supervisorImage`), the old digest
must remain cached forever or re-install refuses, and the bootstrap proof is never taken against
the current pinned image. With a local candidate build enrolled (as on mini-2), pruning that
digest bricks every custody exchange and every re-install attempt, so phases can never launch.
(The grant-launch mount-mismatch half of the ticket is the separate, unconfirmed
`/host_mnt` lead in catalyst-cloud, §1.)

## 5. Fix implemented here (installer half)

In `src/onboard-runner-custody.ts`, re-attest the enrolled producer on the current pinned helper
image at re-install, mirroring first enrollment:

- The existing-state checks still authenticate `row.supervisorImage` (pin format + same
  repository — `existing_authority_mismatch` otherwise), but the digest no longer has to be
  cached and is no longer the proof target.
- The engine gate requires exactly the current pin to be cached (`cachedSupervisor`, cache-only as
  before); the separate enrolled-helper inspect and `producer_helper_cache_unavailable` refusal
  are removed.
- When the enrolled digest differs from the current pin, `producer.json` is atomically replaced
  (same authority, key, executable pins; only `supervisorImage` changes) before the service
  kickstart, and the signed bootstrap proof then runs through the producer on the current pin —
  byte-symmetric with first enrollment, which also records the helper before proving it, and
  keeps the retry story identical (a refused proof leaves a repairable state that the next
  re-install re-proves).
- With the state on the current pin, re-install reaches `composeUp`, and Compose recreates the
  supervisor on the current pinned image (§3.3).

Tests first: `test/onboard-runner-custody.test.ts` (re-attest replaces the recorded helper and
preserves every other byte; same-image re-install keeps the config byte-identical; the engine seam
no longer receives or reports a separate producer helper), `test/onboard-runner-custody-engine.test.ts`
(exactly one supervisor cache inspect remains), and `test/onboard-runner.test.ts` (re-install over
an existing project re-attests custody on the new pin, records it in `.env`, and reaches
`composeUp`).

## 6. Explicitly out of scope / open

- The supervisor-side mount-mismatch normalization and its expected/actual output belong to
  `coalesce-labs/catalyst-cloud` `apps/host-agent`, gated on one real refused-container log from
  mini-2 confirming the `/host_mnt` translation (§1). Not edited by this carrier.
- mini-2 stays drained; any image recreate there belongs to host-roll. The undrain proof (one real
  phase passing on mini-2) cannot be run from this sandbox.

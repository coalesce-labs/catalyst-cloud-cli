---
name: unstick
description: >-
  Get a stuck Catalyst Cloud ticket moving again. Use when the person asks "why is this parked and can you release it?", "unpark this", "get things flowing again", "the outage is over, retry what failed", or hands you a ticket that is not moving. Reads why nothing runs and what holds the ticket through the catalyst CLI, decides whether the recorded cause is fixed, previews the release, releases every governor holding the ticket the right way (or one failure class across a team), and raises an ask only for what a person has to do. Never releases a cause it cannot show changed without saying so.
allowed-tools: Bash(catalyst:*) Bash(npx -p @catalyst-cloud/cli catalyst:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills@0.16.22 — written in this repository for customer accounts -->

# Unstick

You get one stuck ticket, or one set of tickets stuck for the same reason, moving again. The cloud parks or holds a ticket when retrying would only repeat a failure: after repeated failures, when the repair-round cap is spent, when a repair changed nothing, when the same validate failure recurred. Each of those is a governor. Once its cause is fixed, the person's own key releases most of them. Two refuse that release: a round-threshold hold (a push the fleet did not make, or an answer to its ask, grants one more cycle) and a review that will not converge (a human comment on the ticket resumes it).

## Run first

Scripts are run, never read. Each prints `--help`; exit 2 means this machine is not connected (run `catalyst login`).

- `node scripts/unstick.mjs <ticket>`: one JSON document: the eligibility explanation, the execution history (every governor holding the ticket with what releases it, and past releases), and a dry-run release showing what a release would clear and refuse. Changes nothing.
- `node scripts/unstick.mjs <ticket> --because "<what changed>"`: the same, then the real release. Add `--retry-unchanged` only when you can say what changed outside what the cloud can see.
- `node scripts/unstick.mjs --class <failure-class> --team <key> [--because "<what changed>"]`: the same for every ticket on one team parked under one failure class (at most 25 per call).

The verbs underneath are `catalyst explain <ticket>`, `catalyst explain <ticket> --history` and `catalyst release <ticket> --because <text> [--retry-unchanged] [--dry-run]`.

## Load on demand

| when | read |
| -- | -- |
| deciding whether to release, what a refusal means, when to ask a person | `references/playbook.md` |
| what a reason in the explanation means, or what clears each kind of hold | the `whats-happening` skill: its why-is-it-stuck and when-a-phase-fails references |
| a refusal needs a decision or a person's action | the `what-needs-me` skill |
| a refusal names a person's pull request or its review | the `catalyst-github` skill |

## Rules

- **Read before you release.** Explain, then history, then a dry run. A release is never the first call.
- **The cause decides, not the wish to move.** Release when you can name what changed since the ticket was held: a push, a comment that says what to change, an outage that ended, a secret that was rotated, an account that was re-enrolled. Put that sentence in `--because`; it is recorded against your name.
- **Unchanged means say so.** The cloud refuses a release whose cause it cannot see change. Pass `--retry-unchanged` only with a `--because` that names the change it cannot see. If nothing changed, do not release; say so.
- **One release per cause.** If the history shows a release for the same failure and nothing has changed since, a second release buys the same failure. Raise an ask instead.
- **A refusal names its fix.** Do the fix when it is yours to do; everything else is one ask through `what-needs-me`, attached to an existing ask for the same decision. Never close or merge a person's pull request, and never answer an ask as the person.
- **A shared cause is one note.** Several tickets parked by one outage or one bad image are one class release and one line in your reply, never one ask per ticket.
- **What a release costs.** A release is a write: it is recorded against the person's name with your `--because`, shown to everyone who reads the ticket's history, and it spends a round of work the cloud will run again. The dry run is free; run it first.
- **Their account, as them.** Every read and write goes through the CLI and the person's own login. You never name another account.

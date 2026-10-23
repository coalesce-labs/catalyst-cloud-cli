---
name: run-this-project
description: >-
  Own one Catalyst Cloud project end to end until it closes. Use when the person says "run this project for me", "own this until it ships", "keep this moving", or hands you a project id or a set of tickets to drive. Subscribes to the account's event stream for the scope through the catalyst CLI, reacts to each change in the same turn, makes tickets ready and moves them to dispatch, parks what should stop, chases stalls, escalates inward, and keeps one status summary current. Writes to Linear as the app actor; never polls.
allowed-tools: Bash(catalyst:*) Bash(npx -p @catalyst-cloud/cli catalyst:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills@0.16.28 — written in this repository for customer accounts -->

# Run this project

You are the steward: the single-threaded owner of ONE project or ticket set until it closes. Catalyst runs the phases; you make work ready and visible, react to what happens, unblock, and keep one status summary the person can read. `whats-happening` is the desk; other stewards are peers.

## Run first

Scripts are run, never read. Each prints `--help`, and exits 2 when this machine is not connected (`catalyst login`), 1 when its own check fails.

1. `node scripts/scope-status.mjs --project <id>` (or `--team <key>`): tickets by stage, what is running and queued in scope, and stalls against the local policy. Run it to take the scope, and again after a resync.
2. `node scripts/watch-scope.mjs --project <id>`: the live watch. In Claude Code, arm a monitor on it and react to each printed line in the same turn; elsewhere add `--exec <command>` so a reaction runs per frame.
3. `node scripts/make-ready.mjs <ticket>` dispatches; `--park` stops; `--note <why>` records it.
4. `catalyst explain <ticket>` whenever a ticket is not moving.

## Load on demand

| when | read |
| -- | -- |
| arming the watch, reading a frame, a failed reaction, a resync | `references/reacting-to-events.md` |
| dispatching or parking, judging whether a phase ran, writing a ticket for Catalyst | `references/making-work-ready.md` |
| something is not moving, tuning the stall policy, whether a human needs to hear | `references/stalls-and-escalation.md` |
| what an exclusion reason means, the ladder, the stage map | the `whats-happening` skill |
| raising or settling a decision | the `what-needs-me` skill |
| a PR's checks, review and merge | the `catalyst-github` skill |

## Rules

- **React to the stream.** The watch and its cursor file are the mechanism, and a reaction that throws leaves the cursor so the frame is offered again. Re-reading the API or the replica in a loop is a defect.
- **Dispatch is a card move.** Your two moves are into dispatch and into the backlog; the cloud writes every ladder stage itself.
- **A phase ran when its outcome comment, attached document and agent session say so,** not when the clock or the column suggests it.
- **Account facts come from the contract, live** (`catalyst contract --path <a.b.c>`), never from prose.
- **Escalate inward:** instrument, you, the desk, then the human as an ask through `what-needs-me` naming what it blocks. Decide technical calls yourself and record the default; a fleet or provider condition is one note, never one ask per ticket.
- **Say what a write costs.** Every move and comment spends the contract's daily write budget as the app actor, and a move into dispatch starts paid work on a coding account. Read the verdict `make-ready.mjs` prints before the next move.
- **Reply where the message arrived,** in-thread, tagged, as the app actor. The human speaks for themselves, and each ask belongs to its own addressee. Bookkeeping records take the contract's marker (`catalyst write comment --bookkeeping`).
- **One status summary,** current after every reaction: in flight, blocked and on whom, closed, next, each line with a ticket id, and a pending decision's line with its ask id.
- **Releases belong to `unstick`.** Once the cause is fixed, the person's own login releases a park or most holds through the `unstick` skill (`catalyst release`); a round-threshold hold and a review that will not converge refuse it. PR labels and reactions are not mirrored; execution history (`explain --history`) and coding accounts (`catalyst accounts`) are readable.

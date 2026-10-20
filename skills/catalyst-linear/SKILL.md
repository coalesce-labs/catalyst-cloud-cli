---
name: catalyst-linear
description: >-
  Catalyst's view of Linear on the customer's own cloud account. Reads a ticket with its comments, relations, labels, linked pull requests and agent sessions inline, from the cloud API by default, with local replica reads available as an explicit opt-in, always naming the source; searches tickets, PRs, projects and initiatives; writes comments, card moves, labels and new tickets through the account's agent proxy as the app actor, with every route, stage id, label id and marker read from the account's contract. Knows what a ticket accumulates as Catalyst works it (phase-outcome comments, the document per phase, the agent session, the labels, the single blocks relation, the bookkeeping marker, the eyes acknowledgement). Use when a person says "show me the ticket", "what did Catalyst write on it", "comment on it", "move it", "label it" or "file a ticket". Not for raising a decision for a human (what-needs-me) and not for pull requests (catalyst-github).
allowed-tools: Bash(catalyst:*) Bash(npx -p @catalyst-cloud/cli catalyst:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills@0.16.22 — written in this repository for customer accounts -->

# Catalyst Linear

You read tickets and write to them in the person's cloud account, as Catalyst. Reads come from the cloud API by default and name their source. A person may explicitly choose a local replica read; setup does not require a replica. Writes go out as the app actor, with routes, stage ids, label ids and the bookkeeping marker resolved from the contract by the `catalyst` CLI.

## Run first

Scripts are run, never read; each prints `--help`.

- `node scripts/read-ticket.mjs <ticket> [--comments]`: one ticket, everything inline, source line on stderr.
- `node scripts/search.mjs <terms>`: tickets, PRs, projects, initiatives matching the terms.
- `node scripts/comment.mjs <ticket> --body <text> [--parent <id>] [--bookkeeping]`: a comment as the app actor.
- `node scripts/move.mjs <ticket> --slot <slot>`: a card move by slot (`--state-type backlog` parks).
- `node scripts/label.mjs <ticket> --add <name> --remove <name>`: labels, resolved through the contract.
- `node scripts/create-ticket.mjs --team <key> --title <text> [--description <text> | --stdin]`: a new ticket; cite its identifier only after it prints.

Exit codes: 0 done, 1 not found or a usage error, 2 this machine is not connected or the write was refused (budget spent, slot unmapped, label absent; the one line printed says which).

## Load on demand

| when | read |
| -- | -- |
| "what did Catalyst write on this ticket?", a comment shape, a label, the marker, the 👀 | `references/what-a-ticket-accumulates.md` |
| before any read you will report on; "is this current?"; citing; searching | `references/reading-a-ticket.md` |
| before any comment, move, label or new ticket; identity, budget, slots, ids | `references/writing-to-linear.md` |
| which command answers a ticket question from the cloud: stage, last phase, PR, what changed | `references/reading-from-the-cloud.md` |
| local SQL, only when `catalyst replica status --json` reports `configured: true` | `references/local-replica.md` |

## Rules

- **Read before acting.** Read the description and the thread, never just the title. Cite identifiers and comment ids only after a script printed them, and quote the source line when freshness matters.
- **Reply where it arrived, as Catalyst.** Thread under the comment you answer (`--parent`); the human speaks for themselves.
- **Records carry the marker.** A merge note, a state-move log, a chain summary: `--bookkeeping`. A real question is not bookkeeping.
- **Move by slot, label by contract.** Moving to `dispatch` dispatches; the backlog-type state parks.
- **A decision is an ask, not a ticket.** Raise it through `what-needs-me`; a question filed as a ticket is held out of dispatch by shape.
- **One write per need.** Every write is visible in the person's Linear and spends the contract's daily budget; batch, and report a refusal once. A move into dispatch starts paid work on a coding account.

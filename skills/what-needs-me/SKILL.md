---
name: what-needs-me
description: >-
  The human's decision inbox on Catalyst Cloud, and the one way an agent raises a decision on their behalf. Use when the person asks "what needs me?", "what am I blocking?", or when active work is gated on a choice only they can make. Lists open asks ranked by how much open work each one holds, files an ask through the cloud's ask route with the account's own template, and records the answer so the held work releases. Never answers as the human, never duplicates an open ask.
allowed-tools: Bash(catalyst:*) Bash(npx -p @catalyst-cloud/cli catalyst:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills@0.16.22 — written in this repository for customer accounts -->

# What needs me

An ask is one decision only the human can make, filed as a ticket in their own Linear so that question, options, default, answer and who answered are one record. This skill reads that inbox ranked by how much open work each ask holds, raises a new ask when work is gated, and settles the answer so the held work releases. The cloud renders the ask body from the account's template, applies the ask labels and creates the blocking relations; you pass fields, never headings.

## Run first

Scripts are run, never read. Each prints `--help`; exit 2 means this machine is not connected (the `catalyst-onboard` skill connects it), exit 1 means the check itself failed or an argument was missing.

- `node scripts/inbox.mjs --help`: the open asks assigned to the connected person, most open tickets held first, then the oldest; `--anyone` for everyone's; `--json` for `{scope, asks}`.
- `node scripts/raise.mjs --help`: file one decision: `--team`, `--title`, `--option` (repeated), `--default`, and `--blocks` (repeated) or `--nothing-to-block`. When the ask decides whether a held PR may merge, `--gates-pr` (repeated) with `--released-by <letter>` makes the answer lift that PR's hold label.
- `node scripts/settle.mjs --help`: record the answering comment on an ask and post a release note on every ticket it held; `--close` moves the ask to the done slot.

## Load on demand

| when | read |
| -- | -- |
| about to file an ask, or unsure whether something is one | `references/raising-a-decision.md` |
| presenting the inbox, or the person asks what "waiting on me" means | `references/reading-the-inbox.md` |
| an answer arrived, anywhere | `references/settling-an-answer.md` |

The `catalyst-linear` skill posts the comment that carries an answer given in chat and reads an ask's thread; `whats-happening` explains a held ticket that stays excluded after the answer.

## Rules

- **File before proceeding on the default.** Work may run on a default only after the ask exists; a default with no ticket behind it is a guess, not a decision.
- **One ask per decision.** Read the inbox first; attach new held tickets to an open ask rather than filing a twin. Duplicates split one decision's urgency across rows.
- **Every ask names what it blocks.** The ranking the human sees is by the count of open tickets each ask holds, then the oldest ask; priority is not a weight. An ask that holds nothing does not reach Waiting on me unless you chose `--nothing-to-block` on purpose.
- **A write is visible.** Filing an ask puts a ticket in the person's Linear, assigns it to them, holds every ticket it names, and spends the daily write budget; settling posts a comment on the ask and on every held ticket. Read the inbox before you file.
- **The human answers for themselves.** Their answer is quoted into the ask as the app actor and recorded with its comment id; a free-text reply is recorded as written, never turned into an option.
- **Escalate inward.** A project owner raises asks for its scope; the desk raises what has no owner; a single stuck ticket or a provider outage is never an ask.
- **Account facts come from the contract.** Team keys, label names, the option cap and the template are read live by the CLI. Cite an identifier only after the create call returned it.

---
name: whats-happening
description: >-
  Use for "what's happening?", "what machines do we have?", "how much capacity do we have?", "where are we?", "why is that stuck?", "what closed?", "what's next?", "how does this work?", "why did it do that?", "how does it prioritise?" and "what does this setting do, where is it set?" in Catalyst Cloud, or asks for something to be done rather than known. Reads the contract via catalyst CLI. Read-only: route work/decisions, never answer as the human.
allowed-tools: Bash(catalyst:*) Bash(npx -p @catalyst-cloud/cli catalyst:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills@0.16.39 — written in this repository for customer accounts -->

# What's happening

Use one snapshot and the person's login. Run scripts, never read them. --help explains usage; exit 2 needs onboard, exit 1 means failure.

- `node scripts/snapshot.mjs` reads contract, running work, queue and ranked asks from the cloud. --board adds every open ticket's count per stage with up to 50 cards each; when boardTruncated is present, say how many it left out. --accounts adds coding accounts, --team K narrows. --replica adds optional local diagnostics.
- `node scripts/explain.mjs <ticket>` explains eligibility; --history adds attempts, rounds, holds and releases.
- `node scripts/show-my-map.mjs [--team K]` prints stages, labels, ladder and thresholds.

Comments/relations: catalyst-linear. PRs: catalyst-github. Readiness: catalyst-onboard. Use current account facts/URLs, never memory. Unknown means inconclusive. PR labels/reactions are unmirrored; print their URL. Accounts/history are readable.

## Load on demand

| question | reference |
| -- | -- |
| machines or machine capacity? | references/machines.md |
| status or stuck? | references/status-reply.md; schema assets/status-reply.json |
| eligibility reason? | references/why-is-it-stuck.md |
| order, capacity, WIP or routing? | references/what-runs-next.md |
| failure, park or hold? | references/when-a-phase-fails.md |
| request or decision? | references/routing-work.md |
| phases or Done? | references/the-ladder.md |
| columns or slots? | references/stages-and-mapping.md |
| accounts, limits, quarantine or provider? | references/coding-accounts.md |
| setting, screen, route or role? | references/settings-and-where-they-live.md |
| which command answers it from the cloud? | references/reading-from-the-cloud.md |
| local SQL? only if `catalyst replica status --json` says `configured: true` | references/local-replica.md |

Read-only: give ids, source, release and actor. Route releases to `unstick`, decisions to what-needs-me before defaults, ownership to run-this-project. Subscribe, never poll. Report each system cause once.

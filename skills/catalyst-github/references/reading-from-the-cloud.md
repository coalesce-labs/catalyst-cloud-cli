# Reading pull request facts from the cloud

Cloud reads are the default on every machine. They need no local writer and no local database. Every command below reads the cloud through the `catalyst` CLI.

| question | command |
| -- | -- |
| Which pull requests name this ticket? | `catalyst query pulls --ticket <KEY-123>` |
| Which pull requests are open, in one repository or across them all? | `catalyst query pulls --state open --all` (add `--repo <owner/name>` or `--draft ready`). The cloud filters, so this reads only open ones. Never page every pull request with `--all` and filter it yourself. |
| What state is the PR in: draft, merged, conflict, auto-merge? | `node scripts/read-pr.mjs <KEY-123>` |
| Which checks are red or still running at the head? | `node scripts/read-pr.mjs <KEY-123>` |
| Is it mergeable under this repository's policy? | `node scripts/is-it-mergeable.mjs <KEY-123>`, which also reads `catalyst contract --path merge` |
| Which stage is the linked ticket in? | `catalyst query issue <KEY-123>` |
| What did the last pr or merge phase do? | `catalyst history <KEY-123>` |

The first stderr line names the source: `source: api (...)`. Quote it when freshness matters.

## What the cloud PR detail does not carry

The detail has no review-thread count. So the thread leg of `is-it-mergeable.mjs` is inconclusive from a cloud read, and the cloud's own merge evaluator decides. A queue-ready label on the PR means it already said yes. Reactions, PR labels and the commit each review was submitted against are not in the detail either.

A smaller ticket read is coming: the cloud will answer with only the status fields and the linked pull requests. No CLI flag selects it yet, so read the full record.

## The local replica

Only on a machine where `catalyst replica status --json` reports `configured: true`, `references/local-replica.md` adds local SQL and the opt-in `--local-threads` read. Everywhere else, these cloud reads are the whole answer.

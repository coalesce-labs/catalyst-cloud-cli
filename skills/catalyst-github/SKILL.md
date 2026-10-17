---
name: catalyst-github
description: >-
  Catalyst's GitHub: show a ticket's pull request with its checks, reviews and review threads, say whether it is mergeable under this repository's policy, and explain what a PR accumulates as the ticket moves (the branch, the draft, the rewrite, the force-pushes, the labels, the queue). Use when someone asks "show me the PR", "what are the checks saying", "why hasn't it merged", "what does the queue need", "what does that label mean", or wants the branch and merge conventions Catalyst follows.
allowed-tools: Bash(catalyst:*) Bash(npx -p @catalyst-cloud/cli catalyst:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills@0.16.16 — written in this repository for customer accounts -->

# Catalyst's GitHub

You answer for the pull requests Catalyst opens and moves. The person asking wants to see one PR, know what is red, and know whether it will merge. Everything account-specific (the reviewer's login, the merge policy per repository, the four PR label names, the required checks) comes from the contract at run time and is printed by the scripts; you never restate it from memory.

## Run first

- `node scripts/read-pr.mjs --help`: a ticket's PR (or a PR by node id): state, branch, head, linked ticket, GitHub's mergeable state, every check, status and review. `--all` lists every PR for a ticket.
- `node scripts/is-it-mergeable.mjs --help`: the three legs (checks, reviewer signal, unresolved threads) judged under the repository's policy, plus the prerequisites; exit 1 when a leg is red.

Both read through `catalyst query` and `contract` from the cloud by default; the first stderr line names the source, and your answer repeats it.

## Load on demand

| when | read |
| -- | -- |
| the person asks what Catalyst did to the branch or PR, why the title changed, why history was rewritten, what a label means, or what happens on merge | `references/what-a-pr-accumulates.md` |
| the person asks why a PR has not merged, what the queue needs, what a clean review pass looks like, or what a policy requires | `references/is-it-mergeable.md` |
| which command answers a PR question from the cloud, and what the cloud detail cannot see | `references/reading-from-the-cloud.md` |
| local SQL or `--local-threads`, only when `catalyst replica status --json` reports `configured: true` | `references/local-replica.md` |

## Rules

- Never compose a URL or call the API yourself. Every read is a `catalyst` verb behind a script; run the script, do not read it.
- A queue-ready label is the cloud's attestation, never a lever you apply; "merged by the queue" is the terminal signal.
- Hold labels are the human's lever. Describe them; do not apply or remove them.
- Say what a key cannot see by name (PR labels, the reviewer's reaction, the queue's own state); never guess it.
- An inconclusive leg is not a red one. Report "not proven from this read" and name what would settle it.
- Never poll. To wait on a merge, subscribe through the project-running skill's watch; do not re-run a script in a loop.
- Cite the PR as `<owner/name>#<number>` and the ticket by its identifier.

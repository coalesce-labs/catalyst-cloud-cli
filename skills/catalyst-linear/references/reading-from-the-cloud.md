# Reading ticket facts from the cloud

Cloud reads are the default on every machine. They need no local writer and no local database. Every command below reads the cloud through the `catalyst` CLI.

| question | command |
| -- | -- |
| What stage is the ticket in, who has it, which PRs name it? | `catalyst query issue <KEY-123>`, or `node scripts/read-ticket.mjs <KEY-123>` |
| What did Catalyst and people write on it? | `node scripts/read-ticket.mjs <KEY-123> --comments`; comments and activity come inline with the ticket |
| What was the last phase, and how did it end? | `catalyst history <KEY-123>` |
| How many remediate rounds against the cap? Is it parked, and what releases it? | `catalyst history <KEY-123>` |
| Why is it not running, or what runs next? | `catalyst explain <KEY-123>` |
| What is the PR's state, checks and reviews? | `catalyst query pulls --ticket <KEY-123>`, then `catalyst query pull <node-id>` |
| What changed across the account since a point? | `catalyst query changes --since head`, then the cursor it prints |
| Find a ticket by words | `node scripts/search.mjs <terms>` |
| What happened to it, event by event? | `catalyst events query --ticket <KEY-123>` |
| Wait until its phase finishes | `catalyst events wait-for --ticket <KEY-123> --type relay.phase.completed --after <head> --timeout 300` |
| Wait until its branch or PR changes | `catalyst events wait-for --ref <owner/name:branch> --type pr.* --after <head> --timeout 14400` |
| What messages were sent to it? | `catalyst messages read --ticket <KEY-123>` |

## Reading the answer

The first stderr line names the source: `source: api (...)`. Quote it when freshness matters ("from the API just now").

The ticket read returns the whole record, so a question about one field still downloads comments and activity. That is fine for one ticket. For many tickets, use a list (`catalyst query issues --team <key>`) and read one record only where the list is not enough.

A smaller read is coming: the cloud will answer a ticket or its execution history with only the status fields. No CLI flag selects it yet, so read the full record and pick the fields you need.

## Events

`catalyst events` reads the cloud by default and needs no local file.

- `catalyst events query --ticket <KEY-123>` prints the ticket's events, newest first. Add `--type`, `--limit` (up to 200), `--order asc` and `--before` or `--after` to page. An empty page says which sequences the cloud has indexed, so "no match" is not "never happened".
- To wait for something to happen, first run `catalyst events status --json` and keep its `head`. Then run `catalyst events wait-for --ticket <KEY-123> --type relay.phase.completed --after <head> --timeout 300`. Exit 0 prints the event, exit 1 is a timeout, exit 2 is a refusal with its reason, and exit 4 means the cloud was unreachable.
- To wait on a branch, a pull request, a repository, a phase session or messages addressed to you, use `--ref <owner/name:branch>`, `--pr <owner/name#n>`, `--repo <owner/name>`, `--session <KEY-123/phase#n>` or `--to me`, with `--type pr.*` for a family of types. Such a wait prints nothing until a match, so `--timeout 14400` costs nothing while it waits. On a timeout, stderr names the `--after` to resume from.
- `catalyst messages read --ticket <KEY-123> [--since <sequence>]` prints the messages sent to the ticket, with sender and time.
- `catalyst events tail --ticket <KEY-123>` stays in the foreground and prints one JSON line per new event.

The ticket filter reads the event's ticket entity, `payload.ticket`, and the lease that caused it. `--from-cache` reads this machine's local event cache instead. It exists only where local sync is on, and it pays off when several agents on one machine share it.

## The local replica

Only on a machine where `catalyst replica status --json` reports `configured: true`, `references/local-replica.md` adds local SQL. Everywhere else, these cloud reads are the whole answer.

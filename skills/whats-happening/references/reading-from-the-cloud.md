# Reading from the cloud

Cloud reads are the default everywhere and need no local writer or database. Each command reads the cloud through the CLI.

| question | command |
| -- | -- |
| ticket stage, owner, linked PRs | `catalyst query issue KEY-123` |
| last phase, attempts, rounds, park, lease | `catalyst history KEY-123` |
| why not running, what runs next | `node scripts/explain.mjs KEY-123` |
| running now | `catalyst running` |
| queue order | `catalyst queue` |
| PR state and checks | `catalyst query pulls --ticket KEY-123`, then `catalyst query pull <node-id>` |
| what changed since a point | `catalyst query changes --since head` |
| a ticket's events, newest first | `catalyst events query --ticket KEY-123` |
| wait for a phase to finish | `catalyst events wait-for --ticket KEY-123 --type relay.phase.completed --after <head> --timeout 300` |
| wait on a branch or PR | `catalyst events wait-for --ref owner/name:branch --type pr.* --after <head> --timeout 14400` |
| read a ticket's messages | `catalyst messages read --ticket KEY-123` |

A status-only read of a ticket and of its execution history is coming. No CLI flag selects it yet; read the full record.

Events: `catalyst events` reads the cloud by default. `events status --json` gives the `head` to wait after. Exit 4 from `wait-for` is an outage, not a timeout; exit 2 is a refusal, with the reason. A wait on `--repo`, `--ref`, `--pr`, `--session` or `--to me` prints nothing until a match, so a long timeout costs nothing. `--from-cache` reads the local event cache, which exists only where local sync is on.

Local SQL: `references/local-replica.md`, only when `configured: true`.

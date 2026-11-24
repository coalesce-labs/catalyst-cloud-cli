# Reading a ticket: freshness first, then the row

## Freshness first

Every `query` verb, and therefore `node scripts/read-ticket.mjs` and `node scripts/search.mjs`, prints one stderr line before the answer:

- `source: replica (--source replica)`: the person explicitly selected the optional local replica.
- `source: api (cloud reads by default)`: the answer came from the cloud API; no local replica is needed.
- `source: api (<verb> is api-only)`: search, cycles, pull detail and change feeds never come from the replica.

Quote the source when a fact's freshness matters ("as of the replica at cursor N", "from the API just now").

`--source replica` or `--source api` forces one. Forcing the replica when it is absent is refused. No offline-browsing promise is made.

## Then the row

One read returns the whole record inline: fields, description, `labels[]`, `relations[]`, `linked_pulls[]`, `comments[]`, `activity[]` and `agent_sessions[]`, plus project, cycle, team, delegate and parent. `relations[]` holds only the edges the ticket points out along. The tickets that hold it arrive in `blocked_by[]`, each with its state, and the plain output prints them in their own `blocked by` block, so read that block before filing a blocker. `--comments` prints every comment with its id, author, time and bot flag; a comment with a `reply-to` marker is threaded, so reply under the same parent.

## Reading Catalyst's own writes

The comment shapes in `references/what-a-ticket-accumulates.md` tell you which comments are the cloud's. To answer "what happened to this ticket":

1. Phase-outcome comments, newest first, give the attempts and their results.
2. Remediate-attempt comments give the failure class each round repaired.
3. The projection-link comments name the documents; open the document (it is attached to the ticket) to read what a phase actually concluded. A fallback comment carries the body inline instead.
4. `linked_pulls[]` names the PR; `catalyst-github` reads it.
5. For "what will it do next", leave this skill: `whats-happening` explains the eligibility row.

The attempt ledger, the round count against the cap, and park state come from `catalyst explain --history <ticket>`; read the count there rather than reconstructing it from comments. A phase's full transcript has no verb in this bundle: read the artifact document first, and if it leaves the question open, say the human can open the transcript from the ticket.

Cite a ticket by its identifier (`KEY-123`), a comment by its id, and a document by the title its projection comment gave it.

## Searching and listing

`node scripts/search.mjs <terms>` matches identifiers, titles, PR titles, and project and initiative names. It is the only search: a filtered list hands back its first page, which reads as a false "not found". Lists (`catalyst query issues --team <key>`, `query projects`, `query cycles`) are board views. A list cut short prints `truncated at N of M` on stderr; `query issues --all` and `query pulls --all` follow the page cursor to the end, for when the count has to be right.

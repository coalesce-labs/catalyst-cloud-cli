# Reading the inbox

## What waiting-on-me means

The account's own Waiting-on-me view lists a ticket for a person when all four hold:

1. it is **assigned** to that person;
2. it has **no delegate** (a ticket delegated to an agent is the agent's, not the human's);
3. it is still **open**;
4. what it **blocks** reaches open work: at least one ticket it holds is itself not done or canceled.

A ticket that carries the ask marker label and is assigned to the person shows even with zero blocks. That is the **declared** ask. The four-part rule above is the **inferred** one, and the view offers both modes: asks only (the default) and everything the person is holding up, minus items an open unblock ask already covers.

So an ask that holds nothing is real, but the person may never see it in their own view. `inbox.mjs` lists such asks last and marked, so you can attach the work they should block.

## What the script reads

`catalyst ask list` reads every page, so an empty list is real. It follows each open ask's blocking relations, drops held tickets already terminal, and ranks by the count of open tickets each ask holds (its `score`), then the oldest ask, then the identifier: the cloud's own Waiting-on-me order. Priority is not a weight; age only breaks a tie. It keeps the connected person's asks by default (`--anyone` for everyone's) and reports a `scope`: `mine`, `anyone`, `unmatched` (the Linear identity is not matched, so everyone's list is shown with a stderr line), or `no-person` (connected with the account key, which names nobody). Say which scope you got, and give the wider count beside an empty `mine` list so it never reads as "nothing needs anyone".

## The identity is not the same as the personal Linear grant

When asks are not reaching someone, check the identity first, then the grant. The **identity** is who they are in Linear, resolved by an email match or matched by the person (`catalyst identity linear status`, `options`, then `catalyst identity linear set <linearUserId>`). The **personal Linear grant** is proven by connecting Linear themselves. Connecting Linear personally does **not** set the identity. An auto-resolved identity, or one another member claims, needs an owner or admin at Settings → Members; no command does this yet, so raise an ask to them. With no identity nothing is assigned to them, even after they connect Linear, so an `unmatched` scope is not an empty queue: say "nothing is assigned to you yet, so this is everyone's list; match your identity with `catalyst identity linear set` and it becomes yours".

## Presenting the queue

- In the script's order, one line per ask: rank, identifier, what it holds (identifiers), the question.
- Asks that hold nothing come after a break, marked as not visible in Waiting on me until they block something.
- When the list is empty, say "nothing needs you" and stop. Do not pad it with suspected asks.
- A ticket `explain` flagged as `ask_shape_suspected` (its text reads as a decision but it carries no ask label) is mentioned separately with a question mark: it is either an ask the human should label, or a false positive they release with the release label the contract names.

## What the inbox is not

- It is not the dispatch queue. Held tickets are excluded from dispatch by their blocking relation; answering the ask releases them into the ordinary order.
- It is not a place to answer; an answer goes through `references/settling-an-answer.md`.
- It is not a stall detector. A park, a merge hold or a coding-account wall is a status question for `whats-happening` until someone raises an ask.

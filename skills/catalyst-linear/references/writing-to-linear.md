# Writing to Linear: identity, budget, slots, labels

The CLI reads the route table, write budget, stage map and label ids from the contract on every write; nothing here is a literal to copy.

## Every write is one script

| Want | Run |
| -- | -- |
| a comment, threaded or top-level | `node scripts/comment.mjs <ticket> --body <text> [--parent <commentId>] [--bookkeeping]` |
| a card move | `node scripts/move.mjs <ticket> --slot <slot>` or `--state-type backlog` |
| a label on or off | `node scripts/label.mjs <ticket> --add <name> --remove <name>` |
| a new ticket | `node scripts/create-ticket.mjs --team <key> --title <text> [--description <text> \| --stdin]` |
| a decision for a human | not here: the `what-needs-me` skill raises an ask with options, a default and what it blocks |

Each script wraps one `catalyst write` verb, which posts to the contract's route as the app actor with this machine's personal key, so the write is attributed to the person.

## App actor versus personal identity

Writes go out as the app actor by default, which the comment-wake trigger recognises as not human, so an app-actor comment never wakes an agent and reads as Catalyst speaking. `--as-user` switches a comment or new ticket to the person's identity; use it only when they asked for that attribution, and then mark any machine record with `--bookkeeping`, because it is otherwise indistinguishable from them typing it. Answer a thread in that thread with `--parent <commentId>`.

## The daily write budget

Every write spends one unit of the per-host daily budget (`thresholds.hostDailyWriteBudget`), a label call one unit whatever its count; reads spend none. A spent budget exits 2 naming the retry time: report it, and batch into fewer writes.

## State moves are by slot, never by name

`--slot <slot>` resolves to the team's live state id from the contract, and refuses when the slot is unmapped or its state is gone (re-map first: `catalyst team map <KEY>`). Moving to `dispatch` dispatches work. `--state-type backlog` resolves the team's first backlog-type state and parks the card, stopping remediation rounds. Names are display fields that survive re-imports while ids do not, so there is no move by name.

## Labels are by name or UUID

`--label`, `--add` and `--remove` take a label's name or its UUID. A UUID is sent as a label id; every other value is sent as a name, and the proxy resolves it in the ticket's team. When the contract lists one of Catalyst's own labels (the ask marker, the hold label, the release label) as absent from the workspace, the CLI refuses rather than inventing it.

For work-type and component choices, load [ticket classification](ticket-classification.md) and the project's `.agents/references/ticket-labels.json` when present. Those files define recommendations, not live IDs. Verify the current team's label scope and the ticket's existing memberships before changing any classification label. A case-only duplicate needs a synchronization check, a disposable canary and delayed readback in both systems before wider cleanup. Include archived labels and issues in the inventory.

Two labels are a human's, not yours: the release label (which frees a ticket the shape detector held) is applied by a human; the hold labels on a pull request are `catalyst-github`'s subject.

## A new ticket takes the team key

`create-ticket.mjs --team <key>` takes the identifier prefix; the CLI resolves the team from the contract. Give it a body (`--description`, or `--stdin` for several lines), since a bare title leaves nothing to act on. Cite the identifier only after the script prints it; a guessed number is usually a real, unrelated ticket. A question for a human filed this way is held out of dispatch by shape and never reaches their inbox; raise it through `what-needs-me`.

## What is never offered

Delegating a ticket to an agent is an operator action. The human answers their own asks (`what-needs-me` records the acceptance). Another actor's comment cannot be edited.

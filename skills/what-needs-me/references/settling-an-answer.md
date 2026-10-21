# Settling an answer

The answer lives on the ask. Wherever it arrived (the ask's thread, a held ticket, chat, a call), it ends as a comment on the ask, recorded as the accepted answer, so question, options, default, answer and who answered are one record.

## The three steps

**1. Post the answer where it should live.** An answer given anywhere but the ask's thread becomes a comment on the ask, as the app actor, quoting them and attributing it ("the owner answered in chat: option B"), through the `catalyst-linear` skill's comment script, which returns the comment id.

An answer the owner gave you directly in this chat can instead be recorded by proxy, when they have turned that on: `catalyst ask answer <ask> --proxy` (SKILL.md, "An answer the owner gives you in chat"). The cloud records it on the ask and notes it on the held tickets in one call, so skip these three steps and tell the owner what you recorded.

**2. Record it.** `node scripts/settle.mjs <ask> --answer <commentId> --role <role>` calls the cloud's ask-accept with the ask, the answering comment and the role doing the recording. The script first checks the comment is really on the ask (an id from a different ticket is refused before anything is written), then records, then reads the ask's blocking relations.

**3. Release the held work.** On every open ticket the ask blocks, the script posts one bookkeeping comment naming the ask, the comment id and the answer's first line, so the next agent there reads the decision; the marker keeps it from waking anyone. `--no-release-note` skips this for tickets about to be canceled.

With `--close`, the script also moves the ask to its team's done slot. The blocking relations stay on the record; a done ticket does not block anything, so the held tickets become dispatchable on the cloud's next pass. Close only when the answer is complete; an answer that raises a follow-up question keeps the ask open and the follow-up goes in the same thread.

## Free-text replies

A reply that names no option ("do whichever is cheaper", "ask me again Thursday") is recorded exactly as written; nothing turns it into an option. If it answers the question, settle with it and let the release note quote it. If it does not, reply in the thread with the one clarification needed and leave the ask open.

## Who settles

The role that raised the ask, or the owner of the scope it belongs to. The desk settles asks that have no owner. The human never has to run anything; their part ends when they answer. Never settle another role's ask without saying so in the thread.

## After settling

Tell the human in one line what was recorded and what it released. The held tickets rejoin the queue on the cloud's next pass; if one stays excluded, `whats-happening` explains why. An answer that changes priorities or scope is a routing change for the project owner, not a second ask.

## When it cannot be settled

- The comment id is not on the ask: post the answer on the ask first, then settle with the new id.
- The write budget for the day is spent: the CLI names the budget from the contract and exits 2. Say so; the record waits, the human's answer is not lost.
- The ask is on a team the contract does not list: a workspace owner or admin maps the team (`catalyst team map <KEY>`); the `catalyst-onboard` skill reads readiness.

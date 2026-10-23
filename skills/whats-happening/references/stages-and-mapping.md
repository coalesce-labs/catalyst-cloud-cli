# Stages

Slots are board positions; stages are Linear states. teams[].stages maps them per team; show-my-map.mjs stars required slots.

Order: dispatch, intake, research, plan, implement, remediate, verify, review, pr, done, canceled.

| required slot | allowed Linear type | purpose |
| -- | -- | -- |
| dispatch | unstarted/backlog | starts work |
| intake | unstarted/backlog, never triage | optional classification of unseen tickets |
| pr | started | permits merge phase |
| done | completed | merge webhook writes it |
| canceled | canceled | terminal |

Missing/wrong required mappings stop work; others warn. Dispatch/pr/done/canceled must be live. `teams[].gitAutomation` stores consent; nothing reads it.

workflowMode: adopted means Catalyst-created, mapped means human-chosen, mixed means both. Configure with `catalyst team map <KEY>` or `catalyst team adopt <KEY>` (offer to run it for an owner or admin), never catalyst.toml.

stateId is authoritative; imports can replace ids but keep names. catalyst-linear resolves slots to ids. stateStillExists: false refuses the move; remap with `catalyst team map <KEY>`. Backlog is not a slot: parking resolves a live backlog-type state. catalyst-onboard explains readiness and who fixes it.

# Eligibility reasons

Use explain.mjs; unknown reasons stay verbatim. Holds: when-a-phase-fails.md.

## Automatic release

Automatic waits, where no one acts: `retry_backoff`, `lease_held`, `intake_lease_held`, `later_phase_lease_held`, `environment_check_running`, `claim_storm`, `repo_at_capacity`, `stale_failure_episode`, `no_branch_to_remediate` or `branch_missing`. These cover backoff, leases, environment checks, hourly claim throttling, occupied seats, obsolete repair and budgeted missing-branch release.

| reason | release and actor |
| -- | -- |
| `runner_image_breaker` | an operator moves faulty startup image pin; one fleet alert |
| `routing_unavailable` | kickoff route/slot/provider failure; recovery clears it; persistence needs a workspace owner or admin, in settings |
| `cooling_down` with callback | cloud watches detail's condition; no one acts unless stalled, then own-login release through unstick |
| `wip_limit` | no one acts on this ticket; project at limit; started work must finish; inspect those tickets' own reasons |

## Human action

| reason | meaning and action |
| -- | -- |
| `ask_ticket` | the person, with their own login: labelled question, never work; answer through what-needs-me |
| `ask_shape_suspected` | the person, with their own login: unlabelled decision text; answer or apply contract release label |
| `blocked` | blocker owner closes it; for an ask, the person, with their own login, answers |
| `not_at_dispatch_stage` / `not_at_pr_stage` | the person, with their own login: restore dispatch/PR slot respectively; for PR, fix bouncing automation |
| `no_change_hold` | the person, with their own login: unchanged repair; comment/push/unstick |
| `waiting_on` | the person, with their own login: unrepairable PR merge gate; read merge-wait comment for hold/review owed, using catalyst-github |
| `externally_claimed` | the person, with their own login: outside worker owns it; worker/person removes local-lane label |
| `environment_check_required` / `environment_check_failed` / `environment_check_expired` / `environment_check_hash_mismatch` | absent/failed/aged/changed environment check; a workspace owner or admin, in settings, runs or fixes it |
| `repo_paused` | the repository is paused; `catalyst repo status` says by whom, when and why; a workspace owner or admin, in settings or with `catalyst repo resume <owner/name>`, resumes it |
| `scope_overlap` | the person, with their own login: declared files overlap running work; choose order or wait |
| `human_owned_pr` | the person, with their own login: only its human owner closes, merges or hands it over; release refused |
| `review_not_converging` | the person, with their own login: read findings through catalyst-github, comment; release refused |
| `round_threshold` | the person, with their own login: lifetime repair budget spent; answer existing ask or push fix, never duplicate ask; release refused |

## Reasons a release clears once the cause is fixed

After a fix, the person, with their own login, routes `phase_parked`, `cooling_down` from failures/round cap, `remediate_parked`, `validate_class_spent` and `branch_gone` to `unstick`. Read history, preview release; recreate deleted branches or drop tickets. Validate-budget also clears by push/comment/ask answer.

## Finished

Finished, so no one acts: `ticket_terminal`, `pipeline_complete` and `pr_merged`; report them as closed.

## Inconclusive

unknown with `ordering_never_published`, `ordering_stale`, `workflow_mapping_unknown`, `ticket_unknown`, `dependency_snapshot_unknown`, `blocker_unknown`, `label_snapshot_unknown`, `prior_artifact_unknown`, `scope_unknown`, `scope_occupancy_unknown` or `branch_snapshot_unknown` means unreadable, never absent. Usually recovered next pass. `workflow_mapping_unknown` does not clear without a saved mapping; nor does accompanying `ordering_never_published`. Remap with `catalyst team map <KEY>` as owner/admin; other persistent unknowns need catalyst-onboard.

`human_addressed_unlabeled_ask_suspect` is advisory: list the human-assigned possible ask under waiting-on-human with a question mark.

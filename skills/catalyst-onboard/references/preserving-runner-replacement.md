# Preserving a paused Darwin runner during replacement

An installation owner can replace a known paused supervisor through the existing `catalyst onboard --runner` path while retaining the installation directory and named volumes. This is an owner-managed recovery for the standard Darwin state layout. The CLI does not automatically upgrade an existing container whose image differs from its desired image.

Before changing the container, the installation owner must independently receive its full container ID, selected local daemon, paused state, Compose project/service labels, working directory and exact configuration-file list. Receive the owned Compose and private `.env` files without printing their contents. Match the retained host identity and team to the existing enrollment. Verify the named `catalyst-host_host-credential` and `catalyst-host_supervisor-state` volumes and their actual mounts. Keep the original files privately for operator recovery.

The working directory must be the actual operator's `~/.local/state/catalyst/runner`. Keep the same OS operator, home, Docker selector, directory, Compose project, host name, team and volumes. Any saved machine-path mapping or state-directory environment selector must still resolve to that same standard directory. Do not relocate state or replace the login. Custom state layouts and an existing native producer configured for another supervisor pin require a separate repair; the producer refuses a changed pin instead of rekeying or adopting it.

The new supervisor, watchdog and runner images must first be qualified and cached on that same daemon. Supply all three exact digest pins explicitly, including the runner pin: ordinary setup preserves a saved runner image. A runner must carry the Darwin thoughts custody capability required by the native installer. Qualification and cached bytes are prerequisites, not consequences of removing the old container.

Once those prerequisites are received, the installation owner removes only the independently verified paused supervisor by its full container ID. Keep the directory, `.env`, Compose files, native thoughts and locks, credential volume and supervisor-state volume. Do not run Compose down, remove volumes, change ownership or broaden permissions.

Resume the existing onboarding context with the same team and repository inputs and an explicit `--runner` in this invocation:

```sh
CATALYST_SUPERVISOR_IMAGE="$QUALIFIED_SUPERVISOR_IMAGE" \
CATALYST_WATCHDOG_IMAGE="$QUALIFIED_WATCHDOG_IMAGE" \
CATALYST_RUNNER_IMAGE="$QUALIFIED_RUNNER_IMAGE" \
catalyst onboard --runner --only runner
```

The CLI's actual installation port now observes no supervisor container. It selects the same standard state directory and keeps the saved host name, join token and tuning. Cached target receiving and a successful fresh native custody exchange precede the credential and admission steps and supervisor activation. The retained enrolled credential identifies the existing host; this recovery does not require a new enrollment or org key. Native thoughts and lock ownership and modes remain unchanged.

A cache miss or native custody refusal leaves the retained credentials and enrollment intact and does not activate the supervisor. Setup may already have refreshed Compose and `.env` with the selected target configuration. Keep the operator's original-file receipt until the replacement is accepted. A refusal must be repaired by its owner; do not substitute an old image, create a new producer key or erase the retained state.

Accept the recovery only after the installation owner receives the exact new supervisor image, original credential and volume identities, loaded native producer, fresh custody exchange, preserved native modes, and a real successful work attempt with publication. Source tests alone do not prove a native installation.

# Machines and capacity

Run `catalyst hosts --json` when someone asks what machines their account has or how much capacity is available. Name `catalyst hosts` as the command behind the answer. The same read is available through the SDK's `client.hosts.list()`.

List each machine's name, whether it is self-hosted or Catalyst's, its teams, slots in use and free, last check-in, and live or stale status. A self-hosted machine uses the name its customer chose. Catalyst's machines say Cloud followed by the server or service name.

Use the response's capacity total. It already counts a cloud machine shared across teams once and excludes stale machines. A machine is stale when its runtime proof has expired or it has not checked in for 15 minutes. A stale machine stays in the list, with its last check-in, but contributes no live capacity. A missing check-in is unknown, not proof that a machine is live. A failed read is inconclusive; never report zero machines or zero capacity from a failure.

For a requested change, an admin can run `catalyst hosts rename <name-or-id> <new-name>` or `catalyst hosts remove <name-or-id>`. Removal asks for confirmation; `--yes` records explicit consent for an unattended invocation. A member can read but cannot change machines. When a name matches more than one machine, use its ID. An admin choosing to run work on a new machine can name it during `catalyst setup`, or pass `--machine-name <name>`.

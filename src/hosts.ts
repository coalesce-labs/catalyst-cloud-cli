import { createInterface } from "node:readline/promises";
import { positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { apiClient } from "./transport.js";
import {
  isMachineInventory,
  isMachineMutation,
  type MachineInventory,
} from "./machine-inventory.js";
import { stdinIsTty } from "./prompt.js";

export interface HostsDeps {
  confirm?: (name: string) => Promise<boolean>;
}
async function confirmRemove(name: string): Promise<boolean> {
  if (!stdinIsTty()) return false;
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return /^(y|yes)$/i.test(
      (
        await prompt.question(
          `Remove ${name} from this account? It will stop receiving work. [y/N] `,
        )
      ).trim(),
    );
  } finally {
    prompt.close();
  }
}
export function machineLines(inventory: MachineInventory): string[] {
  const lines = inventory.machines.map(
    (m) =>
      `${m.name} | ${m.ownership === "self_hosted" ? "Self-hosted" : "Catalyst's"} | ${m.teams.join(", ")} | ${m.slots} slots, ${m.inUse} in use, ${m.free} free | ${m.stopped === true ? "stopped" : m.status} | last check-in ${m.lastCheckInAtMs === null ? "never" : new Date(m.lastCheckInAtMs).toISOString()}`,
  );
  if (lines.length === 0)
    lines.push("No machines are enrolled for this account.");
  const c = inventory.capacity;
  lines.push(
    `Live capacity: ${c.slots} slots (${c.selfHostedSlots} self-hosted, ${c.catalystSlots} from Catalyst), ${c.inUse} in use, ${c.free} free. Stale machines are excluded.`,
  );
  return lines;
}

export async function cmdHosts(
  args: ParsedArgs,
  ctx: Ctx,
  deps: HostsDeps = {},
): Promise<number> {
  const parts = positionals(args);
  const action = parts[0] ?? "list";
  if (!(
    (action === "list" && parts.length <= 1) ||
    (action === "remove" && parts.length === 2) ||
    (action === "rename" && parts.length === 3)
  ))
    throw new UsageError(
      "hosts takes: [list] | remove <name-or-id> [--yes] | rename <name-or-id> <new-name>",
    );
  if (args.flags.yes === true && action !== "remove")
    throw new UsageError("--yes is only valid with hosts remove");
  if (
    action === "rename" &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(parts[2]!)
  )
    throw new UsageError(
      "Use 1 to 63 letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
    );
  const cfg = requireConfig(ctx);
  const client = apiClient(cfg, ctx);
  const listed = await client.getJson("/api/v1/hosts/machines", {
    query: { account: cfg.account },
  });
  if (!isMachineInventory(listed.body) || listed.body.account !== cfg.account)
    throw new CliError(
      "The cloud returned an unreadable machine list.",
      "shape",
    );
  if (action === "list") {
    if (args.json) ctx.stdout(JSON.stringify(listed.body));
    else for (const line of machineLines(listed.body)) ctx.stdout(line);
    return 0;
  }
  const matches = listed.body.machines.filter(
    (m) => m.id === parts[1] || m.name === parts[1],
  );
  if (matches.length !== 1)
    throw new CliError(
      matches.length === 0
        ? "No machine matches that name or ID."
        : "More than one machine has that name. Use its ID.",
      "machine_not_unique",
    );
  const machine = matches[0]!;
  if (!(action === "remove" ? machine.removable : machine.renameable))
    throw new CliError(
      "Catalyst manages this cloud machine. Only self-hosted machines can be changed here.",
      "managed_machine",
    );
  if (
    action === "remove" &&
    args.flags.yes !== true &&
    !(await (deps.confirm ?? confirmRemove)(machine.name))
  ) {
    ctx.stdout(
      args.json
        ? JSON.stringify({ removed: false, reason: "confirmation_required" })
        : "Machine kept. Use --yes to confirm removal without a terminal.",
    );
    return 2;
  }
  const path = `/api/v1/hosts/${encodeURIComponent(machine.id)}${action === "rename" ? "/name" : ""}?account=${encodeURIComponent(cfg.account)}`;
  const result =
    action === "remove"
      ? await client.deleteJson(path, { accept: [403] })
      : await client.postJson(path, { name: parts[2] }, { accept: [403] });
  if (result.status === 403)
    throw new CliError(
      "Admin access is required to change machines in this account.",
      "admin_required",
      2,
      403,
    );
  if (
    !isMachineMutation(result.body) ||
    result.body.hostId !== machine.id ||
    (action === "rename" && result.body.name !== parts[2])
  )
    throw new CliError(
      "The cloud did not confirm the machine change.",
      "shape",
    );
  ctx.stdout(
    args.json
      ? JSON.stringify(result.body)
      : action === "remove"
        ? `Removed ${machine.name}.`
        : `Renamed ${machine.name} to ${result.body.name}.`,
  );
  return 0;
}

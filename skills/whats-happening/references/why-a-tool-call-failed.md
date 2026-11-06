# Why a tool call failed

The cloud records every tool call to a connected MCP server: the tool, the outcome, a reason and an explanation. That record is the whole answer; nothing else holds it.

Run `node scripts/tool-call.mjs <server> --ticket KEY-123` (add `--tool <name>` when the person named one). It reads `catalyst mcp status <server> --json`, the record the terminal verb prints, and prints one line.

Reply with that line, as one line: the ticket and phase, the tool, the reason as the cloud wrote it, and who can fix it. Add nothing the record does not say. Quote a reason you do not know as spelled.

- **Server:** the person's word, lowercased (WorkOS is workos). The line names the server it read, so a wrong guess shows. When the read says the name may be wrong, ask for the exact name; for an owner or admin, offer to run `catalyst mcp list`.
- **Window:** the newest 50 calls to that server, no further back. A ticket or tool outside them is inconclusive: say the record cannot say why. Never call it a success. When the line says some calls could not be read, keep that clause: the answer may not be the whole picture.
- **Who can fix it:** a role only when the cloud's explanation says it can ("A workspace admin can re-approve it"). An explanation that says a role cannot, or that only the provider can, names none. With no explanation the line says the record names no one and that a workspace owner or admin manages MCP servers; with an explanation that names no role it says so, and you add no pointer of your own.
- **The fix:** no command re-approves or re-grants a tool call yet. Say so in one clause and hand over the page the explanation names, with the person's cloud prefix: Connections is `/settings/connections`. When a later verb can make the fix, offer "Want me to do that for you?" and run it on a yes.
- **A read that fails** (no portal, key refused, older cloud) is one line with the reason the script printed; in a status reply it goes under Cannot see.

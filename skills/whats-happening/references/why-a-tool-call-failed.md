# Why a tool call failed

The cloud records every tool call to a connected MCP server: the tool, the outcome, a reason and an explanation. That record is the whole answer; nothing else holds it.

Run `node scripts/tool-call.mjs <server> --ticket KEY-123` (add `--tool <name>` when the person named one). It reads `catalyst mcp status <server> --json`, the record the terminal verb prints, and prints one line.

Reply with that line, as one line: the ticket and phase, the tool, the date of the call, the reason as the cloud wrote it, and who can fix it. Keep the date: an old failure may no longer apply. Add nothing the record does not say. Quote a reason you do not know as spelled.

- **Server:** the person's word, lowercased (WorkOS is workos). The line names the server it read, so a wrong guess shows. When the line says no server by that name is registered, or the read says the name may be wrong, ask for the exact name; for an owner or admin, offer to run `catalyst mcp list`.
- **Window:** the newest 50 calls to that server, no further back. A ticket or tool outside them is inconclusive: say the record cannot say why. Never call it a success. When the line gives the server's state, keep it. When the line says some calls could not be read, keep that clause: the answer may not be the whole picture.
- **Who can fix it:** the script does not decide this, and neither do you. Read the explanation as written; it is in the line. The line says one of three things: "see the explanation above, which mentions a workspace admin" (the explanation mentions that role, which is not a statement that it can fix this), "this script found no workspace owner, admin or operator in the explanation above" (none is mentioned: read it as written and add no pointer of your own), or, with no explanation at all, "the record has no explanation, so it names no one".
- **Not finished:** a call that is pending, running, queued or awaiting approval is neither a failure nor a success. The line says it has not finished; a failed call beside a newer unfinished one is still the one it reports.
- **The fix:** no command re-approves or re-grants a tool call yet. Say so in one clause and hand over the page the explanation names, with the person's cloud prefix: Connections is `/settings/connections`. When a later verb can make the fix, offer "Want me to do that for you?" and run it on a yes.
- **A read that fails** (no portal, key refused, older cloud) is one line the script wrote itself, naming the server and the exit code of `catalyst mcp status`, never the CLI's own words; in a status reply it goes under Cannot see.

#!/usr/bin/env node
// npm's postinstall for @catalyst-cloud/cli (CTC-6975): on a global install, point an older runner
// update agent at this copy (src/agent-repoint.ts). A local or workspace install does nothing, and
// nothing here ever fails the install. CATALYST_NO_AGENT_REPOINT=1 turns it off.
if (process.env.npm_config_global === "true" && process.env.CATALYST_NO_AGENT_REPOINT !== "1") {
  try {
    const { postinstallRepoint } = await import("../dist/agent-repoint.js");
    const line = postinstallRepoint();
    if (line) console.error(line);
  } catch (err) {
    console.error(`catalyst: could not check the runner update agent (${err instanceof Error ? err.message : String(err)}). Run: catalyst runner auto-update on`);
  }
}

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NODE_LOG_NOTICE,
  rewriteEnvText,
  runRunnerUpdate,
  updateResultLines,
  withNodeLogSetting,
} from "../src/runner-update.js";
import { answered, fakeEngine, install, ORIGINAL_ENV, release } from "./runner-update-fixtures.js";

const LINE = "      CATALYST_NODE_LOG_SHIPPING: ${CATALYST_NODE_LOG_SHIPPING-on}\n";
const CLONE = "      CATALYST_GIT_CLONE_TIMEOUT_MS: ${CATALYST_GIT_CLONE_TIMEOUT_MS:-}\n";
const COMPOSE = `name: catalyst-host\nservices:\n  supervisor:\n    environment:\n${CLONE}      NEXT: x\n`;
const update = (dir: string) =>
  runRunnerUpdate(fakeEngine(dir, { read: answered(release({ generation: 106 })), busy: [0, 0] }).engine, { dir });

describe("CTC-8674: an update adds the log setting to an older install", () => {
  it("adds the line setup writes, right after the clone timeout", () => {
    expect(withNodeLogSetting(COMPOSE)).toBe(COMPOSE.replace(CLONE, `${CLONE}${LINE}`));
  });

  it("leaves a file that already names the setting alone, whatever its value", () => {
    const owners = COMPOSE.replace(CLONE, `${CLONE}      CATALYST_NODE_LOG_SHIPPING: off\n`);
    expect(withNodeLogSetting(owners)).toBeNull();
  });

  it("leaves a file it does not recognise alone, so that machine ships nothing", () => {
    expect(withNodeLogSetting("name: catalyst-host\n")).toBeNull();
  });

  it("⭐ the update writes it and prints the change", async () => {
    const dir = install();
    writeFileSync(join(dir, "compose.yaml"), COMPOSE);
    const result = await update(dir);
    expect(result).toMatchObject({ outcome: "updated", notices: [NODE_LOG_NOTICE] });
    expect(readFileSync(join(dir, "compose.yaml"), "utf8")).toContain(LINE);
    expect(updateResultLines(result)).toContain(NODE_LOG_NOTICE);
    expect(NODE_LOG_NOTICE).toContain("CATALYST_NODE_LOG_SHIPPING=off");
  });

  it("the second update changes nothing and says nothing", async () => {
    const dir = install();
    writeFileSync(join(dir, "compose.yaml"), COMPOSE.replace(CLONE, `${CLONE}${LINE}`));
    const before = readFileSync(join(dir, "compose.yaml"), "utf8");
    const result = await update(dir);
    expect(result.outcome).toBe("updated");
    expect(result.notices).toBeUndefined();
    expect(readFileSync(join(dir, "compose.yaml"), "utf8")).toBe(before);
  });

  it.each(["off", "OFF", "no", "false", ""])("⛔ an owner's value %j in .env is never overwritten", async (value) => {
    const env = `${ORIGINAL_ENV}CATALYST_NODE_LOG_SHIPPING=${value}\n`;
    const dir = install(env);
    writeFileSync(join(dir, "compose.yaml"), COMPOSE);
    expect((await update(dir)).outcome).toBe("updated");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain(`\nCATALYST_NODE_LOG_SHIPPING=${value}\n`);
    expect(rewriteEnvText(env, { OTHER: "1" })).toContain(`CATALYST_NODE_LOG_SHIPPING=${value}\n`);
  });
});

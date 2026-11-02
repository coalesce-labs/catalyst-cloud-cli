import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NODE_LOG_NOTICE,
  NODE_LOG_NOTICE_FILE,
  NODE_LOG_NOTICE_VERSION,
  nodeLogNoticeOwed,
  rewriteEnvText,
  runRunnerUpdate,
  updateResultLines,
  withNodeLogSetting,
} from "../src/runner-update.js";
import { answered, fakeEngine, fastClock, install, OLD, ORIGINAL_ENV, release } from "./runner-update-fixtures.js";

const LINE = "      CATALYST_NODE_LOG_SHIPPING: ${CATALYST_NODE_LOG_SHIPPING-on}\n";
const CLONE = "      CATALYST_GIT_CLONE_TIMEOUT_MS: ${CATALYST_GIT_CLONE_TIMEOUT_MS:-}\n";
const COMPOSE = `name: catalyst-host\nservices:\n  supervisor:\n    environment:\n${CLONE}      NEXT: x\n`;
const update = (dir: string) =>
  runRunnerUpdate(fakeEngine(dir, { read: answered(release({ generation: 106 })), busy: [0, 0] }).engine, { dir });
const updateWith = (dir: string, options: Parameters<typeof fakeEngine>[1], scheduled = false) =>
  runRunnerUpdate(fakeEngine(dir, { read: answered(release({ generation: 106 })), busy: [0, 0], ...options }).engine,
    { dir, scheduled, ...fastClock(), readyDeadlineMs: 20_000 });
const notOnNew = (image: string) => image === OLD.supervisor;

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

  it("the second update changes nothing in the file and says nothing once the notice is recorded", async () => {
    const dir = install();
    writeFileSync(join(dir, "compose.yaml"), COMPOSE.replace(CLONE, `${CLONE}${LINE}`));
    writeFileSync(join(dir, NODE_LOG_NOTICE_FILE), `${NODE_LOG_NOTICE_VERSION}\n`);
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

  it("⛔ a rolled-back update takes the line out and says nothing, and the update that stays adds it and says so", async () => {
    const dir = install();
    writeFileSync(join(dir, "compose.yaml"), COMPOSE);
    const failed = await updateWith(dir, { ready: notOnNew });
    expect(failed.outcome).toBe("rolled_back");
    expect(failed.notices).toBeUndefined();
    expect(updateResultLines(failed)).not.toContain(NODE_LOG_NOTICE);
    expect(readFileSync(join(dir, "compose.yaml"), "utf8")).toBe(COMPOSE);
    const applied = await updateWith(dir, {});
    expect(applied).toMatchObject({ outcome: "updated", notices: [NODE_LOG_NOTICE] });
    expect(readFileSync(join(dir, "compose.yaml"), "utf8")).toContain(LINE);
  });

  it("a release kept waiting runs with the line, so the line stays and the run says so", async () => {
    const dir = install();
    writeFileSync(join(dir, "compose.yaml"), COMPOSE);
    // Only a scheduled run keeps a release waiting; a run no schedule follows goes back.
    const kept = await updateWith(dir, { ready: notOnNew, preparationStop: (image) => image !== OLD.supervisor }, true);
    expect(kept).toMatchObject({ outcome: "retained", notices: [NODE_LOG_NOTICE] });
    expect(readFileSync(join(dir, "compose.yaml"), "utf8")).toContain(LINE);
    // Review finding 2: the notice shown here is recorded, so the next update does not show it again.
    expect(nodeLogNoticeOwed(dir, ORIGINAL_ENV)).toBe(false);
  });

  it("the file keeps the mode setup gave it", async () => {
    const dir = install();
    writeFileSync(join(dir, "compose.yaml"), COMPOSE);
    chmodSync(join(dir, "compose.yaml"), 0o644);
    expect((await update(dir)).outcome).toBe("updated");
    expect(statSync(join(dir, "compose.yaml")).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(dir, "compose.yaml"), "utf8")).toContain(LINE);
  });

  it("a compose.yaml it cannot read never fails the update, and the update says nothing about logs", async () => {
    const dir = install();
    rmSync(join(dir, "compose.yaml"));
    mkdirSync(join(dir, "compose.yaml"));
    const result = await update(dir);
    expect(result.outcome).toBe("updated");
    expect(result.notices).toBeUndefined();
  });
});

describe("CTC-8674: a machine told only about service containers is shown the wider notice once", () => {
  const withLine = COMPOSE.replace(CLONE, `${CLONE}${LINE}`);

  it("the notice names the work containers, the machine numbers, that nothing else is sent, and the off setting", () => {
    expect(NODE_LOG_NOTICE).toContain("including the ones tickets run in");
    expect(NODE_LOG_NOTICE).toContain("CPU, memory and free disk");
    expect(NODE_LOG_NOTICE).toContain("Nothing else on this machine is sent.");
    // The supervisor lists every container on the machine to find its own, so it reads more than it sends.
    expect(NODE_LOG_NOTICE).not.toContain("is read");
    expect(NODE_LOG_NOTICE).toContain("CATALYST_NODE_LOG_SHIPPING=off");
  });

  it("⭐ an update on a machine that already ships, with no record, prints it and records it", async () => {
    const dir = install();
    writeFileSync(join(dir, "compose.yaml"), withLine);
    const result = await update(dir);
    expect(result).toMatchObject({ outcome: "updated", notices: [NODE_LOG_NOTICE] });
    expect(updateResultLines(result)).toContain(NODE_LOG_NOTICE);
    expect(readFileSync(join(dir, NODE_LOG_NOTICE_FILE), "utf8")).toBe(`${NODE_LOG_NOTICE_VERSION}\n`);
    expect(statSync(join(dir, NODE_LOG_NOTICE_FILE)).mode & 0o077).toBe(0);
    expect(nodeLogNoticeOwed(dir, ORIGINAL_ENV)).toBe(false);
  });

  it("a record of the earlier notice still owes the new one", () => {
    const dir = install();
    writeFileSync(join(dir, "compose.yaml"), withLine);
    writeFileSync(join(dir, NODE_LOG_NOTICE_FILE), "1\n");
    expect(nodeLogNoticeOwed(dir, ORIGINAL_ENV)).toBe(true);
  });

  it("an update that adds the line records the notice, so the next one owes nothing", async () => {
    const dir = install();
    writeFileSync(join(dir, "compose.yaml"), COMPOSE);
    expect((await update(dir)).notices).toEqual([NODE_LOG_NOTICE]);
    expect(nodeLogNoticeOwed(dir, ORIGINAL_ENV)).toBe(false);
  });

  it.each(["off", "OFF", "no", ""])("⛔ an owner who set %j in .env is not told logs are sent", async (value) => {
    const env = `${ORIGINAL_ENV}CATALYST_NODE_LOG_SHIPPING=${value}\n`;
    const dir = install(env);
    writeFileSync(join(dir, "compose.yaml"), withLine);
    expect(nodeLogNoticeOwed(dir, env)).toBe(false);
    const result = await update(dir);
    expect(result.outcome).toBe("updated");
    expect(result.notices).toBeUndefined();
  });

  it.each(['"on"', "'on'", "on\r", " on "])("an on that Compose reads from %j still owes it", (value) => {
    const env = `${ORIGINAL_ENV}CATALYST_NODE_LOG_SHIPPING=${value}\n`;
    const dir = install(env);
    writeFileSync(join(dir, "compose.yaml"), withLine);
    expect(nodeLogNoticeOwed(dir, env)).toBe(true);
  });

  it.each(['"off"', "off\r", "'on"])("a value Compose does not read as on, %j, owes nothing", (value) => {
    const env = `${ORIGINAL_ENV}CATALYST_NODE_LOG_SHIPPING=${value}\n`;
    const dir = install(env);
    writeFileSync(join(dir, "compose.yaml"), withLine);
    expect(nodeLogNoticeOwed(dir, env)).toBe(false);
  });

  it("an explicit on still owes it", () => {
    const env = `${ORIGINAL_ENV}CATALYST_NODE_LOG_SHIPPING=on\n`;
    const dir = install(env);
    writeFileSync(join(dir, "compose.yaml"), withLine);
    expect(nodeLogNoticeOwed(dir, env)).toBe(true);
  });

  it("a Compose file without the setting owes nothing, since that machine sends nothing", () => {
    const dir = install();
    writeFileSync(join(dir, "compose.yaml"), "name: catalyst-host\n");
    expect(nodeLogNoticeOwed(dir, ORIGINAL_ENV)).toBe(false);
  });

  it("a rolled-back update with the line already there says nothing and records nothing", async () => {
    const dir = install();
    writeFileSync(join(dir, "compose.yaml"), withLine);
    const failed = await updateWith(dir, { ready: notOnNew });
    expect(failed.outcome).toBe("rolled_back");
    expect(failed.notices).toBeUndefined();
    expect(nodeLogNoticeOwed(dir, ORIGINAL_ENV)).toBe(true);
  });
});

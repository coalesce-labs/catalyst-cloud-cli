import { describe, expect, it } from "vitest";
import { validateFullSettings } from "../vendor/settings/index.js";

const project = '[project]\nlinear_team = "CTC"\n';
const declarations = `
[[environment.variables]]
name = "PUBLIC_URL"
[[environment.variables]]
name = "API_TOKEN"
secret = true
`;

describe("whole-file settings authority", () => {
  it("projects separate validated ordinary and secret names", () => {
    expect(validateFullSettings(project + declarations)).toEqual({
      ok: true,
      errors: [],
      linearTeam: "CTC",
      variableNames: ["PUBLIC_URL"],
      secretNames: ["API_TOKEN"],
    });
    expect(validateFullSettings(project)).toEqual({
      ok: true,
      errors: [],
      linearTeam: "CTC",
      variableNames: [],
      secretNames: [],
    });
  });

  it.each([
    declarations,
    project + declarations + "\n[runner]\nunknown = true\n",
    project + declarations + "\n[review]\nunknown = true\n",
    project + declarations + "\n[environment.start]\nunknown = true\n",
    project +
      declarations +
      '\n[[environment.variables]]\nname = "PUBLIC_URL"\n',
    project +
      '\n[[environment.variables]]\nname = "PUBLIC_URL"\nvalue = "do-not-expose"\n',
    project + '\n[unknown_do_not_expose]\nvalue = "do-not-expose"\n',
    project + '\n[runner]\ncommand = "echo $UNDECLARED"\n',
    'broken = "do-not-expose',
  ])(
    "refuses invalid whole files despite a usable environment projection",
    (text) => {
      const result = validateFullSettings(text);
      expect(result).toEqual({
        ok: false,
        errors: ["Settings file could not be fully validated"],
      });
      expect(JSON.stringify(result)).not.toContain("do-not-expose");
      expect(result).not.toHaveProperty("variableNames");
      expect(result).not.toHaveProperty("secretNames");
    },
  );

  it("accepts description, agent_prompt and an optional asset (CTC-10715)", () => {
    const text =
      project +
      `
[[environment.variables]]
name = "PUBLIC_URL"
description = "Where the app is served"
agent_prompt = "Ask the operator for the staging URL"
[[environment.clis]]
name = "gh"
required = false
description = "GitHub CLI"
agent_prompt = "Use it to read pull requests"
[environment.clis.install]
source = "npm"
package = "gh"
version = "1.0.0"
`;
    expect(validateFullSettings(text)).toEqual({
      ok: true,
      errors: [],
      linearTeam: "CTC",
      variableNames: ["PUBLIC_URL"],
      secretNames: [],
    });
  });

  it("bounds oversized source without leaking a literal", () => {
    expect(validateFullSettings(project + "#".repeat(1_048_577))).toEqual({
      ok: false,
      errors: ["Settings file could not be fully validated"],
    });
  });
});

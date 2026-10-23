import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(root, "skills");

// Snapshot of the labels and route templates in catalyst-cloud origin/main at 2026-09-29
// (app-router.tsx, settings-nav.tsx, project-settings-view.tsx, repo-settings-view.tsx,
// environment-sections.tsx). The Linear path is from the current Linear Workflow automations UI.
// Keep this map in step with those sources when a settings label or route changes.
const settingsPaths = [
  {
    labels: ["Settings", "Your projects"],
    route: "/settings/projects",
  },
  {
    labels: ["Settings", "Your projects", "the project", "Repositories"],
    route: "/settings/projects/$projectId",
  },
  {
    labels: [
      "Settings",
      "Your projects",
      "the project",
      "Repositories",
      "the repository",
      "Environment",
      "Setup declaration",
      "Approve this revision",
    ],
    route:
      "/settings/projects/$projectId/repositories/$repoId/environment/declaration",
  },
  {
    labels: [
      "Settings",
      "Your projects",
      "the project",
      "Repositories",
      "the repository",
      "Code reviews",
    ],
    route: "/settings/projects/$projectId/repositories/$repoId/code-reviews",
  },
  { labels: ["Settings", "Integrations"], route: "/settings/connections" },
  {
    labels: ["Settings", "Your projects", "the project", "Linear workflow for"],
    route: "/settings/linear-teams/$teamKey",
  },
  { labels: ["Settings", "Members"], route: "/settings/members" },
  { labels: ["Settings", "AI accounts"], route: "/settings/coding-accounts" },
  { labels: ["Settings", "API keys"], route: "/settings/api-keys" },
  { labels: ["Settings", "Environment"], route: "/settings/environment" },
  {
    labels: ["Settings", "AI accounts", "the account", "Replace credential"],
    route: "/settings/coding-accounts",
  },
  { labels: ["Settings", "Profile"], route: "/settings/profile" },
  {
    labels: [
      "Settings",
      "Teams",
      "<team>",
      "Workflow",
      "Workflows & automations",
      "Pull request and commit automations",
      "No action",
    ],
    route: "Linear Settings → Teams → Workflow → Workflows & automations",
  },
] as const;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const proseFiles = [
  ...walk(skillsRoot).filter(
    (path) =>
      path.endsWith("SKILL.md") ||
      (path.includes(`${join("references", "")}`) && path.endsWith(".md")),
  ),
  join(root, "src", "ready.ts"),
  join(root, "skills", "catalyst-onboard", "scripts", "where-am-i.mjs"),
];

describe("onboarding UI path copy", () => {
  test("every Settings path begins with a route and label in the current app map", () => {
    const findings: string[] = [];
    for (const file of proseFiles) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(/Settings →([^\n.;|),]+)/g)) {
        const labels = [
          "Settings",
          ...match[1]!.split("→").map((part) => part.trim()),
        ];
        const supported = settingsPaths.some((entry) =>
          labels.every((actual, index) => {
            const label = entry.labels[index];
            if (label === undefined) return false;
            return (
              actual === label ||
              actual.startsWith(label) ||
              (label === "<team>" && Boolean(actual))
            );
          }),
        );
        if (!supported) {
          findings.push(`${relative(root, file)}: ${match[0]!.trim()}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  test("the retired account repositories and connections labels are absent", () => {
    const findings = proseFiles.flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return [
        ...content.matchAll(
          /Settings → (?:Repositories|Connections|Linear [Tt]eams)(?: →|[,.;])/g,
        ),
        ...content.matchAll(/\/settings\/repositories(?:\/|\b)/g),
      ].map((match) => `${relative(root, file)}: ${match[0]}`);
    });
    expect(findings).toEqual([]);
  });

  test("the current route map includes each direct declaration and integration destination", () => {
    for (const required of [
      "/settings/projects",
      "/settings/projects/$projectId/repositories/$repoId/environment/declaration",
      "/settings/connections",
      "/settings/linear-teams/$teamKey",
    ]) {
      expect(
        settingsPaths.some((entry) => entry.route === required),
        required,
      ).toBe(true);
    }
  });
});

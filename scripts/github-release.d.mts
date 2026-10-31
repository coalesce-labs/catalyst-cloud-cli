export const TAG_PREFIX: string;
export function versionOfTag(tag: string): string;
export function compareVersions(a: string, b: string): number;
export function highestVersion(tags: string[]): string | undefined;
export function releaseNotes(changelog: string, version: string): string;
export function releaseTitle(version: string): string;

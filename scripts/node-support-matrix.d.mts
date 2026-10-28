export interface ScheduleEntry {
  start?: string;
  lts?: string;
  maintenance?: string;
  end?: string;
}
export type Schedule = Record<string, ScheduleEntry>;
export type MajorPhase = "current" | "active-lts" | "maintenance" | "eol" | "unreleased";

export interface MatrixResult {
  majors: string[];
  /** CTC-8223: the one major an ordinary pull request checks. */
  pullRequest: string[];
  degraded?: boolean;
  warning?: string;
}

export function parseMajor(range: string): number;
export function classify(entry: ScheduleEntry, now: string): MajorPhase;
export function deriveMatrix(o: { engines: string; schedule: Schedule | null; now: string }): MatrixResult;
export function formatForGithub(majors: string[]): string;

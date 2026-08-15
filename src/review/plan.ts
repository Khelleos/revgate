import type { DiffFile } from "../shared/types.js";

/**
 * Model a plan as a synthetic single-file "diff", so the whole review pipeline
 * works on it unchanged. Every plan line becomes a commentable line numbered
 * from 1 on the "new" side.
 */
export function planToFiles(planText: string): DiffFile[] {
  const normalized = planText.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  const lines = normalized.length ? normalized.split("\n") : [""];
  return [
    {
      oldPath: "",
      newPath: "PLAN",
      path: "Plan",
      isNew: false,
      isDeleted: false,
      isRenamed: false,
      isBinary: false,
      additions: 0,
      deletions: 0,
      hunks: [
        {
          header: "",
          oldStart: 0,
          newStart: 1,
          lines: lines.map((content, i) => ({
            type: "plan" as const,
            content,
            oldLine: null,
            newLine: i + 1,
          })),
        },
      ],
    },
  ];
}

/** The first markdown H1/H2 as a short title, else a generic label. */
export function planTitle(planText: string): string {
  for (const line of planText.split("\n")) {
    const m = line.match(/^#{1,2}\s+(.+)/);
    if (m) return m[1].trim();
  }
  return "Proposed plan";
}

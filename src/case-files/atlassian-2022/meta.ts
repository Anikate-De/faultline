import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-atlassian-2022",
  slug: "atlassian-2022",
  title: "Atlassian 2022: Restoring a Deleted Site",
  track: "case-files",
  order: 14,
  difficulty: 3,
  minutes: 22,
  prerequisites: ["databases-backups-pitr"],
  tags: ["destructive action", "soft delete", "permissions", "restore", "RTO"],
  productionQuestion:
    "An operator action deletes a site and the restore takes days. What controls prevent this?",
  learningDelta:
    "Destructive actions need soft delete, scoped permissions, and tested restore; control-plane mistakes are data-loss incidents",
  objectives: [
    "Trace how a well-reviewed script can still remove the wrong resource type.",
    "Separate backup coverage from a tested, end-to-end restore capability.",
    "Sequence a large restore when every site is both a customer and a dependency.",
    "Design deletion controls that bound blast radius before execution.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

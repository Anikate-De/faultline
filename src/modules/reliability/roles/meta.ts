import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-roles",
  slug: "roles",
  title: "Incident Roles",
  track: "reliability",
  order: 2,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["reliability-incident-command"],
  tags: ["roles", "command", "operations", "communications", "SME"],
  productionQuestion:
    "The database expert is also writing customer updates and misses the fix. How do you staff the incident?",
  learningDelta:
    "Separate command, operations, communications, and subject-matter roles; one person may hold two only in small incidents",
  objectives: [
    "Distinguish a role from the person currently filling it.",
    "Recognize when a subject-matter expert is being consumed by coordination work.",
    "Staff an incident from the roles the response needs, not from who is available first.",
    "Decide when to combine roles and when the combination becomes the failure.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

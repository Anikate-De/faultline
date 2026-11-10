import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-dr-drills",
  slug: "dr-drills",
  title: "DR Drills: Prove RTO and RPO",
  track: "databases",
  order: 14,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["databases-cross-region-rpo"],
  tags: ["DR drill", "RTO", "RPO", "restore", "cutover", "game day"],
  productionQuestion: "The DR plan says 15 minutes RTO. Has anyone measured it?",
  learningDelta:
    "Untested recovery is a hypothesis; drills measure restore time, data loss, DNS cutover, and application readiness",
  objectives: [
    "Decompose measured RTO into detection, decision, restore, cutover, and application readiness.",
    "Separate the recovery point achieved in a drill from the RPO written in the plan.",
    "Find the unmeasured dependency that lets a database restore pass while the service still fails.",
    "Design a drill that produces evidence without creating a second incident.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

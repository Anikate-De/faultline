import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-parameter-groups",
  slug: "parameter-groups",
  title: "Parameter Groups: Change With a Plan",
  track: "databases",
  order: 26,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["databases-rds-aurora-arch"],
  tags: ["parameter group", "dynamic", "static", "reboot", "cluster parameter"],
  productionQuestion:
    "A parameter change improves one query and breaks another. How do you roll it out?",
  learningDelta:
    "Parameter groups apply engine settings; some are dynamic, some require reboot, and cluster-level settings have different scope",
  objectives: [
    "Classify a setting as dynamic or static and name its apply path.",
    "Explain cluster-level versus instance-level parameter scope.",
    "Plan a change with a canary, a maintenance window, and a rollback.",
    "Predict the blast radius of a reboot during peak traffic.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

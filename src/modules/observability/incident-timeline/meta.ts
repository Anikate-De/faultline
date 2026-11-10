import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-incident-timeline",
  slug: "incident-timeline",
  title: "Reconstructing the Incident Timeline",
  track: "observability",
  order: 28,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["observability-dashboard-question"],
  tags: ["timeline", "clock skew", "annotation", "deploy marker", "causality"],
  productionQuestion:
    "The postmortem says the rollback started at 14:20 but the graphs disagree. Which clock do you trust?",
  learningDelta:
    "Timelines require synchronized timestamps, deploy markers, and event sources; clock skew and missing annotations create false causality",
  objectives: [
    "Reconstruct event order from metrics, logs, deploy markers, and human decisions.",
    "Detect when clock skew reverses cause and effect.",
    "Choose which clock to trust and how to state uncertainty in a timeline.",
    "Add annotations and synchronization checks that make the next timeline defensible.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

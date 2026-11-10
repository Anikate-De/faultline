import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-use-red",
  slug: "use-red",
  title: "USE and RED: Two Lenses on One System",
  track: "foundations",
  order: 1,
  difficulty: 1,
  minutes: 16,
  prerequisites: [],
  tags: ["USE", "RED", "utilization", "saturation", "errors", "duration"],
  productionQuestion:
    "Is this a resource problem or a request-path problem, and which signal set tells you first?",
  learningDelta:
    "USE finds saturated resources; RED finds sick request paths; using one where the other belongs hides the cause",
  objectives: [
    "Tell a resource problem from a request-path problem before choosing a dashboard.",
    "Read utilization, saturation, and errors as three separate resource signals.",
    "Read rate, errors, and duration as three separate service signals.",
    "Explain how a buffered write path keeps RED green while the disk saturates.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

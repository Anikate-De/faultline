import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-netflix-2012",
  slug: "netflix-2012",
  title: "Netflix 2012: The AZ Failure That Changed Architecture",
  track: "case-files",
  order: 16,
  difficulty: 3,
  minutes: 22,
  prerequisites: ["traffic-zonal-isolation"],
  tags: ["AZ failure", "isolation", "capacity", "dependency", "chaos"],
  productionQuestion:
    "One AZ fails and the service degrades more than the capacity math predicts. Why?",
  learningDelta:
    "AZ isolation requires independent dependencies and capacity; a shared control plane or data store breaks the model",
  objectives: [
    "Distinguish an availability-zone failure from a regional control-plane failure.",
    "Map which dependencies are regional even when workloads are zonal.",
    "Explain why healthy instances can serve no traffic.",
    "Design and test a cross-region ingress path rather than assuming one exists.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

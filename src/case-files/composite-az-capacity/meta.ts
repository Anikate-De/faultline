import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-az-capacity",
  slug: "composite-az-capacity",
  title: "Composite: The AZ Loss With N+0 Headroom",
  track: "case-files",
  order: 30,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["foundations-capacity-headroom"],
  tags: ["AZ failure", "headroom", "capacity", "N+1", "peak"],
  productionQuestion:
    "One AZ fails and the remaining zones cannot carry peak. What was the actual headroom?",
  learningDelta:
    "Headroom must be measured after the largest failure, not on the pre-failure fleet",
  objectives: [
    "Calculate post-failure utilization from pre-failure load and zone count.",
    "Explain why 60% per zone is not N+1 at the latency SLO.",
    "Choose a mitigation that protects the critical path before capacity arrives.",
    "Design a headroom target that includes queueing behavior.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

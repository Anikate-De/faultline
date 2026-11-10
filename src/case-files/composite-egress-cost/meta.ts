import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-egress-cost",
  slug: "composite-egress-cost",
  title: "Composite: The Cross-Region Bill",
  track: "case-files",
  order: 42,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["cloud-networking-egress-cost"],
  tags: ["egress", "cross-region", "cost", "flow logs", "attribution"],
  productionQuestion:
    "The network bill doubles after a service move and no one can name the path. How do you find it?",
  learningDelta:
    "Egress cost follows topology and chatter; flow data plus tags attribute cost to the service that creates it",
  objectives: [
    "Attribute a data-transfer increase to a service pair and traffic path.",
    "Distinguish per-byte charges from per-request chatter and NAT processing.",
    "Choose a mitigation that changes topology rather than only negotiating price.",
    "Make egress cost visible to the team that controls the call pattern.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

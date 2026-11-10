import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-tgw-route",
  slug: "composite-tgw-route",
  title: "Composite: The Transit Gateway Route Loop",
  track: "case-files",
  order: 57,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["cloud-networking-route-propagation"],
  tags: ["Transit Gateway", "asymmetric routing", "route table", "stateful", "blackhole"],
  productionQuestion:
    "Traffic enters through one attachment and returns through another, then disappears. What is wrong?",
  learningDelta:
    "Asymmetric routing breaks stateful inspection and return paths; TGW route tables must be symmetric by design",
  objectives: [
    "Trace a transit gateway flow in both directions using associations and route lookups.",
    "Explain why a stateful firewall drops a flow it only sees in one direction.",
    "Correct an over-specific propagated route that bypasses a central inspection VPC.",
    "Design route tables and tests that keep forward and return paths symmetric.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

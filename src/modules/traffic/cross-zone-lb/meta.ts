import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-cross-zone-lb",
  slug: "cross-zone-lb",
  title: "Cross-Zone Load Balancing",
  track: "traffic",
  order: 8,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-alb-target-groups"],
  tags: ["cross-zone", "AZ", "target distribution", "data transfer", "zonal isolation"],
  productionQuestion:
    "Two AZs have healthy targets, but one AZ gets most traffic. What setting explains it?",
  learningDelta:
    "Cross-zone balancing distributes across healthy targets in all zones; disabling it isolates zones but can strand capacity",
  objectives: [
    "Explain how a load balancer node chooses targets with cross-zone on and off.",
    "Recognize a per-zone target distribution that is not a health or capacity problem.",
    "Compare zonal isolation, cross-AZ latency, and data-transfer cost.",
    "Choose the cross-zone setting from the failure-domain and capacity requirements.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

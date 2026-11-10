import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-egress-cost",
  slug: "egress-cost",
  title: "Egress Cost",
  track: "cloud-networking",
  order: 32,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["cloud-networking-cross-az-region"],
  tags: ["egress", "data transfer", "NAT", "cross-AZ", "cost allocation"],
  productionQuestion:
    "The network bill is dominated by data transfer and no one knows which path. How do you attribute it?",
  learningDelta:
    "Egress costs differ by boundary: AZ, region, internet, and NAT processing; attribution needs flow data and tags",
  objectives: [
    "Attribute a data-transfer bill to the path that created it, not to the service with the largest total spend.",
    "Compare cross-AZ, cross-region, internet, and NAT processing rates.",
    "Recognize a chatty service-to-service path that dominates cost without a traffic spike.",
    "Choose the cheapest boundary change that preserves latency and resilience.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

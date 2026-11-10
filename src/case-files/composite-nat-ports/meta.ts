import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-nat-ports",
  slug: "composite-nat-ports",
  title: "Composite: NAT Port Exhaustion at Peak",
  track: "case-files",
  order: 29,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["foundations-conntrack"],
  tags: ["NAT", "ports", "conntrack", "churn", "egress"],
  productionQuestion:
    "New outbound connections fail while throughput is low. What resource is exhausted?",
  learningDelta:
    "NAT port allocation and conntrack state can fail before bandwidth; connection churn is the driver",
  objectives: [
    "Distinguish port exhaustion from bandwidth saturation.",
    "Read NAT and conntrack signals during an egress failure.",
    "Reduce connection churn as the fastest mitigation.",
    "Size NAT capacity from churn, not average throughput.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

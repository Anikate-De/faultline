import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-nat-scaling",
  slug: "nat-scaling",
  title: "NAT Gateway Scaling",
  track: "cloud-networking",
  order: 31,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["cloud-networking-nat-gateway"],
  tags: ["NAT", "bandwidth", "port allocation", "AZ", "scaling"],
  productionQuestion:
    "Egress latency rises across all private subnets and NAT is the common component. What do you check?",
  learningDelta:
    "NAT gateways scale per AZ and have bandwidth and port limits; one NAT for many AZs concentrates traffic and failure",
  objectives: [
    "Separate a NAT bandwidth limit from a per-destination port allocation limit.",
    "Read egress latency and connection errors when the NAT is the common component.",
    "Explain why one NAT gateway shared across Availability Zones concentrates both traffic and failure.",
    "Design per-AZ egress that scales without turning one gateway into a single point of failure.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

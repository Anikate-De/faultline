import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-vpc",
  slug: "vpc",
  title: "VPC Fundamentals",
  track: "cloud-networking",
  order: 1,
  difficulty: 1,
  minutes: 16,
  prerequisites: ["foundations-linux-network-saturation"],
  tags: ["VPC", "CIDR", "route table", "gateway", "isolation"],
  productionQuestion:
    "Two services cannot reach each other and both have public IPs. What is the first network boundary?",
  learningDelta:
    "A VPC is an isolated network with its own address space, route tables, and gateways; public IPs do not imply reachability",
  objectives: [
    "Explain what a VPC boundary is and why a public IP is an address rather than a path.",
    "Trace a private packet through the source route table, the peering attachment, and the peer route table.",
    "Distinguish a missing route from a blackhole route and from a missing return path.",
    "Decide when to restore a peering connection, add routes, or choose a different connectivity service.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

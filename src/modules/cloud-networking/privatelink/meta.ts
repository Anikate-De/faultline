import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-privatelink",
  slug: "privatelink",
  title: "PrivateLink",
  track: "cloud-networking",
  order: 12,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["cloud-networking-vpc-endpoints"],
  tags: ["PrivateLink", "endpoint service", "NLB", "CIDR", "private"],
  productionQuestion:
    "A SaaS provider needs to reach your VPC without overlapping CIDRs. What do you use?",
  learningDelta:
    "PrivateLink exposes a service through an endpoint in the consumer VPC, avoiding CIDR overlap and broad routing",
  objectives: [
    "Describe how an interface endpoint, an endpoint service, and a Network Load Balancer form a PrivateLink path.",
    "Choose endpoint Availability Zone coverage that does not depend on a single zone.",
    "Separate endpoint acceptance, endpoint policy, and provider target health when connectivity fails.",
    "Decide when PrivateLink is a better fit than VPC peering or a transit gateway.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

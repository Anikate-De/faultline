import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-nat-gateway",
  slug: "nat-gateway",
  title: "NAT Gateway",
  track: "cloud-networking",
  order: 4,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["cloud-networking-subnets"],
  tags: ["NAT", "private subnet", "egress", "AZ", "translation"],
  productionQuestion:
    "Private tasks can reach S3 but not the internet. What is missing?",
  learningDelta:
    "NAT gateways provide outbound translation for private subnets; they are zonal, bandwidth-bound, and charge per GB",
  objectives: [
    "Trace private-subnet egress through a NAT gateway, its public subnet, and the internet gateway.",
    "Explain why a NAT gateway is zonal and why a shared NAT concentrates failure across Availability Zones.",
    "Read NAT connection pressure and port-allocation signals before users report timeouts.",
    "Design per-AZ egress that keeps the blast radius to one Availability Zone.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

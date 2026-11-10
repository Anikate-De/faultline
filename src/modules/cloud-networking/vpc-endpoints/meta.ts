import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-vpc-endpoints",
  slug: "vpc-endpoints",
  title: "VPC Endpoints",
  track: "cloud-networking",
  order: 13,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["cloud-networking-nat-gateway"],
  tags: ["VPC endpoint", "gateway", "interface", "ENI", "private"],
  productionQuestion: "S3 traffic is expensive through NAT. How do you keep it private?",
  learningDelta:
    "Gateway endpoints keep S3/DynamoDB traffic on the AWS network; interface endpoints use ENIs and security groups",
  objectives: [
    "Choose a gateway or interface endpoint from the service, source network, and access-control requirements.",
    "Trace whether AWS service traffic uses the endpoint or the NAT gateway.",
    "Explain why an endpoint policy denial does not fall back to NAT.",
    "Use route association, private DNS, endpoint policy, and security groups in the right order.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-s3-gateway-endpoint",
  slug: "s3-gateway-endpoint",
  title: "S3 Gateway Endpoints",
  track: "cloud-networking",
  order: 14,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["cloud-networking-vpc-endpoints"],
  tags: ["S3", "gateway endpoint", "route table", "NAT cost", "policy"],
  productionQuestion: "A private subnet uploads to S3 and the NAT bill is large. What changes?",
  learningDelta:
    "A gateway endpoint adds a route to S3 in the route table, avoiding NAT data processing charges",
  objectives: [
    "Explain how a gateway endpoint routes S3 traffic through a prefix-list route instead of NAT.",
    "Associate the right route tables and verify that S3 traffic actually left the NAT path.",
    "Recognize a bucket policy that requires the endpoint and fails when traffic bypasses it.",
    "Decide when a gateway endpoint is insufficient and an S3 interface endpoint is required.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

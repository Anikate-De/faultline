import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-zero-trust",
  slug: "zero-trust",
  title: "Zero Trust",
  track: "cloud-networking",
  order: 28,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mesh-mtls"],
  tags: ["zero trust", "identity", "mTLS", "authorization", "least privilege"],
  productionQuestion:
    "A compromised internal host can reach every service. What changes?",
  learningDelta:
    "Zero trust authenticates and authorizes each service request; network location is not identity",
  objectives: [
    "Explain why an internal IP address or security group is not an authorization decision.",
    "Separate workload authentication from per-request authorization.",
    "Recognize a flat network's blast radius when one internal host is compromised.",
    "Design a zero-trust rollout that adds identity checks without blocking legitimate service calls.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

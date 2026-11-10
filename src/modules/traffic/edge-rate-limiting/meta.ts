import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-edge-rate-limiting",
  slug: "edge-rate-limiting",
  title: "Edge Rate Limiting: Protect the Origin",
  track: "traffic",
  order: 24,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-waf-rate-limits"],
  tags: ["rate limit", "API key", "NAT", "fairness", "edge", "origin"],
  productionQuestion:
    "One API key sends 80% of requests and the origin is saturated. Where do you limit?",
  learningDelta:
    "Per-key, per-IP, and global limits solve different abuse; edge limits must account for NAT and shared clients",
  objectives: [
    "Compare per-key, per-IP, and global limits by what they protect and who they punish.",
    "Explain how a shared NAT turns a per-IP limit into collateral damage.",
    "Measure origin load, throttled traffic, and NAT false positives together.",
    "Choose an aggregation key that matches the abusive unit and the client topology.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

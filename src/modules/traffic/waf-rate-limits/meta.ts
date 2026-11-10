import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-waf-rate-limits",
  slug: "waf-rate-limits",
  title: "WAF and Edge Rate Limits",
  track: "traffic",
  order: 19,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-rate-limiting"],
  tags: ["WAF", "rate limit", "bot", "rule", "false positive", "edge"],
  productionQuestion:
    "A credential-stuffing wave is exhausting the login service. Where do you enforce limits?",
  learningDelta:
    "Edge WAF rules and rate limits stop abuse before compute, but thresholds and match conditions decide false positives",
  objectives: [
    "Place a rate-based WAF rule where it protects the login service without counting unrelated traffic.",
    "Measure attack pass-through and legitimate-user false positives together.",
    "Explain why a per-IP threshold can miss a distributed attack and block a shared NAT.",
    "Tune a rule in count mode before enforcing it at the edge.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

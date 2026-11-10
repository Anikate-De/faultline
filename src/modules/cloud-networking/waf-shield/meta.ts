import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-waf-shield",
  slug: "waf-shield",
  title: "WAF and Shield Together",
  track: "cloud-networking",
  order: 27,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["traffic-ddos-shield"],
  tags: ["WAF", "Shield", "L3/L4", "L7", "rate limit"],
  productionQuestion:
    "A Layer 7 attack passes the WAF and saturates the origin. What layer failed?",
  learningDelta:
    "Shield protects volumetric L3/L4; WAF inspects L7 requests; neither replaces origin capacity or rate limiting",
  objectives: [
    "Separate a volumetric L3/L4 attack from an application-layer L7 request flood.",
    "Read origin utilization and error rate when the WAF is blocking most requests.",
    "Explain why a high block percentage can still leave the origin saturated.",
    "Layer Shield, WAF rules, rate limiting, and origin capacity without treating one as a complete defense.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-slack-2021",
  slug: "slack-2021",
  title: "Slack 2021: A Traffic Surge and the Cache Path",
  track: "case-files",
  order: 13,
  difficulty: 3,
  minutes: 22,
  prerequisites: ["caching-cache-stampede"],
  tags: ["traffic surge", "cache", "shared dependency", "elasticity", "degradation"],
  productionQuestion:
    "Traffic doubles on the first workday of the year and the service degrades. What breaks first?",
  learningDelta:
    "Surge incidents find the least elastic shared dependency; cache, DNS, and connection pools fail before CPU averages move",
  objectives: [
    "Distinguish a demand surge from the shared dependency that cannot absorb it.",
    "Explain why autoscaling signals can point in opposite directions during packet loss.",
    "Separate serving capacity from the provisioning path that creates it.",
    "Design a recovery check that does not depend on the degraded network.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

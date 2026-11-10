import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-rolling",
  slug: "rolling",
  title: "Rolling Deployments",
  track: "deployment",
  order: 1,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["containers-rolling-deployments"],
  tags: ["rolling", "surge", "healthy minimum", "capacity", "health check"],
  productionQuestion: "A rolling deploy causes a brief 503 spike. What is the capacity math?",
  learningDelta:
    "Rolling deploys trade capacity for speed; minimum healthy and maximum surge determine whether the fleet survives the transition",
  objectives: [
    "Calculate the capacity floor a rolling deployment is allowed to reach.",
    "Distinguish the minimum healthy floor from the maximum surge allowance.",
    "Explain why zero surge with a 100 percent healthy minimum cannot make progress.",
    "Choose rolling settings that keep available capacity above the request rate.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

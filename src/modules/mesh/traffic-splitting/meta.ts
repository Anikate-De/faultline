import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-traffic-splitting",
  slug: "traffic-splitting",
  title: "Traffic Splitting",
  track: "mesh",
  order: 10,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["mesh-envoy-routes"],
  tags: ["traffic split", "weight", "canary", "rollback", "route"],
  productionQuestion: "You need 5% canary traffic and instant rollback. Where do you implement it?",
  learningDelta:
    "Mesh traffic splitting weights clusters by route; it is fast to change but must align with observability and health",
  objectives: [
    "Place a weighted split at the proxy route instead of changing clients.",
    "Calculate the observed error rate when one version has a higher failure share.",
    "Explain why a weight change can expose an unready version.",
    "Design a rollback that restores the stable version without a deploy.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-nlb-in-front-of-alb",
  slug: "nlb-in-front-of-alb",
  title: "NLB in Front of ALB: What It Buys and Costs",
  track: "traffic",
  order: 6,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["traffic-alb-connection-limit"],
  tags: ["NLB", "ALB", "static IP", "TLS passthrough", "source IP", "hop"],
  productionQuestion:
    "You need static IPs and ALB path routing at very high connection counts. How do you combine them?",
  learningDelta:
    "An NLB can front ALBs with static IPs and high connection capacity, adding a hop and changing source-IP and TLS behavior",
  objectives: [
    "Explain what an NLB adds in front of an ALB and what it cannot add.",
    "Trace TLS termination, client IP, and health checks across the two layers.",
    "Predict the latency and failure behavior of the extra hop.",
    "Decide between NLB fronting, DNS sharding, and a single ALB.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

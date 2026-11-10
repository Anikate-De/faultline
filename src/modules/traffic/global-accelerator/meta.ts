import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-global-accelerator",
  slug: "global-accelerator",
  title: "Global Accelerator: Anycast for Your ALBs",
  track: "traffic",
  order: 25,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["traffic-anycast"],
  tags: ["Global Accelerator", "anycast", "endpoint group", "failover", "backbone"],
  productionQuestion:
    "Users on another continent see 300ms extra and DNS failover is too slow. What does Global Accelerator change?",
  learningDelta:
    "Global Accelerator uses anycast IPs and AWS backbone to reach regional endpoints; it removes DNS TTL from the failover path",
  objectives: [
    "Explain how Global Accelerator combines anycast entry, AWS backbone, and health-checked endpoint groups.",
    "Compare Global Accelerator failover with DNS failover for latency, client caching, and connection behavior.",
    "Diagnose a deployment that still waits on DNS because clients bypass the accelerator.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

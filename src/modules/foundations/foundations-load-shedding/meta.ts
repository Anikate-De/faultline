import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-load-shedding",
  slug: "foundations-load-shedding",
  title: "Load Shedding: Protect Goodput",
  track: "foundations",
  order: 13,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-queueing-knee"],
  tags: ["admission control", "goodput", "rejection", "priority", "queue limit"],
  productionQuestion:
    "The system can serve 10k RPS and receives 30k; what should it do?",
  learningDelta:
    "Beyond capacity, serving everything degrades goodput; shedding low-value work early preserves useful throughput",
  objectives: [
    "Distinguish throughput from goodput and explain why serving more requests can help fewer users.",
    "Choose a queue bound and a shed trigger from the latency deadline, not from CPU alone.",
    "Rank traffic by value and explain who gets rejected when demand exceeds capacity.",
    "Defend the fairness and over-shedding risks of an admission policy.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

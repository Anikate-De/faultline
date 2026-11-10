import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-spot-interruptions",
  slug: "spot-interruptions",
  title: "Spot Interruptions",
  track: "capacity",
  order: 10,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["containers-fargate-spot"],
  tags: ["Spot", "interruption", "checkpoint", "drain", "capacity"],
  productionQuestion:
    "Spot instances are 70% cheaper but tasks disappear. Which workloads fit?",
  learningDelta:
    "Spot capacity is interruptible with notice; stateless, checkpointed, and drainable workloads tolerate it",
  objectives: [
    "Decide which workloads can run on interruptible capacity.",
    "Design a checkpoint and drain path that limits lost work.",
    "Diagnose a fleet that loses capacity without a fallback.",
    "Balance Spot share against completion and cost risk.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

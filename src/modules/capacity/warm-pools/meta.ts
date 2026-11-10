import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-warm-pools",
  slug: "warm-pools",
  title: "Warm Pools",
  track: "capacity",
  order: 5,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["containers-fargate-cold-start"],
  tags: ["warm pool", "cold start", "scale-out", "idle cost", "ramp"],
  productionQuestion:
    "Autoscaling takes 3 minutes to add capacity. Do you keep warm instances?",
  learningDelta:
    "Warm pools trade idle cost for faster scale-out; pool size must match the ramp rate, not the peak",
  objectives: [
    "Explain how a warm pool shortens time-to-capacity during a ramp.",
    "Size a pool from the ramp gap rather than from peak demand.",
    "Diagnose a pool that is exhausted before the traffic peak arrives.",
    "Quantify the idle capacity a pool holds when demand is flat.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

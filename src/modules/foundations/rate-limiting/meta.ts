import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-rate-limiting",
  slug: "rate-limiting",
  title: "Rate Limiting: Token Bucket vs Fixed Window",
  track: "foundations",
  order: 27,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-queueing-knee"],
  tags: ["token bucket", "leaky bucket", "fixed window", "sliding window", "burst"],
  productionQuestion:
    "A fixed-window limiter allows 2× the intended rate at the window boundary; how do you fix it?",
  learningDelta:
    "Token bucket smooths average rate while allowing a bounded burst; fixed windows permit boundary spikes",
  objectives: [
    "Explain how a fixed window can admit twice its configured rate across a boundary.",
    "Choose between token bucket, fixed window, and sliding window for a traffic shape.",
    "Read admitted, rejected, and burst-multiplier signals together.",
    "Defend a burst allowance without turning it into an unbounded exception.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

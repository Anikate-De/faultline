import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-backpressure",
  slug: "foundations-backpressure",
  title: "Backpressure: Make the Producer Slow Down",
  track: "foundations",
  order: 31,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-admission-control"],
  tags: ["backpressure", "bounded queue", "flow control", "producer throttle", "memory"],
  productionQuestion:
    "The consumer is slower than the producer and the queue is growing; where does backpressure belong?",
  learningDelta:
    "Backpressure propagates capacity signals upstream; bounded queues and producer throttling prevent unbounded memory and latency",
  objectives: [
    "Explain how an unbounded queue turns a throughput mismatch into a memory failure.",
    "Choose where the capacity signal should act: producer, queue, or consumer.",
    "Compare dropping, blocking, and throttling by what they protect and what they cost.",
    "Design a bounded buffer whose overflow behavior the product can explain.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

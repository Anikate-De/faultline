import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-admission-control",
  slug: "admission-control",
  title: "Admission Control: Bounded Queues and Priorities",
  track: "foundations",
  order: 30,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-load-shedding"],
  tags: ["admission control", "bounded queue", "priority", "deadline", "rejection"],
  productionQuestion:
    "The queue is 30 seconds deep and clients time out before service; what should the server do?",
  learningDelta:
    "Admission control keeps queues bounded and rejects or prioritizes work before latency becomes useless",
  objectives: [
    "Explain why an unbounded queue converts a load spike into a long outage.",
    "Choose a queue bound from the deadline rather than from memory.",
    "Design a priority and reservation policy that protects critical work.",
    "Distinguish total rejection from rejection of the critical class.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

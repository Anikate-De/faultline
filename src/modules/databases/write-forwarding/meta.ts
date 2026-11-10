import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-write-forwarding",
  slug: "write-forwarding",
  title: "Aurora Write Forwarding",
  track: "databases",
  order: 6,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["databases-aurora-global"],
  tags: ["write forwarding", "secondary cluster", "latency", "consistency", "writer"],
  productionQuestion:
    "A secondary-region app needs writes but must not send them to a stale local writer. What does write forwarding do?",
  learningDelta:
    "Write forwarding sends writes from a secondary cluster to the primary writer, adding latency and preserving a single writer",
  objectives: [
    "Trace a forwarded write from the secondary-region client through the primary writer and back.",
    "Explain why write forwarding adds latency but does not create a second writer.",
    "Predict when a forwarded write can time out after the primary has already committed it.",
    "Choose between forwarding, a direct primary connection, and a session consistency mode.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

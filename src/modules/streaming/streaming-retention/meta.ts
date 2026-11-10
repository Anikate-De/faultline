import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-retention",
  slug: "streaming-retention",
  title: "Retention and Replay",
  track: "streaming",
  order: 7,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["streaming-consumer-groups"],
  tags: ["retention", "segment", "replay", "deletion", "storage"],
  productionQuestion:
    "A consumer is down for two days and retention is 24 hours. What happens?",
  learningDelta:
    "Retention bounds replay; time and size limits delete segments, and a consumer beyond the window loses data",
  objectives: [
    "Explain how time and size retention delete whole log segments rather than individual records.",
    "Estimate the replay window from retention, segment size, and produce rate.",
    "Recognize when a consumer's committed offset is older than the earliest retained offset.",
    "Choose retention and replay capacity from a recovery-time objective and a storage budget.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

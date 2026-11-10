import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-write-amplification",
  slug: "write-amplification",
  title: "Write Amplification",
  track: "mongodb",
  order: 20,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mongodb-index-design"],
  tags: ["write amplification", "index", "journal", "replication", "document growth"],
  productionQuestion:
    "Write throughput drops and disk I/O is saturated. What is write amplification doing?",
  learningDelta:
    "Indexes, journaling, replication, and document growth multiply physical writes; more indexes can hurt write capacity",
  objectives: [
    "Break one logical write into its document, index, journal, and replication work.",
    "Predict how index count and document growth change physical I/O per write.",
    "Separate a disk-capacity problem from a CPU or network problem using write-path signals.",
    "Reduce write amplification without silently dropping the indexes reads depend on.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

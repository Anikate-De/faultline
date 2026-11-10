import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-vacuum-bloat",
  slug: "vacuum-bloat",
  title: "Vacuum and Bloat",
  track: "databases",
  order: 15,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-indexing"],
  tags: ["MVCC", "dead tuples", "vacuum", "autovacuum", "bloat", "wraparound"],
  productionQuestion: "A table grows despite deletes and queries slow down. What is bloat doing?",
  learningDelta:
    "PostgreSQL MVCC keeps dead tuples until vacuum; bloat increases I/O and can make plans worse, while aggressive vacuum competes for resources",
  objectives: [
    "Explain why DELETE and UPDATE leave dead tuples instead of reclaiming space immediately.",
    "Relate dead-tuple accumulation to update rate, vacuum frequency, and the oldest snapshot.",
    "Distinguish reusable space from disk that is returned to the operating system.",
    "Choose between tuning autovacuum, scheduling maintenance, and rewriting a table.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

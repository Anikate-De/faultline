import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-connection-leak",
  slug: "connection-leak",
  title: "Connection Leaks",
  track: "databases",
  order: 32,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["foundations-file-descriptors"],
  tags: ["connection leak", "pool", "timeout", "close", "stack trace"],
  productionQuestion: "The pool is exhausted but request rate is normal. Where did the connections go?",
  learningDelta:
    "A connection leak holds a session after an error path; pool metrics and stack traces reveal it, but only if timeouts and close paths are correct",
  objectives: [
    "Distinguish a connection leak from a capacity or traffic spike.",
    "Read pool metrics to find connections that never return.",
    "Locate the error path that skips close.",
    "Fix the close path and add detection that catches recurrence.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

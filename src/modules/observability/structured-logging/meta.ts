import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-structured-logging",
  slug: "structured-logging",
  title: "Structured Logging: Fields Over Sentences",
  track: "observability",
  order: 15,
  difficulty: 1,
  minutes: 14,
  prerequisites: ["foundations-use-red"],
  tags: ["structured logging", "JSON", "request ID", "correlation", "log levels"],
  productionQuestion:
    "You need every log line for one request across 20 tasks. What must the log schema contain?",
  learningDelta:
    "Structured fields, request IDs, and stable event names make logs searchable; prose logs do not",
  objectives: [
    "Identify the fields that let one request be reconstructed across tasks.",
    "Explain why JSON formatting without a correlation identifier is still unsearchable.",
    "Read query success, search latency, and volume as separate log-pipeline signals.",
    "Design a log event schema that survives service boundaries and deploys.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

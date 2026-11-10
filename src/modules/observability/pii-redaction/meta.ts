import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-pii-redaction",
  slug: "pii-redaction",
  title: "PII Redaction in Telemetry",
  track: "observability",
  order: 16,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["observability-structured-logging"],
  tags: ["PII", "redaction", "tokenization", "audit", "retention", "leak"],
  productionQuestion:
    "A debug log contains an email and a token. What is your containment plan?",
  learningDelta:
    "Redaction must happen at emit time and be verified; logs and traces are copies of production data with different retention",
  objectives: [
    "Trace how a sensitive field travels from a debug statement into retained telemetry.",
    "Choose an emit-time control that survives new fields and new services.",
    "Size the blast radius from leak rate, retention, and copy count.",
    "Run a containment sequence for a credential or personal data leak.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

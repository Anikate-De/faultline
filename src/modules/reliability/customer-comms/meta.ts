import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-customer-comms",
  slug: "customer-comms",
  title: "Customer Communication",
  track: "reliability",
  order: 25,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["reliability-roles"],
  tags: ["customer comms", "impact", "workaround", "update", "support"],
  productionQuestion:
    "Support is pasting raw incident channel messages to customers. What do you change?",
  learningDelta:
    "Customer comms need impact, workaround, and next update; internal details and speculation increase harm",
  objectives: [
    "Turn an internal incident state into a customer-facing message.",
    "Include impact, workaround, and next update time in every message.",
    "Remove internal names, hypotheses, and blame before publishing.",
    "Give support one approved statement and a route for follow-up questions.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

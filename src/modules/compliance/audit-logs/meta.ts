import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-audit-logs",
  slug: "audit-logs",
  title: "Audit Logs",
  track: "compliance",
  order: 5,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["observability-structured-logging"],
  tags: ["audit log", "actor", "action", "integrity", "retention"],
  productionQuestion:
    "An audit trail is missing the actor for a privileged change. What fields are required?",
  learningDelta:
    "Audit logs need actor, action, target, time, outcome, and source, with integrity and retention; they must exclude secrets",
  objectives: [
    "Specify the fields that make a privileged action attributable.",
    "Separate an audit record from an application debug log.",
    "Protect the audit trail with integrity, retention, and least privilege.",
    "Investigate a privileged change from the actor through the recorded outcome.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-audit-trails",
  slug: "audit-trails",
  title: "Audit Trails",
  track: "compliance",
  order: 15,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["compliance-audit-logs"],
  tags: ["audit trail", "control plane", "approval", "timestamp", "integrity"],
  productionQuestion:
    "An auditor asks for the change history of a production role. Can you reconstruct it?",
  learningDelta:
    "Audit trails combine control-plane logs, approvals, and change records with synchronized time and integrity",
  objectives: [
    "Reconstruct a privileged change across the control plane, approval system, and change record.",
    "Identify which fields make an event attributable and which make it orderable.",
    "Evaluate timestamp synchronization and log integrity as evidence properties.",
    "Explain why an archived log is not a defensible trail without scope and retention.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

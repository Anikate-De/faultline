import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-rollback-vs-rollforward",
  slug: "rollback-vs-rollforward",
  title: "Rollback vs Roll-Forward",
  track: "deployment",
  order: 11,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["deployment-automated-rollback"],
  tags: ["rollback", "roll-forward", "compatibility", "data", "decision"],
  productionQuestion:
    "A bad release is live and the database has new rows. Do you roll back or fix forward?",
  learningDelta:
    "Rollback restores known code but may be incompatible with new data; roll-forward is faster only when the fix is understood and tested",
  objectives: [
    "Compare rollback and roll-forward on code, data, and fix readiness.",
    "Explain why new-format rows can make a code rollback unsafe.",
    "Decide when an untested fix makes roll-forward the riskier path.",
    "Plan a safe path when neither option is clean.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

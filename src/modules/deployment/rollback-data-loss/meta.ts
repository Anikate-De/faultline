import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-rollback-data-loss",
  slug: "rollback-data-loss",
  title: "Rollback Data Loss",
  track: "deployment",
  order: 28,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["deployment-rollback-vs-rollforward"],
  tags: ["rollback", "side effect", "compensation", "migration", "irreversibility"],
  productionQuestion:
    "A rollback restores the old code but the new code sent emails. What is irreversible?",
  learningDelta:
    "Rollback restores software, not external side effects; migrations, messages, and third-party calls need compensating actions",
  objectives: [
    "Separate reversible software state from irreversible external effects.",
    "Identify writes, messages, and third-party calls that a rollback cannot undo.",
    "Design compensating actions for effects that already left the system.",
    "Bound the rollback window with drain, idempotency, and reconciliation.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

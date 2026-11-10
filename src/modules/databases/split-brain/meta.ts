import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-split-brain",
  slug: "split-brain",
  title: "Split Brain: Two Writers, One Truth",
  track: "databases",
  order: 12,
  difficulty: 4,
  minutes: 20,
  prerequisites: ["databases-failover-dns"],
  tags: ["split brain", "quorum", "fencing", "single writer", "reconciliation"],
  productionQuestion: "Two database nodes both accept writes during a network partition. How do you recover?",
  learningDelta:
    "Split brain requires fencing, quorum, or a single-writer design; reconciliation after divergence is expensive and sometimes impossible",
  objectives: [
    "Explain why a network partition lets both database nodes believe they are the writer.",
    "Compare quorum, a witness, and fencing, and name the failure each control does not cover.",
    "Estimate divergent writes from the dual-writer window and the write rate.",
    "Choose a recovery path when both sides already contain accepted writes.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

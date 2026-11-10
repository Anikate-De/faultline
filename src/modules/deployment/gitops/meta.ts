import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-gitops",
  slug: "gitops",
  title: "GitOps",
  track: "deployment",
  order: 15,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["deployment-config-drift"],
  tags: ["GitOps", "desired state", "drift", "reconciliation", "review"],
  productionQuestion:
    "A manual console change disappears on the next sync. Why?",
  learningDelta:
    "GitOps makes Git the desired state; drift reconciliation overwrites manual changes, which is safety and a trap",
  objectives: [
    "Explain desired state, reconciliation, and drift in a GitOps controller.",
    "Predict when a manual console change is reverted.",
    "Distinguish safe drift correction from an automated revert during an incident.",
    "Design an expedited Git path and a bounded reconciliation pause for emergencies.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

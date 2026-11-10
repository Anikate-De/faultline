import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-incident-deploy",
  slug: "incident-deploy",
  title: "Deploying During an Incident",
  track: "deployment",
  order: 22,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["deployment-rollback-vs-rollforward"],
  tags: ["incident", "deploy", "hypothesis", "rollback", "risk"],
  productionQuestion:
    "An incident is active and a fix is ready. Do you deploy now?",
  learningDelta:
    "Deploys during incidents add variables; prefer reversible config or flags, and deploy only with a clear hypothesis and rollback",
  objectives: [
    "Decide whether a change during an incident is diagnostic, mitigating, or both.",
    "Prefer reversible configuration or flag changes over a broad code deploy.",
    "State the hypothesis and expected signal before changing production.",
    "Bound the added variables with scope and a tested rollback.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

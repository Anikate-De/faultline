import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-policy-as-code",
  slug: "policy-as-code",
  title: "Policy as Code",
  track: "compliance",
  order: 20,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["compliance-access-controls"],
  tags: ["policy as code", "guardrails", "drift", "prevention", "evidence"],
  productionQuestion:
    "A production bucket is public despite a policy saying it must not be. How do you prevent it?",
  learningDelta:
    "Policy as code evaluates infrastructure before deploy and continuously detects drift; prevention is cheaper than audit findings",
  objectives: [
    "Turn a written control into an executable policy with an owner and a test.",
    "Place policy gates in the deploy path so a noncompliant resource cannot reach production.",
    "Detect drift and out-of-band changes that never pass through the pipeline.",
    "Manage exceptions and emergency changes without silently disabling the control.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-iam-deny",
  slug: "composite-iam-deny",
  title: "Composite: The IAM Change That Broke Production",
  track: "case-files",
  order: 26,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["cloud-networking-least-privilege"],
  tags: ["IAM", "deny", "policy change", "audit", "rollback"],
  productionQuestion:
    "Half the services fail with access denied after a policy update. What do you roll back first?",
  learningDelta:
    "IAM changes are global configuration with delayed effects; audit logs and policy diffs localize the blast radius faster than service debugging",
  objectives: [
    "Recognize an authorization failure that spans unrelated services.",
    "Use audit events and policy versions to localize a broad deny.",
    "Choose a rollback that restores access without widening permissions.",
    "Design a staged policy rollout with an explicit deny inventory.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

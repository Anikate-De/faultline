import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-confused-deputy",
  slug: "confused-deputy",
  title: "Confused Deputy",
  track: "cloud-networking",
  order: 23,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["cloud-networking-iam-roles"],
  tags: ["confused deputy", "trust policy", "external ID", "source ARN", "cross-account"],
  productionQuestion:
    "A cross-account role can be assumed by any account that knows its ARN. What condition fixes it?",
  learningDelta:
    "Confused-deputy protection uses source account, source ARN, or external ID conditions to bind trust to the intended caller",
  objectives: [
    "Explain why a role ARN is not a secret and why a broad trust policy is a confused-deputy risk.",
    "Choose the condition that matches the trust principal: external ID for a third party, source account or ARN for an AWS service.",
    "Detect unauthorized role assumptions and distinguish them from a condition that denies legitimate callers.",
    "Bind a trust policy to the intended caller without breaking the integration.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-iam-roles",
  slug: "iam-roles",
  title: "IAM Roles and Trust",
  track: "cloud-networking",
  order: 21,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-failure-domains"],
  tags: ["IAM role", "trust policy", "STS", "temporary credentials", "workload"],
  productionQuestion: "A service uses an access key in an environment variable. What replaces it?",
  learningDelta:
    "IAM roles use trust policies and temporary credentials; the workload assumes a role instead of storing keys",
  objectives: [
    "Separate a role's trust policy from its permission policy and explain what each one decides.",
    "Trace a workload credential from an instance profile or OIDC token through STS to a role session.",
    "Recognise an over-broad trust policy as an exposure even when the workload still works.",
    "Choose the smallest change that removes a static key without breaking the service.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

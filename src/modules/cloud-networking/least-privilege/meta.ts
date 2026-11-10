import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-least-privilege",
  slug: "least-privilege",
  title: "Least Privilege",
  track: "cloud-networking",
  order: 22,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["cloud-networking-iam-roles"],
  tags: ["least privilege", "scoped policy", "conditions", "observed access", "verification"],
  productionQuestion:
    "A task role has `*:*` and security wants it reduced. How do you find the real permissions?",
  learningDelta:
    "Least privilege starts from observed access, uses scoped resources and conditions, and is verified in a non-production environment",
  objectives: [
    "Read an identity policy by action, resource, and condition instead of by action name alone.",
    "Use observed access to shrink a broad role without blocking a production path.",
    "Separate a missing permission from a resource-scope or condition mismatch.",
    "Decide when a scoped policy is safe to ship and how to verify it before production.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

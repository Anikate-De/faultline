import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-static-keys",
  slug: "composite-static-keys",
  title: "Composite: The Static Key in the Build",
  track: "case-files",
  order: 43,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["cloud-networking-iam-roles"],
  tags: ["static keys", "build", "revocation", "workload identity", "least privilege"],
  productionQuestion:
    "A build log contains an access key and the key has broad permissions. What is the response?",
  learningDelta:
    "Static keys in build systems require revocation, scoping, rotation, and workload identity; logs are a distribution channel",
  objectives: [
    "Order containment and investigation when a credential is exposed.",
    "Use audit logs to establish blast radius before closing the incident.",
    "Replace long-lived keys with short-lived workload identity.",
    "Treat build logs and artifacts as credential distribution channels.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

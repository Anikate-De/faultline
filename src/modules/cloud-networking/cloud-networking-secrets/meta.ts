import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-secrets",
  slug: "cloud-networking-secrets",
  title: "Secrets Management",
  track: "cloud-networking",
  order: 26,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["containers-secrets"],
  tags: ["secrets", "rotation", "refresh", "restart", "SSM"],
  productionQuestion:
    "A database password is rotated and 30 services fail. How do you rotate safely?",
  learningDelta:
    "Secrets Manager or SSM can store and rotate secrets, but consumers must refresh or restart; rotation is a distributed deploy",
  objectives: [
    "Trace a secret from rotation to every consumer and its connection pool.",
    "Choose between runtime refresh and restart for a given consumer type.",
    "Recognize stale credentials after rotation from authentication failures that look like a database outage.",
    "Design a rotation that tolerates propagation delay and keeps a rollback path.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

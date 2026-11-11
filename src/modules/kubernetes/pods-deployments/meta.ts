import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-pods-deployments",
  slug: "pods-deployments",
  title: "Pods and Deployments",
  track: "kubernetes",
  order: 1,
  difficulty: 1,
  minutes: 16,
  prerequisites: ["foundations-failure-domains"],
  tags: ["pod", "deployment", "replicaset", "rollout", "readiness"],
  productionQuestion:
    "A Deployment says six replicas but only four pods are ready. Where do you look?",
  learningDelta:
    "A Deployment owns ReplicaSets and Pods; readiness, revision history, and rollout strategy decide whether a change is actually available",
  objectives: [
    "Trace the ownership chain from Deployment to ReplicaSet to Pod.",
    "Calculate how maxSurge and maxUnavailable change ready capacity during a rollout.",
    "Separate a running pod from a Ready pod that can receive traffic.",
    "Read rollout status and revision history when a change stops progressing.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

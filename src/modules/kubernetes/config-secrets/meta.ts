import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-config-secrets",
  slug: "config-secrets",
  title: "ConfigMaps and Secrets",
  track: "kubernetes",
  order: 11,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["kubernetes-pods-deployments"],
  tags: ["ConfigMap", "Secret", "env", "volume mount", "reload", "encryption"],
  productionQuestion: "A ConfigMap change did not reach the running app. Why?",
  learningDelta:
    "ConfigMaps and Secrets are injected at pod start; consumers must reload or roll pods, and Secret base64 is not encryption",
  objectives: [
    "Explain when a ConfigMap or Secret update reaches a running container.",
    "Choose between environment injection, volume mounts, and a rollout.",
    "Separate Secret encoding from encryption at rest.",
    "Recognize stale configuration before scaling or restarting blindly.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

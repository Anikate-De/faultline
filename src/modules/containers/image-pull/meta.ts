import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-image-pull",
  slug: "image-pull",
  title: "Image Pull and Registry Limits",
  track: "containers",
  order: 10,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["containers-fargate-cold-start"],
  tags: ["image pull", "layers", "cache", "registry", "throttle", "startup"],
  productionQuestion:
    "New tasks take 90 seconds to start and the registry is throttling. What do you change?",
  learningDelta:
    "Image size, layers, cache, and registry pull limits determine task startup; a large image multiplies cold-start cost",
  objectives: [
    "Explain how image size, layer count, and concurrent pulls affect time to ready.",
    "Predict when a shared registry budget will throttle a deployment.",
    "Distinguish registry throttling from application startup and health-check delay.",
    "Reduce startup time with smaller images, fewer layers, or a different pull strategy.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

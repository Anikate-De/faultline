import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-node-pressure",
  slug: "node-pressure",
  title: "Node Pressure and Eviction",
  track: "kubernetes",
  order: 13,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["kubernetes-requests-limits", "foundations-linux-memory"],
  tags: ["eviction", "node pressure", "QoS", "ephemeral storage", "thresholds"],
  productionQuestion: "Pods are evicted while CPU is low. Which node condition triggered it?",
  learningDelta:
    "Kubelet evicts on memory, disk, and PID pressure using QoS and thresholds; CPU pressure alone does not evict",
  objectives: [
    "Read node conditions and distinguish memory, disk, and PID pressure.",
    "Predict eviction order from QoS class, usage above requests, and priority.",
    "Recognize ephemeral storage as an eviction source even when memory is free.",
    "Protect a critical workload without overprovisioning the whole node.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

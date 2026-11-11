import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-requests-limits",
  slug: "requests-limits",
  title: "Requests, Limits, and QoS",
  track: "kubernetes",
  order: 4,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["kubernetes-pods-deployments"],
  tags: ["requests", "limits", "QoS", "throttling", "OOM"],
  productionQuestion: "A pod is OOMKilled while the node has free memory. Which limit mattered?",
  learningDelta:
    "Requests drive scheduling and QoS; limits drive throttling and OOM; they are different controls",
  objectives: [
    "Explain how CPU and memory requests influence scheduling.",
    "Distinguish CPU throttling from memory OOM termination.",
    "Identify the QoS class implied by requests and limits.",
    "Diagnose a pod killed by its cgroup limit despite node headroom.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

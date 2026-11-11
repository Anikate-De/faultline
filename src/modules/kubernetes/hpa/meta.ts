import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-hpa",
  slug: "hpa",
  title: "Horizontal Pod Autoscaling",
  track: "kubernetes",
  order: 7,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["kubernetes-requests-limits"],
  tags: ["HPA", "metrics server", "target utilization", "stabilization", "bottleneck"],
  productionQuestion:
    "HPA adds pods but p99 stays high. Which bottleneck is downstream?",
  learningDelta:
    "HPA scales on observed metrics and stabilization windows; scaling the wrong metric or a saturated dependency adds cost without relief",
  objectives: [
    "Predict replica count from the HPA target, the metric, and the maximum.",
    "Separate a workload that needs more pods from a dependency that needs more capacity.",
    "Recognize when the selected metric does not track the load the service receives.",
    "Explain why stabilizing and maximum settings change the time to recover.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

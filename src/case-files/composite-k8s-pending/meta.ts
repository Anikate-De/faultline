import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-k8s-pending",
  slug: "composite-k8s-pending",
  title: "Composite: The Pending Pods During a Surge",
  track: "case-files",
  order: 62,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["kubernetes-scheduling", "kubernetes-hpa"],
  tags: ["Kubernetes", "HPA", "pending", "scheduling", "capacity"],
  productionQuestion:
    "HPA adds pods but half stay Pending and latency keeps rising. What do you check?",
  learningDelta:
    "Autoscaling can create pods that scheduling cannot place; requests, taints, and topology are part of capacity",
  objectives: [
    "Read a Pending pod as a scheduler verdict rather than a metrics problem.",
    "Distinguish node utilization from the requests that determine placement.",
    "Unlock existing but ineligible capacity with a targeted toleration before adding replicas.",
    "Tie the HPA maximum to the capacity the scheduler can actually use.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

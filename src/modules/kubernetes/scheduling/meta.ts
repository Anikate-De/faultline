import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-scheduling",
  slug: "scheduling",
  title: "Scheduling and Pending Pods",
  track: "kubernetes",
  order: 6,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["kubernetes-requests-limits", "foundations-failure-domains"],
  tags: ["scheduler", "affinity", "taints", "tolerations", "topology", "pending"],
  productionQuestion:
    "The node has free CPU but the pod is Pending. Which constraint blocked it?",
  learningDelta:
    "Scheduling filters requests, affinity, taints, and topology; free capacity alone is not enough",
  objectives: [
    "Trace a Pending pod through the scheduler filters instead of reading cluster averages.",
    "Distinguish free CPU on a node from CPU the scheduler can actually use for this pod.",
    "Explain how taints, tolerations, and node affinity remove candidates before capacity is scored.",
    "Choose between relaxing a placement rule and adding capacity in the matching domain.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

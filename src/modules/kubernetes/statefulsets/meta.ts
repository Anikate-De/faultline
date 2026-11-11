import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-statefulsets",
  slug: "statefulsets",
  title: "StatefulSets and Stable Storage",
  track: "kubernetes",
  order: 10,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["kubernetes-pods-deployments"],
  tags: ["StatefulSet", "ordinal", "PVC", "headless service", "stable identity"],
  productionQuestion:
    "A StatefulSet pod is recreated with a new volume and loses data. What is misconfigured?",
  learningDelta:
    "StatefulSets provide ordinal identity and stable PVC binding; volumeClaimTemplates and a headless Service are part of the contract",
  objectives: [
    "Trace how a StatefulSet binds a persistent volume claim to a pod ordinal.",
    "Distinguish pod recreation from claim deletion as the cause of data loss.",
    "Explain the role of the headless Service in stable network identity.",
    "Choose a storage and deletion policy that survives rescheduling and scaling.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

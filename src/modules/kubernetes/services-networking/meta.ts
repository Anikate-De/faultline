import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-services-networking",
  slug: "services-networking",
  title: "Services and Endpoints",
  track: "kubernetes",
  order: 2,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["kubernetes-pods-deployments"],
  tags: ["service", "selector", "endpoints", "ClusterIP", "kube-proxy"],
  productionQuestion: "Pods are ready but the Service has no endpoints. Why?",
  learningDelta:
    "Services select pods by labels and expose a stable virtual IP; selector, readiness, and endpoints decide whether traffic reaches a pod",
  objectives: [
    "Trace how a Service selector becomes EndpointSlice membership.",
    "Distinguish a selector mismatch from a readiness failure.",
    "Explain the ClusterIP data path and the role of kube-proxy.",
    "Debug dropped Service traffic without changing pod IPs.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

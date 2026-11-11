import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-ingress",
  slug: "mesh-ingress",
  title: "Ingress Gateway",
  track: "mesh",
  order: 15,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mesh-mtls"],
  tags: ["ingress", "gateway", "TLS", "policy", "bypass"],
  productionQuestion:
    "External traffic bypasses mesh policy and reaches pods directly. What do you change?",
  learningDelta:
    "An ingress gateway provides a controlled entry point with TLS, routing, and policy; bypass paths defeat mTLS and observability",
  objectives: [
    "Explain what an ingress gateway adds at the mesh edge beyond a load balancer.",
    "Trace an external request through the gateway and identify a bypass path.",
    "Choose TLS and policy controls that cover every external entry point.",
    "Size gateway capacity for the traffic that actually reaches it.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

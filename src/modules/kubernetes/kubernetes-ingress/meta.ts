import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-ingress",
  slug: "kubernetes-ingress",
  title: "Ingress and Routing",
  track: "kubernetes",
  order: 3,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["kubernetes-services-networking"],
  tags: ["ingress", "ingress class", "host", "path", "TLS", "controller"],
  productionQuestion:
    "The Ingress works for one host and returns 404 for another. Where is the mismatch?",
  learningDelta:
    "Ingress is a set of host and path rules plus a controller; the object alone does not route traffic",
  objectives: [
    "Separate an Ingress object from the controller that implements it.",
    "Trace a request through host, path, and backend Service rules.",
    "Distinguish a 404 from a 503 at the ingress layer.",
    "Diagnose a host or path rule that points at the wrong backend.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

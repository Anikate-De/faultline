import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-envoy-clusters",
  slug: "envoy-clusters",
  title: "Envoy Clusters and Endpoints",
  track: "mesh",
  order: 2,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["mesh-envoy-listeners"],
  tags: ["Envoy", "cluster", "endpoint", "health", "outlier detection"],
  productionQuestion:
    "The mesh reports no healthy upstreams while pods are running. Which cluster view do you check?",
  learningDelta:
    "Envoy clusters group endpoints and health; outlier ejection and endpoint discovery determine usable capacity",
  objectives: [
    "Separate cluster membership from endpoint health and usable capacity.",
    "Explain how endpoint discovery, active health checks, and outlier ejection change the load-balancing set.",
    "Read the cluster signals that distinguish missing endpoints from ejected endpoints.",
    "Choose an ejection cap that protects capacity without hiding a failing dependency.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

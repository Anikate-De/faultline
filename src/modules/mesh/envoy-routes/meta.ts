import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-envoy-routes",
  slug: "envoy-routes",
  title: "Envoy Routes",
  track: "mesh",
  order: 3,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["mesh-envoy-listeners"],
  tags: ["route", "match", "header", "order", "weighted cluster"],
  productionQuestion:
    "A canary route works for one header but all traffic hits the stable version. Why?",
  learningDelta:
    "Routes match in order; host/path/header predicates and route order decide which cluster receives traffic",
  objectives: [
    "Explain how Envoy selects a virtual host and then the first matching route.",
    "Predict which cluster receives traffic when a broad route is placed before a specific route.",
    "Read a route table and a weighted-cluster split without confusing weight with match precedence.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

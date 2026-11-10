import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-envoy-listeners",
  slug: "envoy-listeners",
  title: "Envoy Listeners",
  track: "mesh",
  order: 1,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-l4-vs-l7"],
  tags: ["Envoy", "listener", "filter chain", "port", "route"],
  productionQuestion:
    "A request never reaches the service. Which Envoy listener should have accepted it?",
  learningDelta:
    "Envoy listeners bind addresses and ports and pass connections into filter chains and route configuration",
  objectives: [
    "Trace a connection through listener, filter chain, HTTP connection manager, route, and cluster.",
    "Distinguish a port with no listener from a listener whose filter chain does not match.",
    "Read listener-level evidence to decide whether a failure is below or above HTTP.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

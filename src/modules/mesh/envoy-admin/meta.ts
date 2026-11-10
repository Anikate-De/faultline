import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-envoy-admin",
  slug: "envoy-admin",
  title: "Envoy Admin and Stats",
  track: "mesh",
  order: 21,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["mesh-envoy-clusters"],
  tags: ["Envoy admin", "config dump", "stats", "clusters", "readiness"],
  productionQuestion: "A request fails and the app has no error. What does Envoy admin show?",
  learningDelta:
    "Envoy admin exposes config dump, clusters, stats, and readiness; it is the fastest way to see proxy-level state",
  objectives: [
    "Name the admin endpoint that answers a proxy-level question.",
    "Distinguish an application error from a request that never reached the application.",
    "Read cluster health and upstream failure counters without guessing.",
    "Use readiness and config dump to confirm what the proxy actually loaded.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-cloud-map",
  slug: "cloud-map",
  title: "Cloud Map",
  track: "containers",
  order: 17,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["containers-service-discovery"],
  tags: ["Cloud Map", "namespace", "service", "instance", "health", "TTL"],
  productionQuestion: "You need private DNS for 40 services. How does Cloud Map work?",
  learningDelta:
    "Cloud Map maintains namespaces and service instances; health checks and TTLs control resolution and failover",
  objectives: [
    "Describe the namespace, service, and instance hierarchy that Cloud Map maintains.",
    "Explain how a health check changes which instances answer a discovery query.",
    "Diagnose unhealthy instances that remain registered and receive traffic.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

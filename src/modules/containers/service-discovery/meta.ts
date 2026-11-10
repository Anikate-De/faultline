import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-service-discovery",
  slug: "service-discovery",
  title: "Service Discovery",
  track: "containers",
  order: 16,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["containers-services"],
  tags: ["service discovery", "DNS", "task IP", "TTL", "health"],
  productionQuestion:
    "A service calls another by IP and a task replacement breaks it. What do you use?",
  learningDelta:
    "Service discovery maps stable names to changing task IPs; DNS TTL and health determine failover",
  objectives: [
    "Explain how a stable DNS name resolves to changing task IPs.",
    "Predict when a cached record can outlive the task it points to.",
    "Choose a TTL and health-check strategy for a service that other services call.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-sidecar-patterns",
  slug: "sidecar-patterns",
  title: "Sidecar Patterns",
  track: "containers",
  order: 25,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["containers-cpu-memory-limits"],
  tags: ["sidecar", "shared resources", "startup order", "proxy", "logging"],
  productionQuestion:
    "A sidecar doubles task CPU and the service is throttled. What do you check?",
  learningDelta:
    "Sidecars share task resources; CPU/memory limits and startup order affect the main container",
  objectives: [
    "Budget sidecar CPU and memory inside the task size rather than beside it.",
    "Choose startup ordering and essential flags for proxy and log-router sidecars.",
    "Distinguish main-container CPU throttling from sidecar startup failures.",
    "Explain the blast radius of a sidecar that must stay alive with the application.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

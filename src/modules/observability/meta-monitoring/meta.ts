import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-meta-monitoring",
  slug: "meta-monitoring",
  title: "Monitoring the Monitor",
  track: "observability",
  order: 32,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-log-pipeline-backpressure"],
  tags: ["meta-monitoring", "staleness", "agent health", "ingestion lag", "dead man's switch"],
  productionQuestion:
    "All dashboards are green and no metrics have arrived for 20 minutes. What now?",
  learningDelta:
    "Meta-monitoring checks scrape health, agent liveness, ingestion lag, and alert delivery; absence of data is itself an alert",
  objectives: [
    "Detect a telemetry outage from coverage and staleness instead of from application health.",
    "Explain why an alert rule over an empty vector does not fire.",
    "Set a dead man window that bounds total-outage detection time.",
    "Design meta-monitoring that catches partial blind spots, not only total silence.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

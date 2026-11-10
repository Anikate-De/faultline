import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-observability-blind",
  slug: "composite-observability-blind",
  title: "Composite: The Monitoring Outage During an Incident",
  track: "case-files",
  order: 27,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["observability-meta-monitoring"],
  tags: ["monitoring", "no data", "staleness", "meta-monitoring", "incident"],
  productionQuestion:
    "Dashboards are green and empty while users report failures. What is the first check?",
  learningDelta:
    "Monitoring the monitor is part of incident response; no-data and stale-data states must be explicit and alarmed",
  objectives: [
    "Detect that a green dashboard is stale rather than healthy.",
    "Separate telemetry pipeline failure from service failure.",
    "Run an incident with independent signals when observability is degraded.",
    "Design no-data alerts and an out-of-band path for the next outage.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

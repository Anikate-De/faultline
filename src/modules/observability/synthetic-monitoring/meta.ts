import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-synthetic-monitoring",
  slug: "synthetic-monitoring",
  title: "Synthetic Monitoring: Probe the Path",
  track: "observability",
  order: 24,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-tls-handshake"],
  tags: ["synthetic", "probe", "region", "interval", "DNS", "TLS"],
  productionQuestion:
    "Users in one region cannot reach the app while your servers are healthy. What probes reveal it?",
  learningDelta:
    "Synthetic probes exercise the real path from multiple locations; interval and location coverage determine detection time",
  objectives: [
    "Read a synthetic check as a path from a location through DNS, TLS, and HTTP.",
    "Separate a green probe from proof that every user path is healthy.",
    "Compute detection time from interval and confirmation count.",
    "Choose probe coverage that finds a regional edge failure before users report it.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

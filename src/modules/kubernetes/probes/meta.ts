import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-probes",
  slug: "probes",
  title: "Liveness, Readiness, and Startup",
  track: "kubernetes",
  order: 5,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["kubernetes-pods-deployments"],
  tags: ["liveness", "readiness", "startup", "probe timing", "failure threshold"],
  productionQuestion:
    "A slow-starting app is killed before it can become ready. Which probe is wrong?",
  learningDelta:
    "Liveness restarts, readiness removes traffic, and startup protects boot; choosing the wrong probe turns a slow start into a restart loop",
  objectives: [
    "Separate the actions of liveness, readiness, and startup probes.",
    "Calculate the detection window from delay, period, and failure threshold.",
    "Protect a slow boot with a startup probe instead of a long liveness delay.",
    "Debug a restart loop without removing readiness from the traffic path.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-access-logs",
  slug: "access-logs",
  title: "Mesh Access Logs",
  track: "mesh",
  order: 12,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["mesh-envoy-routes"],
  tags: ["access log", "status", "upstream", "timing", "flags"],
  productionQuestion: "The app has no log for a failed request. Does the mesh?",
  learningDelta:
    "Access logs record proxy-level status, upstream, timing, and flags; they explain failures before the app sees them",
  objectives: [
    "Explain why a proxy access log can contain failures the application never logged.",
    "Read status, upstream host, duration, and response flags from one access-log line.",
    "Choose a sampling and filtering policy that keeps error evidence.",
    "Correlate a proxy request id with an application log when both exist.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

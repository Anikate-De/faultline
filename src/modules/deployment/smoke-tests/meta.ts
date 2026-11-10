import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-smoke-tests",
  slug: "smoke-tests",
  title: "Smoke Tests",
  track: "deployment",
  order: 10,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["deployment-canary"],
  tags: ["smoke test", "critical path", "dependency", "read/write", "rollback"],
  productionQuestion:
    "A new task starts and serves 200 on `/health` but 500 on checkout. What smoke test?",
  learningDelta:
    "Smoke tests exercise real dependencies and critical writes; health checks alone prove only process liveness",
  objectives: [
    "Separate a liveness check from a smoke test that proves a user path works.",
    "Design smoke tests that call real dependencies and read back writes.",
    "Explain why a green smoke suite can still miss a broken checkout path.",
    "Make smoke failure block promotion or trigger rollback.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

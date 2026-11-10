import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-timeouts",
  slug: "mesh-timeouts",
  title: "Mesh Timeouts",
  track: "mesh",
  order: 7,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["mesh-retries"],
  tags: ["timeout", "route timeout", "deadline", "504", "retry"],
  productionQuestion: "The proxy returns 504 before the service finishes. Which timeout won?",
  learningDelta:
    "Proxy timeout, route timeout, and application deadline are separate; the smallest wins and retries can stack",
  objectives: [
    "Identify which clock ends a request when route, per-try, and application deadlines differ.",
    "Explain why raising the route timeout can leave a 504 unchanged.",
    "Recognize a premature cut where the route had budget but a shorter clock fired.",
    "Bound total user wait when retries repeat a timed-out attempt.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

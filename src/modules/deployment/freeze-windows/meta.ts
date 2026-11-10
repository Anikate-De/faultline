import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-freeze-windows",
  slug: "freeze-windows",
  title: "Change Freezes",
  track: "deployment",
  order: 13,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["deployment-change-management"],
  tags: ["freeze", "exception", "change risk", "approval", "rollback"],
  productionQuestion:
    "A freeze is active and a critical fix is needed. What is the exception path?",
  learningDelta:
    "Freezes reduce change risk but concentrate it; exceptions need review, rollback plans, and a clear owner",
  objectives: [
    "Explain what a change freeze controls and what it moves rather than removes.",
    "Predict how freeze length and change volume concentrate risk at the thaw.",
    "Design an exception path with a bounded decision time, rollback plan, and owner.",
    "Recognize when a slow exception path makes bypass rational.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

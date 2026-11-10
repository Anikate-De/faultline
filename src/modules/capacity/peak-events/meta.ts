import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-peak-events",
  slug: "peak-events",
  title: "Peak Event Planning",
  track: "capacity",
  order: 16,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["capacity-capacity-models"],
  tags: ["peak event", "forecast", "pre-scale", "freeze", "staffing"],
  productionQuestion:
    "A marketing event will send 10× traffic in two weeks. What do you do now?",
  learningDelta:
    "Peak planning works backward from the event: forecast, load test, pre-scale, freeze changes, and staff the response",
  objectives: [
    "Work backward from an event date to the capacity and test milestones.",
    "Decide when pre-scaling is required instead of reactive scaling.",
    "Explain why a partial load test does not certify event capacity.",
    "Sequence the freeze, rollback, and staffing decisions around the event.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

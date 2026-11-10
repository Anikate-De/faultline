import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-decision-logs",
  slug: "decision-logs",
  title: "Decision Logs",
  track: "reliability",
  order: 27,
  difficulty: 1,
  minutes: 12,
  prerequisites: ["reliability-timeline"],
  tags: ["decision log", "rationale", "owner", "timestamp", "review"],
  productionQuestion:
    "The postmortem cannot explain why the team disabled the breaker. What was missing?",
  learningDelta:
    "Decision logs record options, rationale, owner, and time; they make incident reconstruction and review possible",
  objectives: [
    "Record the options considered, not only the action taken.",
    "Capture rationale, owner, and time while the decision is fresh.",
    "Use the log to reconstruct a risky action during review.",
    "Explain why a timeline alone cannot explain intent.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

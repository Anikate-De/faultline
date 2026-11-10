import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-chaos",
  slug: "chaos",
  title: "Chaos Engineering",
  track: "reliability",
  order: 14,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["reliability-game-days"],
  tags: ["chaos", "hypothesis", "blast radius", "stop condition", "experiment"],
  productionQuestion:
    "A dependency failure takes down the service despite redundancy. How do you find the gap before production?",
  learningDelta:
    "Chaos experiments test specific hypotheses with a bounded blast radius, stop conditions, and observability",
  objectives: [
    "Write a chaos hypothesis that names the steady state and the expected behavior.",
    "Bound a fault injection by blast radius, duration, and stop condition.",
    "Explain why observability is part of the experiment design, not an afterthought.",
    "Decide when to abort, roll back, and promote a finding into a fix.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

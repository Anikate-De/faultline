import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-traffic-shifting",
  slug: "traffic-shifting",
  title: "Traffic Shifting",
  track: "deployment",
  order: 12,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["deployment-canary"],
  tags: ["traffic shifting", "step", "gate", "exposure", "blast radius"],
  productionQuestion:
    "You need 1%, 5%, 25%, 100% with a gate at each step. How do you sequence it?",
  learningDelta:
    "Traffic shifting is a sequence of exposure steps with gates; step size trades detection time for blast radius",
  objectives: [
    "Sequence a rollout through exposure steps with a gate after each step.",
    "Calculate the blast radius of a step from traffic share and defect rate.",
    "Explain why a larger step improves sample size but exposes more users before a gate can act.",
    "Choose a step size and gate window that keep exposure inside an agreed budget.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

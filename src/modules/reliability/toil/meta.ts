import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-toil",
  slug: "toil",
  title: "Toil Reduction",
  track: "reliability",
  order: 28,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["reliability-oncall-handoff"],
  tags: ["toil", "automation", "measurement", "on-call", "capacity"],
  productionQuestion:
    "The team spends 40% of on-call on the same manual cleanup. How do you reduce it?",
  learningDelta:
    "Toil is repetitive, manual, and scalable work; measure it, automate the top tasks, and protect the time",
  objectives: [
    "Distinguish toil from necessary operational work and project work.",
    "Measure toil by task, frequency, time, and error risk.",
    "Automate the highest-value manual task before adding prevention work.",
    "Protect engineering capacity so cleanup does not consume prevention.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

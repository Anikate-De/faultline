import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-memory-leak",
  slug: "composite-memory-leak",
  title: "Composite: The Slow Memory Leak",
  track: "case-files",
  order: 50,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["containers-oom-kills"],
  tags: ["memory leak", "heap", "OOM", "restart", "trend"],
  productionQuestion: "Memory grows for days and the task restarts every 48 hours. What do you measure?",
  learningDelta:
    "Leak diagnosis compares heap over time and request volume; restarts hide the trend unless memory is graphed across restarts",
  objectives: [
    "Distinguish a leak from a working-set plateau or traffic growth.",
    "Use post-GC heap and request volume to estimate growth per unit of work.",
    "Capture evidence before a restart destroys the state.",
    "Design alerts and limits that expose a leak across restarts.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

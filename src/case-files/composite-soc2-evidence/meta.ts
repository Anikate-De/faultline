import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-soc2-evidence",
  slug: "composite-soc2-evidence",
  title: "Composite: The SOC 2 Evidence Scramble",
  track: "case-files",
  order: 46,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["compliance-evidence"],
  tags: ["SOC 2", "evidence", "automation", "ownership", "audit"],
  productionQuestion:
    "The audit starts and half the evidence is screenshots from last quarter. What should have existed?",
  learningDelta:
    "Evidence must be generated from operating systems continuously, with timestamps and ownership",
  objectives: [
    "Distinguish a control that operates from evidence that proves it operated.",
    "Replace point-in-time screenshots with system-generated evidence.",
    "Assign control ownership and an evidence freshness target.",
    "Prepare a gap response that is accurate rather than theatrical.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

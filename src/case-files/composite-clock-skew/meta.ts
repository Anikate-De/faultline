import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-clock-skew",
  slug: "composite-clock-skew",
  title: "Composite: The Timeline That Blamed the Wrong Deploy",
  track: "case-files",
  order: 37,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["observability-incident-timeline"],
  tags: ["clock skew", "timeline", "causality", "NTP", "deploy"],
  productionQuestion:
    "Logs, metrics, and deploy events disagree by minutes. How do you reconstruct causality?",
  learningDelta:
    "Clock skew and source ordering can invert cause and effect; timelines need source trust and time synchronization",
  objectives: [
    "Detect clock skew across logs, metrics, and deploy events.",
    "Reconstruct causality with traces and request identifiers instead of raw timestamps.",
    "Keep an incident timeline that records source and ingest time.",
    "Monitor time synchronization as a production dependency.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

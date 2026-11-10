import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-escalation",
  slug: "escalation",
  title: "Escalation",
  track: "reliability",
  order: 5,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["reliability-severity-levels"],
  tags: ["escalation", "trigger", "on-call", "backup", "authority"],
  productionQuestion:
    "The on-call engineer is stuck and 30 minutes pass before backup is called. How do you escalate sooner?",
  learningDelta:
    "Escalation paths and triggers remove the social cost of asking; time-based and impact-based triggers work together",
  objectives: [
    "Distinguish a time-based escalation trigger from an impact-based one.",
    "Explain why explicit authority shortens time to backup.",
    "Design an escalation path that names who is called, when, and with what context.",
    "Recognize over-escalation and false pages as costs, not free insurance.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

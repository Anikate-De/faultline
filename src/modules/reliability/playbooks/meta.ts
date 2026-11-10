import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-playbooks",
  slug: "playbooks",
  title: "Playbooks vs Runbooks",
  track: "reliability",
  order: 7,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["reliability-incident-command"],
  tags: ["runbook", "playbook", "decision", "unknown", "framework"],
  productionQuestion:
    "A novel incident has no runbook. What playbook applies?",
  learningDelta:
    "Runbooks handle known alerts; playbooks give decision frameworks for unknown failures",
  objectives: [
    "Distinguish a runbook for a known alert from a playbook for an unknown failure.",
    "Apply a decision framework that bounds scope before committing to a cause.",
    "Recognize how a playbook becomes a rigid script and misses context.",
    "Choose the next discriminating test instead of the most familiar one.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

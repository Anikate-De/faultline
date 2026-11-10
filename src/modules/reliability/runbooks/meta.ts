import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-runbooks",
  slug: "runbooks",
  title: "Runbooks",
  track: "reliability",
  order: 6,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["reliability-playbooks"],
  tags: ["runbook", "check", "action", "escalation", "verification"],
  productionQuestion:
    "The same alert is handled differently by each engineer. What do you standardize?",
  learningDelta:
    "A runbook gives ordered checks, expected signals, safe actions, and escalation points for one alert",
  objectives: [
    "Identify the five parts of a runbook that make it safe to execute under pressure.",
    "Explain why an untested topology assumption turns a routine step into a harmful action.",
    "Distinguish a runbook for a known alert from a playbook for an unknown failure.",
    "Design verification and escalation points that stop a failed action from cascading.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

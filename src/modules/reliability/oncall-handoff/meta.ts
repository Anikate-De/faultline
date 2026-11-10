import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-oncall-handoff",
  slug: "oncall-handoff",
  title: "On-Call Handoff",
  track: "reliability",
  order: 11,
  difficulty: 1,
  minutes: 12,
  prerequisites: ["reliability-runbooks"],
  tags: ["handoff", "context", "active incident", "change", "risk"],
  productionQuestion:
    "A new shift starts and immediately asks what changed. What belongs in the handoff?",
  learningDelta:
    "A handoff covers active incidents, recent changes, risky deploys, expiring certificates, and known gaps",
  objectives: [
    "Name the five kinds of context a shift handoff must transfer.",
    "Explain why an unowned risk survives a handoff that lists it.",
    "Distinguish a status summary from an operational handoff.",
    "Design a handoff that makes the next action and owner explicit.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

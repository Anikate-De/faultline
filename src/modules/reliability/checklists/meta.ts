import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-checklists",
  slug: "checklists",
  title: "Incident Checklists",
  track: "reliability",
  order: 8,
  difficulty: 1,
  minutes: 12,
  prerequisites: ["reliability-playbooks"],
  tags: ["checklist", "omission", "verification", "stress", "procedure"],
  productionQuestion:
    "During a failover the team forgets to disable the retry storm. What prevents that?",
  learningDelta:
    "Checklists reduce omission under stress; they must be short, ordered, and tied to verification",
  objectives: [
    "Explain why a short, ordered checklist beats a long procedure under stress.",
    "Identify the steps whose omission creates a second outage rather than a delay.",
    "Design read-back verification that proves a step happened.",
    "Recognize when checklist length itself increases the chance of omission.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

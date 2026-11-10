import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-severity-levels",
  slug: "severity-levels",
  title: "Severity Levels",
  track: "reliability",
  order: 4,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["reliability-incident-command"],
  tags: ["severity", "impact", "paging", "escalation", "criteria"],
  productionQuestion:
    "One team calls an outage SEV1 and another calls the same thing SEV3. Why does it matter?",
  learningDelta:
    "Severity drives paging, communication, and authority; criteria must be based on user impact and scope, not on cause",
  objectives: [
    "Classify severity from user impact and scope rather than from the technical cause.",
    "Explain how severity changes paging, communication cadence, and decision authority.",
    "Recognize the cost of under-classification and the cost of over-classification.",
    "Re-evaluate severity as scope becomes clearer during the incident.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

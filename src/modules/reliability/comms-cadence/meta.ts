import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-comms-cadence",
  slug: "comms-cadence",
  title: "Communication Cadence",
  track: "reliability",
  order: 3,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["reliability-roles"],
  tags: ["cadence", "internal comms", "external comms", "update", "stakeholder"],
  productionQuestion:
    "The incident channel is silent for 40 minutes and support invents updates. What cadence?",
  learningDelta:
    "Regular updates at a fixed cadence reduce uncertainty; internal and external audiences need different detail",
  objectives: [
    "Explain why an update cadence is a commitment, not a best effort.",
    "Separate internal incident detail from customer-facing impact and workaround.",
    "Recognize the cost of both silence and over-communication.",
    "Write an update that states what is known, what is not, and when the next one arrives.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

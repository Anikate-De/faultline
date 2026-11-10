import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-legal",
  slug: "legal",
  title: "Legal and Compliance During Incidents",
  track: "reliability",
  order: 26,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["reliability-customer-comms"],
  tags: ["legal", "privacy", "notification", "counsel", "deadline"],
  productionQuestion:
    "A breach may have exposed customer data. Who decides notification?",
  learningDelta:
    "Incident response must include legal and privacy counsel when data, contracts, or regulated data may be affected; deadlines start early",
  objectives: [
    "Decide when an incident needs legal and privacy counsel in the response.",
    "Preserve evidence and control disclosure while the technical response continues.",
    "Track notification obligations from first awareness rather than confirmed root cause.",
    "Explain why the legal workstream runs in parallel with mitigation, not after it.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

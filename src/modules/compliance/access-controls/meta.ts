import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-access-controls",
  slug: "access-controls",
  title: "Access Controls",
  track: "compliance",
  order: 4,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["cloud-networking-least-privilege"],
  tags: ["access control", "least privilege", "separation of duties", "review", "evidence"],
  productionQuestion:
    "An auditor asks who can read production data. Can you answer in minutes?",
  learningDelta:
    "Access control evidence requires identity, role, approval, and review; shared accounts and standing admin rights break the story",
  objectives: [
    "Answer an access question from a system of record instead of reconstructing it from screenshots.",
    "Distinguish least privilege, separation of duties, and review evidence.",
    "Find the access patterns that make attribution impossible.",
    "Design a review cycle that produces current evidence without slowing delivery.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

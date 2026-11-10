import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-subprocessors",
  slug: "subprocessors",
  title: "Subprocessor Management",
  track: "compliance",
  order: 18,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["compliance-vendor-risk"],
  tags: ["subprocessor", "notice", "flow-down", "inventory", "residency"],
  productionQuestion:
    "A vendor adds a subprocessor in another region and your residency promise breaks. How do you prevent it?",
  learningDelta:
    "Subprocessor obligations require notice, approval, flow-down terms, and a maintained inventory",
  objectives: [
    "Explain how a subprocessor differs from the direct vendor and why the chain changes the risk.",
    "Design notice and approval gates that treat a new subprocessor as a material change.",
    "Check whether equivalent security, breach, deletion, and residency terms actually flow down.",
    "Keep an inventory that can answer where regulated data is processed at any time.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

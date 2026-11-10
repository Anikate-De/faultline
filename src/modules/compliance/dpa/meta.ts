import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "compliance-dpa",
  slug: "dpa",
  title: "Data Processing Agreements",
  track: "compliance",
  order: 9,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["compliance-baa"],
  tags: ["DPA", "processor", "controller", "subprocessor", "breach notice"],
  productionQuestion:
    "A new SaaS tool will process customer data. What must be agreed before rollout?",
  learningDelta:
    "A DPA defines processor scope, security, subprocessors, breach notice, and deletion; it is a prerequisite, not paperwork after launch",
  objectives: [
    "Separate the controller's decisions from the processor's obligations in a vendor relationship.",
    "Check whether a DPA covers the legal entity, the specific service, and the data being sent.",
    "Design an onboarding gate that requires an approved agreement and disclosed subprocessors.",
    "Produce evidence that the agreement is operational rather than a signed document in a folder.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

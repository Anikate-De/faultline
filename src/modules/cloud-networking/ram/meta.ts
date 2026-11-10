import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-ram",
  slug: "ram",
  title: "Resource Access Manager",
  track: "cloud-networking",
  order: 11,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["cloud-networking-cross-account"],
  tags: ["RAM", "share", "participant", "owner", "quota"],
  productionQuestion:
    "You need one Transit Gateway for four accounts. How do you share it?",
  learningDelta:
    "RAM shares supported resources; consumers attach but ownership, quotas, and route policy stay with the owner",
  objectives: [
    "Create a resource share for a transit gateway and distinguish the owner's controls from the participant's.",
    "Explain why a participant VPC attachment can be created but remain unusable.",
    "Diagnose an attachment that is rejected because the gateway's attachment capacity is exhausted.",
    "Recognize the difference between an over-broad share and an attachment that never completes.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

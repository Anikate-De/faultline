import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-peering-vs-tgw",
  slug: "peering-vs-tgw",
  title: "VPC Peering vs Transit Gateway",
  track: "cloud-networking",
  order: 8,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["cloud-networking-route-tables"],
  tags: ["peering", "Transit Gateway", "hub", "attachment", "non-transitive"],
  productionQuestion:
    "Ten VPCs need full connectivity. Do you mesh peering or use a transit gateway?",
  learningDelta:
    "Peering is pairwise and non-transitive; Transit Gateway is a hub with attachments, route tables, and centralized policy",
  objectives: [
    "Calculate the number of peering connections a full mesh needs and explain why the count grows quadratically.",
    "Show why a chain of peering connections does not give every VPC a path to every other VPC.",
    "Compare peering and Transit Gateway on attachment model, route ownership, and segmentation.",
    "Choose a topology from VPC count, operational ownership, and the need for centralized routing.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

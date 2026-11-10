import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-subnets",
  slug: "subnets",
  title: "Subnets and Route Tables",
  track: "cloud-networking",
  order: 2,
  difficulty: 1,
  minutes: 16,
  prerequisites: ["cloud-networking-vpc"],
  tags: ["subnet", "route table", "prefix", "target", "internet"],
  productionQuestion:
    "A new subnet has instances but no internet access. Which route is missing?",
  learningDelta:
    "A subnet is associated with one route table; the longest prefix match and target determine where traffic goes",
  objectives: [
    "Explain how a subnet's route table association decides which routes the subnet can use.",
    "Read a route table by destination, target, and state instead of by route count.",
    "Predict which route wins when a more specific prefix shadows a default route.",
    "Distinguish a missing association, a missing default route, and a blackhole target.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

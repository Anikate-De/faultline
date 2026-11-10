import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-anycast",
  slug: "anycast",
  title: "Anycast: Same IP, Many Places",
  track: "traffic",
  order: 15,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["traffic-route53-routing"],
  tags: ["anycast", "BGP", "PoP", "routing", "DDoS", "asymmetry"],
  productionQuestion:
    "Users worldwide hit one IP but land in different regions. How does that work, and what breaks?",
  learningDelta:
    "Anycast advertises the same prefix from many sites; BGP chooses a path, so routing changes can shift traffic and create asymmetric failures",
  objectives: [
    "Explain how the same anycast address can be served from multiple locations without a global load balancer.",
    "Predict how a BGP path change redistributes traffic across points of presence.",
    "Diagnose an overloaded PoP after a routing change and choose a capacity or steering response.",
    "Distinguish ingress concentration from return-path asymmetry.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

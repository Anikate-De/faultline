import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-cloudflare-backbone-2020",
  slug: "cloudflare-backbone-2020",
  title: "Cloudflare 2020: A Backbone Change With Global Reach",
  track: "case-files",
  order: 6,
  difficulty: 4,
  minutes: 24,
  prerequisites: ["traffic-anycast"],
  tags: ["anycast", "backbone", "BGP", "capacity", "validation"],
  productionQuestion:
    "A network change is supposed to affect one path and slows traffic everywhere. How do you verify before commit?",
  learningDelta:
    "Anycast and backbone changes have nonlocal effects; capacity and path validation must happen before global rollout",
  objectives: [
    "Explain how a one-line policy change can move traffic for an entire backbone.",
    "Distinguish a routing-path failure from a capacity failure when PoPs are overloaded.",
    "Choose a first mitigation that removes a leaking node instead of adding capacity.",
    "Design protocol-level guardrails for backbone BGP sessions.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

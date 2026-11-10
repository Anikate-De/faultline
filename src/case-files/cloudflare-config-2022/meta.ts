import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-cloudflare-config-2022",
  slug: "cloudflare-config-2022",
  title: "Cloudflare 2022: Network Configuration and the Long Tail",
  track: "case-files",
  order: 7,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["traffic-route53-routing"],
  tags: ["network config", "policy", "regional impact", "subset", "rollback"],
  productionQuestion:
    "Most users are fine and one region is failing after a network policy change. How do you find the subset?",
  learningDelta:
    "Global configuration changes fail unevenly; per-region and per-route signals expose the subset that the aggregate hides",
  objectives: [
    "Trace a policy term reorder to withdrawn prefixes and a multi-location outage.",
    "Explain why 4% of locations can carry 50% of requests.",
    "Use per-PoP and control-plane signals to locate the affected subset.",
    "Coordinate concurrent rollbacks so recovery does not undo itself.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

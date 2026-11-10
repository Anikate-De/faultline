import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-cloudflare-waf-2019",
  slug: "cloudflare-waf-2019",
  title: "Cloudflare 2019: One Regex, Global CPU Exhaustion",
  track: "case-files",
  order: 5,
  difficulty: 4,
  minutes: 24,
  prerequisites: ["traffic-waf-rate-limits"],
  tags: ["WAF", "regex", "CPU exhaustion", "config rollout", "rollback"],
  productionQuestion:
    "A WAF rule passes review and then takes down every edge. How do you bound a global config change?",
  learningDelta:
    "Configuration is code with global blast radius; staged rollout, resource limits, and fast rollback are the controls",
  objectives: [
    "Trace how a syntactically valid WAF rule exhausted HTTP-serving CPU worldwide.",
    "Separate the trigger (a regex) from the process gaps that let it reach every PoP at once.",
    "Choose between a component kill switch and a configuration rollback during a global outage.",
    "Design a rule rollout that bounds CPU risk without blocking emergency protection.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

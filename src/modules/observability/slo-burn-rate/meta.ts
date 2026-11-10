import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-slo-burn-rate",
  slug: "slo-burn-rate",
  title: "SLO Burn Rate: Alert on Speed, Not Just State",
  track: "observability",
  order: 19,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-sli-slo-error-budget"],
  tags: ["burn rate", "multi-window", "fast burn", "slow burn", "error budget"],
  productionQuestion:
    "The 30-day SLO is still 99.9%, but the service has been failing for 40 minutes. Should you page?",
  learningDelta:
    "Multi-window burn-rate alerts catch fast burns early and slow burns reliably without paging on every blip",
  objectives: [
    "Compute burn rate from bad-event rate and the SLO allowance.",
    "Explain why a short window confirms speed while a long window proves persistence.",
    "Recognize a burn that a static error-rate alert cannot see.",
    "Choose window lengths and a page threshold that fit the error budget.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

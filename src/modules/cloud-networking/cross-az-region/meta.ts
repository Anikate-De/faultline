import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-cross-az-region",
  slug: "cross-az-region",
  title: "Cross-AZ and Cross-Region Latency",
  track: "cloud-networking",
  order: 20,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["cloud-networking-vpc"],
  tags: ["cross-AZ", "cross-region", "latency", "cost", "chatty"],
  productionQuestion:
    "A service is 30ms slower after moving a dependency to another AZ. Is that expected?",
  learningDelta:
    "Cross-AZ adds a small latency and transfer cost; cross-region adds much more, and chatty protocols multiply both",
  objectives: [
    "Estimate added latency from placement and the number of serial round trips.",
    "Explain why a chatty protocol turns a small per-hop delay into an SLO breach.",
    "Compare cross-AZ and cross-region transfer cost without treating either as free.",
    "Choose a placement that balances failure isolation, latency, and cost.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

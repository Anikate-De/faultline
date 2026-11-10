import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-cross-az-cost",
  slug: "cross-az-cost",
  title: "Cross-AZ Latency and Cost",
  track: "databases",
  order: 24,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["databases-multi-az-vs-region"],
  tags: ["cross-AZ", "data transfer", "latency", "reader placement", "cost"],
  productionQuestion:
    "The database bill includes a large cross-AZ transfer line. Why is the app talking across zones?",
  learningDelta:
    "Cross-AZ traffic adds latency and cost; reader placement, chatty queries, and retry loops multiply it",
  objectives: [
    "Trace which application call paths cross an AZ boundary.",
    "Quantify cross-AZ transfer from request rate, round trips, and payload.",
    "Reduce cross-AZ cost without sending every read to the writer.",
    "Explain why the transfer bill can grow faster than request volume.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

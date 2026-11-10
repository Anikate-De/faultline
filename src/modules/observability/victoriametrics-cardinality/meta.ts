import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-victoriametrics-cardinality",
  slug: "victoriametrics-cardinality",
  title: "VictoriaMetrics and High Cardinality",
  track: "observability",
  order: 10,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["observability-victoriametrics-architecture"],
  tags: ["cardinality", "series", "label", "index", "memory", "query"],
  productionQuestion:
    "A label with request IDs makes the series count explode. What happens to memory and query time?",
  learningDelta:
    "Series cardinality drives index and memory cost; high-cardinality labels belong in logs or traces, not metric labels",
  objectives: [
    "Estimate active series from metric names, hosts, and label values.",
    "Explain how a high-cardinality label raises index memory and query time.",
    "Distinguish series cardinality from sample volume and retention.",
    "Move an identifier-level question out of metrics without losing the answer.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

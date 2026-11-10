import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-victoriametrics-architecture",
  slug: "victoriametrics-architecture",
  title: "VictoriaMetrics Architecture: Ingest, Store, Query",
  track: "observability",
  order: 9,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-linux-disk-io"],
  tags: ["VictoriaMetrics", "vminsert", "vmstorage", "vmselect", "replication"],
  productionQuestion:
    "Metrics arrive late and queries time out during a rollout. Which VictoriaMetrics component is the bottleneck?",
  learningDelta:
    "vminsert, vmstorage, and vmselect have separate scaling limits; ingestion, storage, and query pressure must be diagnosed separately",
  objectives: [
    "Map a VictoriaMetrics cluster symptom to vminsert, vmstorage, or vmselect.",
    "Separate ingestion pressure from query pressure using component-level signals.",
    "Explain why adding storage nodes does not fix a query fan-out bottleneck.",
    "Choose the component to scale and state the tradeoff of that choice.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

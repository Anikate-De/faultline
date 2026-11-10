import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-read-replica-cold",
  slug: "read-replica-cold",
  title: "Cold Read Replicas",
  track: "databases",
  order: 30,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-read-replica-routing"],
  tags: ["cold cache", "replay", "read routing", "warmup", "lag"],
  productionQuestion: "You add a read replica during an incident and it makes latency worse. Why?",
  learningDelta:
    "A new replica must catch up and warm its cache; reads routed too early hit cold storage and increase lag",
  objectives: [
    "Explain what a new replica must do before it serves reads safely.",
    "Relate cache warmth and replay progress to read latency.",
    "Sequence read routing after catch-up and warmup.",
    "Predict when adding a replica makes an incident worse.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

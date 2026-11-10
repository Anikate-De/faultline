import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-schema-registry",
  slug: "schema-registry",
  title: "Schema Registry and Compatibility",
  track: "streaming",
  order: 18,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["streaming-keys-ordering"],
  tags: ["schema registry", "compatibility", "Avro", "evolution", "deploy order"],
  productionQuestion:
    "A producer adds a required field and old consumers crash. What compatibility mode?",
  learningDelta:
    "Schema compatibility modes govern evolution; backward, forward, and full compatibility have different deploy orders",
  objectives: [
    "Distinguish backward, forward, and full compatibility by who can read which data.",
    "Predict which schema changes a compatibility mode will reject.",
    "Choose a deploy order for producers and consumers from the compatibility direction.",
    "Design an evolution that keeps old and new consumers working during rollout.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

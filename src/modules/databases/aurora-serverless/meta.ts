import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-aurora-serverless",
  slug: "aurora-serverless",
  title: "Aurora Serverless Scaling",
  track: "databases",
  order: 25,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["databases-rds-aurora-arch"],
  tags: ["Aurora Serverless", "ACU", "cold start", "min capacity", "scaling"],
  productionQuestion: "A serverless database is slow after idle periods. What is happening?",
  learningDelta:
    "Aurora Serverless scales capacity in units and may need to resume; pooling, min capacity, and warm traffic change the experience",
  objectives: [
    "Explain Aurora capacity units and the difference between a resumed and a warm cluster.",
    "Relate minimum capacity and pool warmth to cold-start latency.",
    "Predict when scale-up lags a traffic ramp.",
    "Choose a capacity floor from the latency SLO and the idle pattern.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

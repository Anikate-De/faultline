import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-consumer-lag",
  slug: "consumer-lag",
  title: "Consumer Lag: The Real SLO",
  track: "streaming",
  order: 11,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["streaming-consumer-groups"],
  tags: ["consumer lag", "catch-up time", "production rate", "processing rate", "SLO"],
  productionQuestion:
    "Consumer lag is 2 million messages. Is that bad?",
  learningDelta:
    "Lag must be interpreted with production rate and processing rate; time-to-catch-up is the user-facing signal",
  objectives: [
    "Distinguish lag count, lag age, and time-to-catch-up as different signals.",
    "Compute net drain from production rate and consumer capacity.",
    "Explain why a large lag can be healthy and a small lag can be permanent.",
    "Choose a lag alert and a scaling action from a freshness objective.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

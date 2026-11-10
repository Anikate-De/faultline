import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-aws-kinesis-2020",
  slug: "aws-kinesis-2020",
  title: "Kinesis us-east-1: Capacity Under a Regional Surge",
  track: "case-files",
  order: 2,
  difficulty: 4,
  minutes: 24,
  prerequisites: ["streaming-backpressure"],
  tags: ["managed limits", "throttling", "dependency", "backpressure", "blast radius"],
  productionQuestion:
    "A managed stream is throttling and every dependent service is failing. What is your first move?",
  learningDelta:
    "Managed-service limits are still capacity limits; dependent teams need isolation and backpressure before the service recovers",
  objectives: [
    "Trace how a front-end fleet capacity change exhausted an operating-system thread limit.",
    "Separate the trigger from the root cause while dependent services are failing.",
    "Sequence a slow front-end restart to avoid cold-start contention.",
    "Design dependent services to fail open when a best-effort stream is unavailable.",
    "Distinguish managed-service capacity from unlimited capacity.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

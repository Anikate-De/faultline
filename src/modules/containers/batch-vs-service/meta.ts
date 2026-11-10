import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-batch-vs-service",
  slug: "batch-vs-service",
  title: "Batch vs Service",
  track: "containers",
  order: 24,
  difficulty: 1,
  minutes: 14,
  prerequisites: ["containers-services"],
  tags: ["service", "batch", "run task", "retry", "completion"],
  productionQuestion:
    "A nightly job runs as a service and restarts forever. What should it be?",
  learningDelta:
    "Services maintain desired count; batch jobs run to completion and retry differently, with different observability",
  objectives: [
    "Match a workload to an ECS service, a standalone scheduled task, or an AWS Batch job.",
    "Explain why a service restarts a finite job after a successful exit.",
    "Design retries and completion signals for a nightly job without duplicate side effects.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-coordinated-omission",
  slug: "coordinated-omission",
  title: "Coordinated Omission: The Metric That Lies",
  track: "foundations",
  order: 5,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-percentiles"],
  tags: ["coordinated omission", "open-loop load", "closed-loop load", "measurement bias", "latency correction"],
  productionQuestion:
    "Your load test reports p99 120ms but users report 4s stalls. What is wrong with the measurement?",
  learningDelta:
    "Closed-loop generators stop issuing requests during a stall, so slow samples are omitted; latency must be measured against intended arrival time",
  objectives: [
    "Explain how a closed-loop generator omits the requests it failed to send.",
    "Compare reported and intended-arrival latency for the same stall.",
    "Recognize coordinated omission in a load-test result or a metrics pipeline.",
    "Design a load test whose arrival rate and latency correction survive a stall.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

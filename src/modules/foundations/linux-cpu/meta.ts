import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-linux-cpu",
  slug: "linux-cpu",
  title: "Linux CPU Saturation: Run Queue and Steal",
  track: "foundations",
  order: 17,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-littles-law"],
  tags: ["run queue", "load average", "steal", "iowait", "CFS", "throttling"],
  productionQuestion:
    "CPU is at 60% but latency is high; is the host actually saturated?",
  learningDelta:
    "Run-queue length, steal time, and per-core saturation reveal CPU pressure that a smoothed utilization average hides",
  objectives: [
    "Distinguish guest CPU utilization from available CPU capacity.",
    "Read run queue, load average, steal, and iowait without conflating them.",
    "Explain why a host at moderate CPU can still queue requests.",
    "Choose between adding vCPUs, moving the workload, or reducing concurrency.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

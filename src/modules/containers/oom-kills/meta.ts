import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-oom-kills",
  slug: "oom-kills",
  title: "OOM Kills",
  track: "containers",
  order: 19,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["containers-cpu-memory-limits"],
  tags: ["OOM", "exit 137", "SIGKILL", "memory", "stop reason", "throttling"],
  productionQuestion:
    "A task restarts with exit code 137. Was it CPU throttling or memory?",
  learningDelta:
    "Exit 137 is SIGKILL; OOM kills leave a stop reason and memory metrics, while CPU throttling does not kill",
  objectives: [
    "Separate an OOM kill from CPU throttling using exit code, stop reason, and the memory curve.",
    "Calculate how long a memory trend has before it reaches the task limit.",
    "Fix the workload or the limit without hiding the trend behind restarts.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

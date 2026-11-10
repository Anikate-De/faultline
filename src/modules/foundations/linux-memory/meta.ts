import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-linux-memory",
  slug: "linux-memory",
  title: "Linux Memory: Page Cache, RSS, and OOM",
  track: "foundations",
  order: 18,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-linux-cpu"],
  tags: ["RSS", "page cache", "swap", "cgroup limit", "OOM score", "memory pressure"],
  productionQuestion:
    "The host reports 90% memory used but nothing is swapping; is it about to OOM?",
  learningDelta:
    "Page cache is reclaimable; anonymous memory, kernel memory, and cgroup limits decide OOM behavior",
  objectives: [
    "Separate anonymous memory from reclaimable page cache.",
    "Read a cgroup limit, usage, and pressure signal together.",
    "Predict when the kernel reclaims and when the OOM killer runs.",
    "Choose between reducing the working set and raising the limit.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

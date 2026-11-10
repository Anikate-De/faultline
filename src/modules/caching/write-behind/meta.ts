import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-write-behind",
  slug: "write-behind",
  title: "Write-Behind: Speed With a Data-Loss Window",
  track: "caching",
  order: 20,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["caching-aside-vs-write-through"],
  tags: ["write-behind", "async write", "loss window", "ordering", "durability"],
  productionQuestion: "Write-behind makes writes 10× faster, but the cache crashes. What is lost?",
  learningDelta:
    "Write-behind acknowledges before durable storage, creating a loss window and ordering complexity",
  objectives: [
    "Quantify the loss window from write rate and flush delay.",
    "Explain why cache persistence does not automatically make an acknowledged write durable.",
    "Identify ordering and read-your-writes hazards in concurrent flushes.",
    "Decide which data classes can accept asynchronous durability and which cannot.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

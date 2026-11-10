import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-github-2018",
  slug: "github-2018",
  title: "GitHub 2018: A Network Partition and the Database",
  track: "case-files",
  order: 10,
  difficulty: 4,
  minutes: 24,
  prerequisites: ["databases-split-brain"],
  tags: ["partition", "split brain", "quorum", "MySQL", "reconciliation"],
  productionQuestion:
    "A network partition leaves two halves of the system with different views. Which writes do you accept?",
  learningDelta:
    "Partitions create split-brain risk; quorum and fencing decide which side may write, and recovery requires reconciliation",
  objectives: [
    "Explain how a 43-second partition produced two sets of writes.",
    "Choose a failover direction that preserves data and state its latency cost.",
    "Separate data-integrity decisions from availability decisions during recovery.",
    "Design a topology constraint that prevents cross-region primary promotion.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

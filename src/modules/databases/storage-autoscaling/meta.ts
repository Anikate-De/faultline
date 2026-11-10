import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-storage-autoscaling",
  slug: "storage-autoscaling",
  title: "Storage Autoscaling",
  track: "databases",
  order: 27,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["databases-backups-pitr"],
  tags: ["storage autoscaling", "maximum", "growth", "temporary files", "full disk"],
  productionQuestion: "Disk usage climbs and autoscaling has a maximum. What happens at the cap?",
  learningDelta:
    "Storage autoscaling adds capacity within a maximum; growth rate, retention, and temporary files determine whether it saves you",
  objectives: [
    "Compute time to full from free space and growth rate.",
    "Explain autoscaling increments and the maximum storage cap.",
    "Separate permanent data growth from temporary files and retention.",
    "Choose a cap and an alarm that leave recovery headroom.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

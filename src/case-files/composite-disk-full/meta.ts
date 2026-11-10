import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-disk-full",
  slug: "composite-disk-full",
  title: "Composite: The Disk That Filled at 03:00",
  track: "case-files",
  order: 36,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-linux-disk-io"],
  tags: ["disk full", "logs", "retention", "growth", "write outage"],
  productionQuestion:
    "Logs fill the volume and the database stops accepting writes. What should have alerted first?",
  learningDelta:
    "Disk exhaustion is predictable with growth rate and retention; alerts must fire before the filesystem is full",
  objectives: [
    "Read filesystem growth and forecast time to full.",
    "Free space without destroying database recovery material.",
    "Separate log, WAL, and data volumes and cap retention.",
    "Alert on growth rate before the volume is full.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

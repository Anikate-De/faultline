import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-gitlab-2017",
  slug: "gitlab-2017",
  title: "GitLab 2017: The Backup That Did Not Restore",
  track: "case-files",
  order: 12,
  difficulty: 4,
  minutes: 24,
  prerequisites: ["databases-backups-pitr"],
  tags: ["backup", "restore", "replication", "snapshot", "verification"],
  productionQuestion:
    "The primary database is deleted and the five backup mechanisms fail in sequence. What do you verify?",
  learningDelta:
    "Backups are unproven until restored; replication, snapshots, and object storage each need independent validation",
  objectives: [
    "Trace how a replication repair destroyed the primary database.",
    "Explain why five recovery mechanisms were unavailable.",
    "Choose a restore source using RPO and restore-time evidence.",
    "Design restore tests and ownership that prove backups work.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

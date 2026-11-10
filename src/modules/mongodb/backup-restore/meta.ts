import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-backup-restore",
  slug: "backup-restore",
  title: "Backup and Restore",
  track: "mongodb",
  order: 19,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["databases-backups-pitr"],
  tags: ["backup", "restore", "consistency", "config server", "sharded cluster"],
  productionQuestion: "A restore of one shard completes but the cluster is inconsistent. Why?",
  learningDelta:
    "Cluster-consistent backups require coordination across shards and config servers; restoring one node is not a cluster restore",
  objectives: [
    "Identify the unit of a sharded-cluster backup: shards, config servers, and one cluster time.",
    "Explain why restoring one shard or omitting config metadata leaves a cluster inconsistent.",
    "Choose between a coordinated snapshot and a logical dump for a given recovery objective.",
    "Plan a restore verification that checks routing metadata and cross-shard documents, not just row counts.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

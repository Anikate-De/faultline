import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-conntrack",
  slug: "conntrack",
  title: "Conntrack Exhaustion: When NAT Forgets",
  track: "foundations",
  order: 22,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["foundations-linux-network-saturation"],
  tags: ["conntrack", "NAT", "table size", "timeout", "drop", "flow state"],
  productionQuestion:
    "New connections fail intermittently while established traffic is fine; what table is full?",
  learningDelta:
    "Conntrack entries track NAT flows; exhaustion and short timeouts drop new connections even when bandwidth is free",
  objectives: [
    "Estimate connection-tracking table occupancy from new-connection rate and entry lifetime.",
    "Tell table exhaustion apart from bandwidth saturation and application errors.",
    "Explain why shortening a timeout can break established flows without freeing the table.",
    "Size or shard NAT capacity and monitor the signals that predict exhaustion.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

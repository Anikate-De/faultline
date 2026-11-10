import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-dns-failure",
  slug: "dns-failure",
  title: "DNS Failure",
  track: "reliability",
  order: 23,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["traffic-dns-ttl-failover"],
  tags: ["DNS", "resolver", "zone", "record", "outage"],
  productionQuestion: "Nothing resolves and every service looks healthy. How do you confirm DNS?",
  learningDelta:
    "DNS failures look like many unrelated service failures; resolver, zone, and record health must be checked first",
  objectives: [
    "Recognize a DNS outage disguised as many independent service failures.",
    "Distinguish resolver, authoritative zone, and record failures by their signals.",
    "Use cached-answer coverage and TTL to explain why some clients keep working.",
    "Confirm DNS as the common cause before changing service capacity or deploys.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

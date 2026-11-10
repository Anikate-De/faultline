import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-dns-ttl-failover",
  slug: "dns-ttl-failover",
  title: "DNS TTL and Failover",
  track: "traffic",
  order: 12,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-timeouts"],
  tags: ["DNS", "TTL", "resolver caching", "failover", "JVM DNS cache"],
  productionQuestion:
    "You changed the DNS record but clients still hit the failed region after 10 minutes. Why?",
  learningDelta:
    "DNS failover is bounded by TTL and resolver caching; applications and JVMs may cache longer than the record TTL",
  objectives: [
    "Compute the stale-answer window from record TTL, resolver caching, detection time, and application cache.",
    "Explain why a DNS change does not move clients that already hold a cached answer or an open connection.",
    "Diagnose a failover that exceeds its recovery objective and reduce the effective cache window safely.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

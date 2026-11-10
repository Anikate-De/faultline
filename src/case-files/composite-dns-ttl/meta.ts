import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-dns-ttl",
  slug: "composite-dns-ttl",
  title: "Composite: DNS Failover Slower Than the RTO",
  track: "case-files",
  order: 19,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["traffic-dns-ttl-failover"],
  tags: ["DNS", "TTL", "resolver", "client cache", "RTO"],
  productionQuestion: "The record is updated in one minute but clients keep failing for 20. Why?",
  learningDelta:
    "DNS failover is bounded by the slowest resolver and client cache, not by the record's TTL alone",
  objectives: [
    "Explain why a lowered TTL does not shorten the life of records already cached.",
    "Measure failover progress at the client rather than at the authoritative zone.",
    "Reduce the recovery tail from resolvers, runtimes, and pooled connections.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

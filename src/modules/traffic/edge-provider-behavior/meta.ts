import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-edge-provider-behavior",
  slug: "edge-provider-behavior",
  title: "Cloudflare and Akamai Behavior",
  track: "traffic",
  order: 33,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["traffic-cdn-ttl-purge"],
  tags: ["Cloudflare", "Akamai", "cache key", "purge", "rule evaluation"],
  productionQuestion:
    "The same cache rule behaves differently on two CDNs. Why?",
  learningDelta:
    "Edge providers implement cache keys, purge, and rule evaluation differently; portability requires testing the behavior you depend on",
  objectives: [
    "Compare how Cloudflare and Akamai derive cache keys and scope purges.",
    "Explain why rule evaluation order changes what gets cached and what a purge reaches.",
    "Measure hit rate, stale content, purge lag, and origin load for the same intent on two providers.",
    "Port an edge configuration by translating key fields, purge scope, and rule order, then verifying behavior.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

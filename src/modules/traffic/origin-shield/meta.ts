import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-origin-shield",
  slug: "origin-shield",
  title: "Origin Shield and Request Collapsing",
  track: "traffic",
  order: 18,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-caching-strategies"],
  tags: ["origin shield", "request collapsing", "cache miss", "stampede", "edge"],
  productionQuestion:
    "A popular object expires and every edge requests it from the origin. How do you collapse the misses?",
  learningDelta:
    "Origin shield centralizes misses and request collapsing turns concurrent misses into one origin fetch",
  objectives: [
    "Explain how simultaneous edge expiries become an origin request storm.",
    "Distinguish per-edge request collapsing from a shared origin shield.",
    "Measure origin burst, origin request rate, and the latency cost of an extra cache tier.",
    "Choose a collapsing design that protects the origin without making the shield a new bottleneck.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

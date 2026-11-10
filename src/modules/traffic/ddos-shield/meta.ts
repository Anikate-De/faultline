import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-ddos-shield",
  slug: "ddos-shield",
  title: "DDoS and Shield: Absorb and Scrub",
  track: "traffic",
  order: 20,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-anycast"],
  tags: ["DDoS", "volumetric", "SYN flood", "scrubbing", "Shield", "anycast"],
  productionQuestion:
    "Inbound traffic jumps 40× and the load balancer is dropping connections. What absorbs it?",
  learningDelta:
    "DDoS protection combines edge capacity, anycast scrubbing, and rate controls; origin capacity is not the defense",
  objectives: [
    "Distinguish volumetric, protocol, and application-layer DDoS attacks by the resource they exhaust.",
    "Explain where Shield, anycast, and scrubbing sit relative to the origin.",
    "Choose mitigation controls that match the attack layer and verify the origin is actually protected.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-roblox-2021",
  slug: "roblox-2021",
  title: "Roblox 2021: Control Plane Congestion",
  track: "case-files",
  order: 15,
  difficulty: 4,
  minutes: 24,
  prerequisites: ["containers-service-discovery"],
  tags: ["control plane", "Consul", "discovery", "saturation", "recovery"],
  productionQuestion:
    "The application is healthy but service discovery and configuration are failing. What do you stabilize first?",
  learningDelta:
    "Control-plane saturation can stop data-plane changes even when requests still succeed; recovery needs load reduction and sequencing",
  objectives: [
    "Explain how service discovery, scheduling, and secrets form a shared control plane.",
    "Separate two independent root causes that present as one latency symptom.",
    "Recognize observability that depends on the system it observes.",
    "Sequence recovery from a full control-plane outage.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

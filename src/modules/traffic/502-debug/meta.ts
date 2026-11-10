import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-502-debug",
  slug: "502-debug",
  title: "Debugging 502 Bad Gateway",
  track: "traffic",
  order: 26,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-alb-health-checks"],
  tags: ["502", "bad gateway", "target health", "protocol", "reset", "TLS"],
  productionQuestion:
    "Users get 502s and the targets say they are healthy. Where do you look first?",
  learningDelta:
    "A 502 means the load balancer could not get a valid response from the target; health, protocol, keepalive, and connection reset are the suspects",
  objectives: [
    "Separate an edge-generated 502 from a target-generated 502 using ELB and target metrics and access-log status fields.",
    "Diagnose three target-side causes that can pass a shallow health check: malformed response, connection reset, and TLS handshake failure.",
    "Explain why a health check can stay green while request-path 502s rise.",
    "Choose the first fix from the source instead of adding targets or restarting the fleet.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

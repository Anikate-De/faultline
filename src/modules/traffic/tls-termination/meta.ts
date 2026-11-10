import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-tls-termination",
  slug: "tls-termination",
  title: "TLS Termination: Where Keys Live",
  track: "traffic",
  order: 22,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-tls-handshake"],
  tags: ["TLS termination", "re-encryption", "mTLS", "certificate", "inspection"],
  productionQuestion:
    "You need end-to-end encryption but the ALB must route by path. Where do you terminate?",
  learningDelta:
    "TLS can terminate at edge, load balancer, or service; each choice changes certificate scope, inspection, and latency",
  objectives: [
    "Trace where TLS ends and where private keys live at each termination layer.",
    "Explain why path routing and Layer 7 inspection require a terminator that sees HTTP.",
    "Choose re-encryption or mTLS to keep traffic protected past the load balancer.",
    "Compare edge, load balancer, and service termination by certificate scope and operational cost.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

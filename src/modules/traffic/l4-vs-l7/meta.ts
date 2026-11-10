import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-l4-vs-l7",
  slug: "l4-vs-l7",
  title: "L4 vs L7: Choose the Right Load Balancer",
  track: "traffic",
  order: 1,
  difficulty: 1,
  minutes: 14,
  prerequisites: ["foundations-linux-network-saturation"],
  tags: ["L4", "L7", "TCP", "HTTP", "TLS termination", "routing"],
  productionQuestion:
    "You need static IPs and millions of connections, but also path routing. Which layer do you choose?",
  learningDelta:
    "L4 routes connections and cannot inspect paths; L7 routes requests and terminates protocols; the correct design often layers both",
  objectives: [
    "Distinguish connection-level forwarding from request-level routing.",
    "Map static IP, throughput, and path-routing requirements to a load balancer layer.",
    "Explain why a Layer 4 load balancer cannot evaluate an HTTP path.",
    "Design an NLB-to-ALB chain that keeps static IPs and path rules.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

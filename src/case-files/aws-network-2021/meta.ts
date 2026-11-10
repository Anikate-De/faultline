import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-aws-network-2021",
  slug: "aws-network-2021",
  title: "AWS us-east-1: Network Congestion and the Retry Tax",
  track: "case-files",
  order: 3,
  difficulty: 4,
  minutes: 24,
  prerequisites: ["traffic-cross-zone-lb"],
  tags: ["network congestion", "cross-AZ", "retries", "attribution", "failover"],
  productionQuestion:
    "Your service is healthy but cross-AZ calls time out. How do you prove the network is the cause?",
  learningDelta:
    "Network congestion looks like application failure; retries and cross-AZ dependencies amplify the blast radius",
  objectives: [
    "Distinguish a congested network path from an application failure.",
    "Use logs and controlled changes when the monitoring plane is degraded.",
    "Treat DNS errors as a symptom until the network path is proven healthy.",
    "Bound retry and connection amplification during a network event.",
    "Separate control-plane impact from customer data-plane health.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

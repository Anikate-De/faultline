import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-private-hosted-zones",
  slug: "private-hosted-zones",
  title: "Private Hosted Zones",
  track: "cloud-networking",
  order: 16,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-route53-routing"],
  tags: ["private hosted zone", "association", "public zone", "split-horizon", "DNS"],
  productionQuestion: "An internal service name resolves publicly. What is wrong?",
  learningDelta:
    "Private hosted zones are associated with VPCs and only resolve there; public zones resolve globally",
  objectives: [
    "Explain why a private hosted zone answers only for associated VPCs and inbound Resolver paths.",
    "Distinguish a missing association from a missing record and from a public-zone copy.",
    "Recognize split-horizon DNS and decide when a public record for the same name is intentional.",
    "Predict which zone answers a query from the internet, an associated VPC, and an unassociated VPC.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

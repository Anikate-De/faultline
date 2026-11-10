import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-route53-resolver",
  slug: "route53-resolver",
  title: "Route 53 Resolver",
  track: "cloud-networking",
  order: 15,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["cloud-networking-private-hosted-zones"],
  tags: ["Route 53 Resolver", "inbound", "outbound", "forwarding", "private zone"],
  productionQuestion:
    "An on-premises service cannot resolve a private hosted zone. What do you configure?",
  learningDelta:
    "Resolver endpoints forward DNS between VPCs and on-premises; inbound and outbound endpoints serve different directions",
  objectives: [
    "Choose an inbound or outbound Resolver endpoint from the direction of the DNS query.",
    "Trace a hybrid query from the on-premises resolver to the private hosted zone and back.",
    "Detect a forwarding loop and distinguish it from a missing rule or a missing zone association.",
    "Size Resolver endpoint IPs against the documented per-IP query limit and add interfaces before saturation.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

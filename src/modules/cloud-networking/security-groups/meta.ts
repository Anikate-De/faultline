import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-security-groups",
  slug: "security-groups",
  title: "Security Groups",
  track: "cloud-networking",
  order: 6,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-alb-target-groups"],
  tags: ["security group", "stateful", "inbound", "reference", "allow list"],
  productionQuestion:
    "A new service cannot be reached from the load balancer. Which security group rule?",
  learningDelta:
    "Security groups are stateful allow lists; references between groups are safer than CIDR ranges",
  objectives: [
    "Trace an ALB request through the load balancer security group and the target security group.",
    "Explain why a target security group reference is narrower and easier to maintain than a CIDR range.",
    "Use stateful return traffic and health-check behavior to separate a blocked rule from a missing route.",
    "Replace a broad CIDR rule without breaking the service, and verify the target health signal.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

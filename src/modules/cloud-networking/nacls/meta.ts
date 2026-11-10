import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-nacls",
  slug: "nacls",
  title: "Network ACLs",
  track: "cloud-networking",
  order: 7,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["cloud-networking-security-groups"],
  tags: ["NACL", "stateless", "ephemeral port", "subnet", "allow/deny"],
  productionQuestion:
    "Security groups allow the traffic but a subnet ACL blocks the response. Why?",
  learningDelta:
    "Network ACLs are stateless and evaluated per subnet; ephemeral ports must be allowed in both directions",
  objectives: [
    "Trace a request and its response through the inbound and outbound rules of two subnet ACLs.",
    "Explain why a stateful security group rule does not create an ACL rule for the response.",
    "Use ephemeral port ranges and first-match rule order to localize a one-way failure.",
    "Tighten a broad ephemeral allow rule without closing the return path.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

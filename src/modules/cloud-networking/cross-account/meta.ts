import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-cross-account",
  slug: "cross-account",
  title: "Cross-Account Networking",
  track: "cloud-networking",
  order: 10,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["cloud-networking-peering-vs-tgw"],
  tags: ["cross-account", "RAM", "resource policy", "trust", "shared VPC"],
  productionQuestion:
    "A shared service must be reachable from five accounts. How do you connect them safely?",
  learningDelta:
    "Cross-account networking uses resource policies, RAM, and centralized route/security ownership; account boundaries are real trust boundaries",
  objectives: [
    "Separate subnet visibility from service authorization in a shared VPC design.",
    "Compare a named-account share with an organization-wide share and a wildcard resource policy.",
    "Compute the gap between the intended account set and the accounts that can actually reach the service.",
    "Narrow an over-broad share without breaking the five intended consumers.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

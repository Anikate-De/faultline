import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-direct-connect",
  slug: "direct-connect",
  title: "Direct Connect",
  track: "cloud-networking",
  order: 17,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["cloud-networking-vpn"],
  tags: ["Direct Connect", "dedicated", "BGP", "backup", "failover"],
  productionQuestion: "The office link is down and the VPN backup is not taking traffic. Why?",
  learningDelta:
    "Direct Connect provides private dedicated connectivity but is not inherently diverse; BGP and backup paths determine failover",
  objectives: [
    "Trace a hybrid path from the office router through a Direct Connect location, virtual interface, and gateway to the VPC.",
    "Distinguish physical diversity from logical failover: two links in one location share a failure domain.",
    "Explain why a VPN that is up can stay unused when the stale Direct Connect route is still preferred.",
    "Choose between restoring the primary path, withdrawing the stale route, and accepting reduced backup capacity.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

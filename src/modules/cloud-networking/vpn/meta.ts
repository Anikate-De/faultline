import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-vpn",
  slug: "vpn",
  title: "Site-to-Site VPN",
  track: "cloud-networking",
  order: 18,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["cloud-networking-route-propagation"],
  tags: ["VPN", "tunnel", "BGP", "static route", "security policy"],
  productionQuestion: "The VPN tunnel is up but traffic does not flow. What do you check?",
  learningDelta:
    "VPN requires matching tunnels, BGP or static routes, and security policies; tunnel state alone is not connectivity",
  objectives: [
    "Trace a site-to-site VPN packet through the tunnel, the route table, and the security policy.",
    "Explain why a tunnel can be up while no route selects it, and why that differs from a policy block.",
    "Compare static routing with BGP for failover between two tunnels.",
    "Choose the smallest fix that restores traffic without hiding the next failure.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

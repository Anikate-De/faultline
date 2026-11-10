import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-linux-network-saturation",
  slug: "linux-network-saturation",
  title: "Network Saturation: Bandwidth, Retransmits, and Drops",
  track: "foundations",
  order: 20,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-linux-disk-io"],
  tags: ["bandwidth", "retransmit", "packet loss", "NIC queue", "TCP congestion", "drops"],
  productionQuestion:
    "Throughput is below the link rate and latency climbs; what network signal do you check first?",
  learningDelta:
    "Bandwidth, packet loss, retransmits, and NIC queue drops are different failure modes with different fixes",
  objectives: [
    "Distinguish a full link from a lossy path with spare capacity.",
    "Read retransmits, packet loss, and NIC drops as separate signals.",
    "Explain why TCP throughput falls with loss and RTT.",
    "Choose between more bandwidth, loss remediation, and queue tuning.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

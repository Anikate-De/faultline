import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-tls-handshake",
  slug: "tls-handshake",
  title: "TLS Handshakes: Latency Before the Request",
  track: "foundations",
  order: 23,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-linux-network-saturation"],
  tags: ["TLS handshake", "RTT", "session resumption", "OCSP", "certificate", "keep-alive"],
  productionQuestion:
    "p99 rose after a DNS change; is TLS or the application slow?",
  learningDelta:
    "Full handshakes add round trips and CPU; resumption and keep-alive remove them from the steady state",
  objectives: [
    "Trace where TCP and TLS handshake time sits relative to application time.",
    "Calculate how keep-alive and session resumption change handshake frequency.",
    "Separate handshake CPU cost from request queuing using per-phase signals.",
    "Reduce handshake cost without weakening certificate or protocol validation.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

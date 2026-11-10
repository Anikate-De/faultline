import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-http3-quic",
  slug: "http3-quic",
  title: "HTTP/3 and QUIC",
  track: "traffic",
  order: 21,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["traffic-tls-termination"],
  tags: ["HTTP/3", "QUIC", "UDP", "head-of-line blocking", "0-RTT", "fallback"],
  productionQuestion:
    "Mobile users on lossy networks see slow loads over TCP. Would QUIC help, and what breaks?",
  learningDelta:
    "QUIC runs over UDP with independent streams and faster handshakes; loss affects streams differently but UDP may be blocked",
  objectives: [
    "Explain how QUIC removes TCP head-of-line blocking without making loss free.",
    "Compare HTTP/2 and HTTP/3 latency under packet loss and round-trip time.",
    "Predict what happens when a network blocks UDP and fallback is missing.",
    "Design an HTTP/3 rollout with a safe HTTP/2 fallback path.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

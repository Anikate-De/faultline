import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-connection-storm",
  slug: "databases-connection-storm",
  title: "Connection Storms After Failover",
  track: "databases",
  order: 29,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-failover-dns"],
  tags: ["connection storm", "reconnect", "jitter", "backoff", "pooling", "failover"],
  productionQuestion:
    "A failover triggers 10k reconnects and the new writer is overwhelmed. How do you dampen it?",
  learningDelta:
    "Reconnect storms need jitter, backoff, connection pooling, and pre-warmed capacity; immediate retries amplify the failover",
  objectives: [
    "Explain why synchronized reconnects amplify a failover.",
    "Quantify a reconnect burst from client count, jitter, and retry behavior.",
    "Combine pooling, jitter, and backoff instead of relying on one control.",
    "Decide when a proxy is worth the extra network hop.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-kms",
  slug: "kms",
  title: "KMS and Envelope Encryption",
  track: "cloud-networking",
  order: 24,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["cloud-networking-secrets"],
  tags: ["KMS", "envelope encryption", "data key", "key policy", "throttling"],
  productionQuestion:
    "Each S3 object is encrypted with a KMS key and latency rises. What is the better pattern?",
  learningDelta:
    "Envelope encryption uses a data key for bulk data and KMS to protect the data key; direct KMS calls are for small secrets",
  objectives: [
    "Trace a direct KMS call and an envelope-encrypted write end to end.",
    "Explain why bulk data uses a data key while KMS protects that key.",
    "Recognize KMS request throttling from latency and error signals before storage throughput is blamed.",
    "Choose a data-key reuse and caching strategy that keeps the key policy and rotation requirements intact.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "cloud-networking-encryption",
  slug: "encryption",
  title: "Encryption at Rest and in Transit",
  track: "cloud-networking",
  order: 25,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["cloud-networking-kms"],
  tags: ["encryption at rest", "encryption in transit", "TLS", "mTLS", "key"],
  productionQuestion:
    "Data is encrypted at rest but crosses a VPC in plaintext. What layer is missing?",
  learningDelta:
    "Encryption at rest and in transit are separate controls; TLS, mTLS, and service policies cover different paths",
  objectives: [
    "Separate encryption at rest from encryption in transit when auditing a data path.",
    "Identify which hop is unprotected when only one layer is enabled.",
    "Explain what TLS protects and what mutual TLS adds.",
    "Decide when a gap is a key-policy issue and when it is a transport or identity issue.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-cert-rotation",
  slug: "cert-rotation",
  title: "Certificate Rotation",
  track: "mesh",
  order: 22,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["mesh-mtls"],
  tags: ["certificate rotation", "trust bundle", "expiry", "reload", "mTLS"],
  productionQuestion: "Certificates expire at midnight and the mesh starts failing handshakes. What rotation plan?",
  learningDelta:
    "Certificate rotation needs overlapping validity, trust bundles, and automated reload; short-lived certs reduce risk but require reliable automation",
  objectives: [
    "Explain how leaf certificates, a trust bundle, and SDS fit together in mesh mTLS.",
    "Distinguish a certificate that was renewed from one the proxy actually loaded.",
    "Predict the failure window when trust bundles do not overlap.",
    "Design a rotation plan with alerts before expiry, not after.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

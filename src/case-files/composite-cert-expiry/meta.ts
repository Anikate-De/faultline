import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-cert-expiry",
  slug: "composite-cert-expiry",
  title: "Composite: The Certificate That Expired at Midnight",
  track: "case-files",
  order: 28,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["mesh-cert-rotation"],
  tags: ["certificate", "expiry", "renewal", "alert", "mTLS"],
  productionQuestion:
    "TLS handshakes fail at 00:00 and no one is paged. What controls were missing?",
  learningDelta:
    "Certificate expiry is a scheduled outage; inventory, automated renewal, and expiry alerts are required controls",
  objectives: [
    "Identify an expired certificate from a failing TLS handshake.",
    "Separate an expired leaf from a control-plane or routing failure.",
    "Choose an emergency re-issue path with contained security risk.",
    "Design renewal monitoring that does not depend on email.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

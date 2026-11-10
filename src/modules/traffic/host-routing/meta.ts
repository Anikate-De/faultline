import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-host-routing",
  slug: "host-routing",
  title: "Host and Path Routing",
  track: "traffic",
  order: 30,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-alb-rule-priority"],
  tags: ["host header", "path", "SNI", "certificate", "wildcard", "routing"],
  productionQuestion:
    "You need to route api.meridian.internal and app.meridian.internal to different services. Where does routing belong?",
  learningDelta:
    "Host/path routing at the ALB is cheap and centralized; it must account for certificates, wildcard scope, and rule limits",
  objectives: [
    "Place host and path routing at a layer that can see the HTTP request.",
    "Explain how SNI and certificate scope interact with host rules.",
    "Diagnose a TLS failure that happens before any routing rule runs.",
    "Design tenant routing with certificate coverage and rule limits in mind.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

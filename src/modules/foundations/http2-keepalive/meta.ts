import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-http2-keepalive",
  slug: "http2-keepalive",
  title: "HTTP/2 and Keep-Alive: Reuse With Rules",
  track: "foundations",
  order: 24,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-tls-handshake"],
  tags: ["keep-alive", "idle timeout", "HTTP/2 streams", "connection reuse", "GOAWAY"],
  productionQuestion:
    "The load balancer is healthy but backends see a new connection per request; why?",
  learningDelta:
    "Connection reuse depends on both peers agreeing on idle timeouts, max requests, and protocol; mismatches cause churn",
  objectives: [
    "Explain how idle timeouts, request caps, and protocol choice decide connection reuse.",
    "Find the peer whose timeout closes a connection first.",
    "Diagnose connection churn from client, load balancer, and backend metrics together.",
    "Align connection lifetimes without creating reconnect storms during deploys.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

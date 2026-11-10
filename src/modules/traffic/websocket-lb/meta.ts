import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-websocket-lb",
  slug: "websocket-lb",
  title: "WebSockets Through a Load Balancer",
  track: "traffic",
  order: 31,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-keepalive-idle-timeout"],
  tags: ["WebSocket", "idle timeout", "upgrade", "draining", "connections"],
  productionQuestion:
    "WebSocket clients disconnect every 60 seconds behind the ALB. What setting is involved?",
  learningDelta:
    "WebSockets reuse a long-lived TCP connection; idle timeouts, draining, and connection limits behave differently from short HTTP requests",
  objectives: [
    "Explain the HTTP Upgrade handshake and what changes after a 101 response.",
    "Find an idle timeout that closes an apparently active WebSocket.",
    "Predict how deregistration delay turns a deploy into a reconnect wave.",
    "Design heartbeat, draining, and reconnect behavior for a WebSocket fleet.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};

import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Reconnect storm during an HTTP/2 fleet deploy",
  accuracyNote:
    "This is an original composite scenario and not a real incident. It combines common HTTP/2 connection-drain, load-balancer, and client-pool failure modes into one representative case. It does not describe any company's architecture, traffic, dates, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "A routine rolling deploy starts",
      body: "The edge fleet is replaced in waves of 30%. Each old instance receives a termination signal, sends a GOAWAY frame on every HTTP/2 connection, and closes its listener. No drain window is configured.",
      tone: "info",
    },
    {
      at: "T+00:25",
      title: "Clients discard their connections",
      body: "Each client pool sees GOAWAY, marks the connection unusable, and dials a new one. Requests above the last accepted stream ID are retried. Across thousands of clients, the reconnect timers are close enough to form a single wave.",
      tone: "warn",
    },
    {
      at: "T+00:50",
      title: "The new fleet pays for the handshakes",
      body: "TLS handshakes and HTTP/2 preface processing jump to 15x baseline. New instances are still warming caches and runtimes. Connection establishment, not request handling, becomes the busiest code path.",
      tone: "warn",
    },
    {
      at: "T+01:20",
      title: "Latency crosses the SLO",
      body: "p99 rises from 180 ms to 1.9 s and a small share of requests fail with connection reset or 502. The load balancer still has healthy targets, so health checks stay green.",
      tone: "danger",
    },
    {
      at: "T+01:45",
      title: "The next wave makes it worse",
      body: "The rollout continues before the first wave settles. A second set of instances drains, and clients that had just reconnected are displaced again. Retry attempts now outnumber new user requests.",
      tone: "danger",
    },
    {
      at: "T+03:00",
      title: "The rollout is paused",
      body: "The deploy is paused at 60% and the team stops further terminations. Connection churn begins to fall, but the new fleet remains connection-bound until the backlog of handshakes clears.",
      tone: "info",
    },
    {
      at: "T+09:00",
      title: "Drain and jitter are added",
      body: "The next attempt uses a preStop delay, a two-phase GOAWAY with a 30-second drain, small deploy waves, and client reconnect jitter. Connection rate rises modestly instead of forming a spike.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-response",
      prompt:
        "The rollout is 60% complete. p99 is ten times baseline and the next wave is about to terminate more instances. What is the first action?",
      options: [
        {
          id: "pause-and-drain",
          label: "Pause the rollout and let the current connection churn settle before continuing.",
          consequence:
            "Further terminations stop, so no new wave of GOAWAY frames is created. The fleet stays partially upgraded, but the team gets a stable window to inspect drain settings and client reconnect behavior.",
          quality: "good",
        },
        {
          id: "roll-back",
          label: "Roll back every new instance immediately.",
          consequence:
            "The rollback terminates the instances that just absorbed the reconnecting clients, causing another mass reconnect. Capacity and connection state are disturbed again without fixing the shutdown sequence.",
          quality: "mixed",
        },
        {
          id: "scale-up",
          label: "Scale the new fleet up to absorb the handshakes.",
          consequence:
            "More instances can spread the TLS cost, but the reconnect wave is driven by client behavior, not capacity. New instances add cold starts and do not stop the remaining rollout from draining more connections.",
          quality: "mixed",
        },
      ],
      debrief:
        "The immediate problem is a change in connection state, not a shortage of request-processing capacity. Pausing the rollout stops the input that creates each wave. A rollback is another disruptive connection event, and scaling adds capacity to a path that is dominated by handshakes. The first move should reduce churn, then make the next drain graceful.",
    },
    {
      id: "lasting-fix",
      prompt:
        "What combination should make future deploys safe for long-lived HTTP/2 connections?",
      options: [
        {
          id: "graceful-drain",
          label:
            "Use a preStop delay, two-phase GOAWAY with a drain window, small waves, and jittered client reconnect.",
          consequence:
            "The load balancer stops sending new connections before the process exits, in-flight streams finish, and clients spread their reconnects. The deploy takes longer but connection rate stays inside capacity.",
          quality: "good",
        },
        {
          id: "longer-grace",
          label: "Raise the termination grace period and keep the current shutdown hook.",
          consequence:
            "In-flight requests get more time, but the server still refuses new streams immediately and every client still reconnects at once. The grace period delays the process exit without spreading the wave.",
          quality: "mixed",
        },
        {
          id: "no-goaway",
          label: "Stop sending GOAWAY and let the load balancer close old connections.",
          consequence:
            "Clients lose the explicit signal that the connection is ending and may retry streams whose processing state is unknown. Abrupt closes move the problem from a visible drain to ambiguous failures.",
          quality: "poor",
        },
      ],
      debrief:
        "GOAWAY is a coordination signal, not a kill switch. A graceful sequence first tells clients to stop creating new streams, then waits for accepted streams to finish, then closes. The load balancer must stop routing new connections before the process disappears, which is why a preStop delay and readiness removal matter. Client jitter is the other half: even a correct drain creates a reconnect event, and jitter prevents those events from aligning across the fleet.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A rolling deploy terminated instances that held long-lived HTTP/2 connections. Each termination produced GOAWAY frames, and client pools responded by reconnecting. Because the rollout used large waves, no preStop delay, and no drain window, the reconnects aligned into a burst that saturated TLS and connection setup on the new fleet.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "The shutdown hook sent GOAWAY and closed the listener in the same step, so clients could not finish accepted streams.",
        "The load balancer could still route new connections to an instance after it began draining.",
        "Client reconnect delays were fixed or absent, so pools retried in synchronized waves.",
        "The rollout continued while the previous wave was still connection-bound, stacking churn on churn.",
        "Dashboards showed request rate and p99 but not new connections, TLS handshakes, or GOAWAY counts.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Instances drain in two phases: an initial GOAWAY stops new streams, then a final GOAWAY closes the connection after accepted streams finish.",
        "A preStop delay lets endpoint removal and load-balancer deregistration complete before the listener closes.",
        "Deploys use smaller waves with a settle period, and connection age limits are jittered so connections do not all expire together.",
        "Clients reconnect with exponential backoff and jitter, and connection-establishment rate is now a deploy SLI.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "HTTP/2 multiplexing reduces the number of connections, which makes each connection more valuable and each shutdown more disruptive. A deploy is therefore a connection-lifecycle event, not just a process replacement. The safe pattern is to stop new work, finish accepted work, remove the endpoint before closing the listener, and spread reconnects. Capacity planning that counts only requests per second will miss the handshake burst entirely.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, multipliers, and latency values in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "RFC 9113: HTTP/2",
      url: "https://www.rfc-editor.org/rfc/rfc9113.html",
      publisher: "IETF",
      kind: "standard",
      note: "GOAWAY semantics, last-stream-id, and graceful connection shutdown.",
    },
    {
      title: "Draining",
      url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/operations/draining",
      publisher: "Envoy Project",
      kind: "docs",
      note: "Drain sequence for connection-oriented proxies.",
    },
    {
      title: "Pod Lifecycle: Pod termination",
      url: "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Termination flow, preStop hooks, and grace periods.",
    },
  ],
};

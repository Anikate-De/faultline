import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "CrashLoopBackOff after readiness passed before the request path initialized",
  accuracyNote:
    "This is an original composite scenario and not a real incident. It combines common Kubernetes probe, startup-ordering, and traffic-gating failure modes into one representative case. It does not describe any company's architecture, traffic, dates, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "A new release moves warm-up out of startup",
      body: "The new version starts its HTTP listener before loading a large in-memory cache. Warm-up now happens lazily on the first request. The readiness probe is a TCP connect, the liveness probe is an HTTP call with a one-second timeout and a failure threshold of one, and there is no startup probe.",
      tone: "info",
    },
    {
      at: "T+00:12",
      title: "Readiness turns green",
      body: "The TCP connect succeeds as soon as the port is open. The pod is added to the Service endpoints, even though no request has exercised the cache or the downstream connection pool.",
      tone: "warn",
    },
    {
      at: "T+00:30",
      title: "First requests block the process",
      body: "Cache misses trigger synchronous fetches. Request handlers hold the event loop for several seconds, and p99 rises above three seconds. The liveness probe shares that event loop and times out.",
      tone: "warn",
    },
    {
      at: "T+00:45",
      title: "Liveness restarts the container",
      body: "One missed liveness probe is enough to kill the process. The container restarts, opens its port again, and is marked Ready before it is warm. Early restarts are about two minutes apart; backoff grows toward five minutes and resets only after ten minutes of running.",
      tone: "danger",
    },
    {
      at: "T+02:30",
      title: "The dashboard disagrees with users",
      body: "Restart count climbs, but readiness is green only briefly after each restart, not for most of the cycle. Liveness failures are buried in pod events, so the team assumes an application bug and misses the probe contract.",
      tone: "danger",
    },
    {
      at: "T+03:10",
      title: "A wider timeout hides the frequency",
      body: "The liveness timeout is raised from one second to five. Restarts become less frequent, but cold pods still receive traffic and requests remain slow.",
      tone: "warn",
    },
    {
      at: "T+05:00",
      title: "The signals are separated",
      body: "A startup probe waits for an eager warm-up before readiness and liveness begin. Readiness performs a representative request touching the cache and downstream pool. Liveness checks only local process progress, with three failures before a restart.",
      tone: "success",
    },
    {
      at: "T+16:00",
      title: "The loop stops",
      body: "Restart count stays flat, readiness flips only after warm-up, and p99 returns to its normal range. The probes were measuring the wrong things.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "readiness-vs-liveness",
      prompt:
        "Readiness is green between restarts, yet the container is killed under load. What is the first useful split?",
      options: [
        {
          id: "probe-semantics",
          label:
            "Compare the readiness check, the liveness timeout, and the last restart reason, then send a real request from inside the pod before it is marked Ready.",
          consequence:
            "The team sees that readiness only proves the port is open, while liveness is failing because the request path is slow. The restart reason points to probe configuration rather than an application crash.",
          quality: "good",
        },
        {
          id: "raise-limits",
          label: "Raise the CPU and memory limits so the container has more room.",
          consequence:
            "More resources may shorten the stall, but the readiness signal still passes before the pod can serve. The probe contract remains wrong and the next slow dependency reproduces the loop.",
          quality: "mixed",
        },
        {
          id: "disable-liveness",
          label: "Remove the liveness probe to stop the restarts.",
          consequence:
            "Restarts stop, but a genuinely deadlocked process stays in the endpoint list. The team trades a visible loop for a silent availability failure.",
          quality: "poor",
        },
      ],
      debrief:
        "Readiness controls whether a pod receives traffic; liveness controls whether the kubelet restarts it. A TCP check proves only that a socket accepts connections. It says nothing about cache state, downstream credentials, or whether a request can complete. The restart reason is the other half of the split: a liveness kill, an out-of-memory kill, and an application exit all look like restarts in a count, but they call for different fixes.",
    },
    {
      id: "immediate-fix",
      prompt:
        "What change should restore stable serving without hiding a replica that cannot serve?",
      options: [
        {
          id: "startup-and-readiness",
          label:
            "Add a startup probe for warm-up, make readiness exercise the real request path, and keep liveness local and tolerant.",
          consequence:
            "Traffic reaches the pod only after warm-up, readiness reflects serving ability, and liveness recovers a stuck process without reacting to ordinary load. Each signal keeps one job.",
          quality: "good",
        },
        {
          id: "longer-liveness",
          label: "Raise the liveness timeout and failure threshold only.",
          consequence:
            "Fewer containers are killed, but cold pods still receive traffic and requests still stall. The readiness gate remains open too early.",
          quality: "mixed",
        },
        {
          id: "more-replicas",
          label: "Scale out so each replica receives less traffic.",
          consequence:
            "More replicas add more cold caches and repeat the same probe failure. Capacity spend rises while the serving path remains unverified.",
          quality: "poor",
        },
      ],
      debrief:
        "A startup probe is the right tool for a slow initialization phase: it holds off the other probes until the process has had a bounded chance to warm. Readiness should answer whether this replica can serve now, using a request that represents real work. Liveness should answer whether the process is making progress, using a local check with enough tolerance that normal load does not become a restart trigger. Scaling out spreads the symptom and multiplies the number of cold starts.",
    },
    {
      id: "durable-contract",
      prompt: "What should keep probe configuration honest in future rollouts?",
      options: [
        {
          id: "contract-and-canary",
          label:
            "Define the intent of each probe, test the rollout under load in a canary, and alert on restarts and readiness flips.",
          consequence:
            "Probe behavior becomes part of the release contract rather than a copied manifest. A canary exposes the cold-start path before all replicas change, and alerts catch a green readiness signal that hides restarts.",
          quality: "good",
        },
        {
          id: "one-deep-endpoint",
          label: "Use one deep health endpoint for startup, readiness, and liveness.",
          consequence:
            "A shared dependency blip can fail all three probes at once. Liveness then restarts every replica, turning a dependency slowdown into a cluster-wide outage.",
          quality: "poor",
        },
        {
          id: "readiness-only",
          label: "Drop liveness and rely on readiness to remove unhealthy pods.",
          consequence:
            "Readiness removes a stuck pod from traffic, but nothing restarts it. A deadlocked process can sit indefinitely while capacity silently shrinks.",
          quality: "mixed",
        },
      ],
      debrief:
        "The durable fix is a contract, not a copied YAML block. Startup protects a slow init; readiness gates traffic on the ability to serve; liveness recovers a process that cannot make progress. A deep endpoint belongs in readiness only when the dependency is local to that replica's ability to serve. Testing probes under load is essential because a probe that passes at idle can fail exactly when traffic arrives.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A release moved cache warm-up from startup to the first request. The readiness probe was a TCP connect, so the pod was added to the Service as soon as its port opened. The first real requests blocked the event loop while filling the cache, and the one-second liveness probe timed out. The kubelet restarted the container, which became Ready again before it was warm. Under traffic, the pod looped through ready, slow, killed, and restarted.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "Readiness tested a socket, not the request path, so a cold pod looked healthy.",
        "Liveness used a one-second timeout and a failure threshold of one, making normal load a restart trigger.",
        "The first response lengthened the liveness timeout, reducing restart frequency without closing the readiness gap.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "A startup probe gates readiness and liveness until warm-up completes.",
        "Readiness performs a representative request that exercises the cache and downstream pool.",
        "Liveness checks local process progress and requires three failures before a restart.",
        "Canary rollouts run with production-like load, and alerts pair restart count with probe failures.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "A green readiness signal is not a health certificate. It is a statement about the check that was run. If the check only opens a socket, the signal means the socket is open. Liveness is not a load monitor either; using it to restart slow pods couples availability to traffic. Separate the signals by the decision each one makes, and test them where the failure actually appears: under load, before the first request.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, timeouts, restart intervals, and latency values in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Liveness, Readiness, and Startup Probes",
      url: "https://kubernetes.io/docs/concepts/workloads/pods/probes/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "What each probe controls and how startup probes gate the others.",
    },
    {
      title: "Configure Liveness, Readiness and Startup Probes",
      url: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Probe mechanisms, thresholds, and configuration examples.",
    },
    {
      title: "Pod Lifecycle",
      url: "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Container states, restart policy, and readiness conditions.",
    },
    {
      title: "Debug Pods",
      url: "https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Inspecting pod status, events, and restart causes.",
    },
  ],
};

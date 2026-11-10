import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Mesh retry amplification during a shared dependency slowdown",
  accuracyNote:
    "This is an original composite, not a real company incident. It is not a real incident and does not describe any organization's architecture, dates, traffic, people, or internal decisions. It combines common mesh, retry, and ownership failure modes; all times are relative and all telemetry is illustrative.",
  architecture: { id: "request-path" },
  timeline: [
    {
      at: "T+00:00",
      title: "A shared dependency slows",
      body: "A pricing dependency used by several services develops queueing latency. It still answers some requests, so callers see a mix of slow successes and timeouts.",
      tone: "warn",
    },
    {
      at: "T+00:08",
      title: "Retries multiply across hops",
      body: "The mesh default allows three attempts per proxy hop. A request that crosses three services can generate up to twenty-seven attempts, and each retry carries its own timeout.",
      tone: "danger",
    },
    {
      at: "T+00:15",
      title: "Platform traffic triples",
      body: "Retry attempts dominate inbound traffic. The dependency stays saturated, and services that were healthy begin to fail because their callers keep retrying through them.",
      tone: "danger",
    },
    {
      at: "T+00:25",
      title: "The dashboards disagree",
      body: "Service dashboards show normal inbound request rates, while mesh telemetry shows retry counts rising. No single team owns the aggregate, so each team concludes its own service is fine.",
      tone: "warn",
    },
    {
      at: "T+00:40",
      title: "Mitigation debate stalls",
      body: "Application teams want to scale the dependency. The platform team wants to change the mesh default but cannot prove which routes depend on it. Both changes are plausible, and neither is fast enough alone.",
      tone: "danger",
    },
    {
      at: "T+00:55",
      title: "A global cap is applied",
      body: "The platform team reduces attempts at the mesh edge and applies a retry budget to the busiest routes. Offered load falls immediately, and the dependency starts to recover.",
      tone: "success",
    },
    {
      at: "T+01:20",
      title: "The dependency returns to normal",
      body: "Latency falls and retries stop amplifying. The team keeps the cap in place and begins the slower work of assigning ownership and reviewing overrides.",
      tone: "success",
    },
    {
      at: "T+01:45",
      title: "Ownership is written down",
      body: "The platform team owns defaults and the global budget; service teams request documented overrides with a retry-ratio target. Reviews now compare actual attempt counts against the contract.",
      tone: "info",
    },
    {
      at: "T+03:00",
      title: "Incident closed",
      body: "The review finds that the retry policy was technically correct at every hop and still wrong for the system as a whole.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-mitigation",
      prompt: "One dependency slowdown has tripled platform traffic. Where do you apply the first fix?",
      options: [
        {
          id: "mesh-cap",
          label: "Cap retries at the mesh edge and apply a budget to the busiest routes.",
          consequence:
            "The shared layer removes amplification for every caller at once. Some transient failures surface, but the dependency gets relief and the platform stops multiplying load it cannot serve.",
          quality: "good",
        },
        {
          id: "scale-dependency",
          label: "Scale the dependency horizontally as the primary response.",
          consequence:
            "More capacity may help eventually, but retries multiply faster than instances can be added. The dependency stays saturated while the new capacity is provisioned.",
          quality: "mixed",
        },
        {
          id: "raise-timeouts",
          label: "Raise mesh timeouts so fewer requests fail and retry.",
          consequence:
            "Longer timeouts increase concurrency and keep doomed requests in flight. They reduce neither the attempt count nor the load, and they delay failure signals.",
          quality: "poor",
        },
      ],
      debrief:
        "Amplification is created by the sum of retry policies, so the fastest effective control is the shared one. A mesh edge cap and a per-route budget bound the total attempts regardless of how many hops a request crosses. Scaling changes capacity but not the multiplier, and the multiplier is what turned a slowdown into a platform event.",
    },
    {
      id: "localize",
      prompt: "How do you find where the amplification is coming from?",
      options: [
        {
          id: "per-hop",
          label: "Measure retry attempts per hop and multiply across the call chain, then compare defaults with overrides.",
          consequence:
            "The compounding path becomes visible: each hop looks reasonable alone but multiplies end to end. Responders can name the routes and overrides that produce the largest total attempt count.",
          quality: "good",
        },
        {
          id: "app-libraries",
          label: "Audit application retry libraries only.",
          consequence:
            "The application code may be clean while the proxy still retries every hop. Missing the mesh layer leaves the largest multiplier in place.",
          quality: "mixed",
        },
        {
          id: "blame-dependency",
          label: "Treat the dependency as the root cause and wait for its team to fix latency.",
          consequence:
            "The dependency is slow, but the platform's own retry policy is what converts slowness into triple traffic. Waiting leaves callers amplifying and delays recovery for both teams.",
          quality: "poor",
        },
      ],
      debrief:
        "Retry amplification is multiplicative, not additive. Each hop's attempt count multiplies the work done downstream, so a policy that looks mild at one service can be severe across a chain. Measure attempts and outcomes at every proxy hop, then compare the platform default with the overrides that services have added over time.",
    },
    {
      id: "ownership",
      prompt: "What ownership model keeps retry policy from drifting back into amplification?",
      options: [
        {
          id: "platform-contract",
          label: "Platform owns defaults and the global budget; overrides need a documented reason and a retry-ratio target.",
          consequence:
            "There is one accountable owner for the shared behavior and a review path for exceptions. Retry ratios become visible and can be compared against the contract before an incident.",
          quality: "good",
        },
        {
          id: "team-owned",
          label: "Let every service team configure its own retries with no central visibility.",
          consequence:
            "Local policies optimize for local symptoms and compound globally. The next dependency slowdown recreates the same storm because no one can see the total.",
          quality: "poor",
        },
        {
          id: "no-retries",
          label: "Disable retries for every route in the mesh.",
          consequence:
            "Amplification disappears, but so does resilience to brief, independent failures. Availability drops for transient errors that a bounded policy would have absorbed.",
          quality: "poor",
        },
      ],
      debrief:
        "A retry setting is a shared contract because its cost is paid by downstream services. The platform should own the default and the total budget, while service teams can request exceptions with evidence and an expiry date. Review actual retry ratios against the contract, not just the configuration file.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A shared pricing dependency slowed. Each mesh hop retried up to three times, so a request crossing several services could produce dozens of attempts. Retries saturated the dependency and then the healthy services in front of it, while per-service dashboards showed normal inbound rates and no team owned the aggregate.",
    },
    { type: "h3", text: "Why it amplified" },
    {
      type: "list",
      items: [
        "The mesh default applied retries at every hop, and no one modeled the multiplicative effect across a call chain.",
        "Per-service overrides accumulated without a global budget or review.",
        "Service dashboards measured inbound requests, not retry attempts or total downstream work.",
        "Ownership was split between the platform team and service teams, with no shared target for retry ratio.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "The platform owns mesh retry defaults and a global retry budget.",
        "Overrides require a documented reason, an owner, and a retry-ratio target.",
        "Dashboards show attempts per hop and total attempts per request path.",
        "A dependency-slowdown game day verifies that the budget actually bounds amplification.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "Every retry is a bet that the next attempt will succeed and that the dependency can absorb it. In a mesh, that bet is placed at every hop, so local settings become a system-wide load policy. The fix is not to remove retries but to bound the total, measure the multiplier, and give the shared default a named owner.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, attempt counts, and traffic observations in this file are illustrative. They describe a composite scenario, not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Router filter and retry configuration",
      url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/router_filter",
      publisher: "Envoy Project",
      kind: "docs",
      note: "Per-try timeouts, retry policies, and retry budgets in a proxy.",
    },
    {
      title: "VirtualService HTTP retries",
      url: "https://istio.io/latest/docs/reference/config/networking/virtual-service/",
      publisher: "Istio",
      kind: "docs",
      note: "Mesh-level retry attempts, timeouts, and per-route overrides.",
    },
    {
      title: "Timeouts, retries, and backoff with jitter",
      url: "https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/",
      publisher: "AWS Builders' Library",
      kind: "docs",
      note: "Retry amplification, budgets, backoff, and jitter.",
    },
    {
      title: "Addressing cascading failures",
      url: "https://sre.google/sre-book/addressing-cascading-failures/",
      publisher: "Google SRE",
      kind: "book",
      note: "Retry storms and load management during dependency failure.",
    },
  ],
};

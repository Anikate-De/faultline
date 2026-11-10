import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "DNS failover whose recovery tail exceeded the RTO",
  accuracyNote:
    "This is an original composite case file, not a real incident and not a real company incident. It combines common DNS, resolver-cache, runtime-cache, and RTO-measurement failure modes into one representative scenario. It does not describe any company's architecture, dates, traffic, or internal decisions. All relative times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "The primary entry point fails",
      body: "The public entry point for the primary region begins refusing connections. The standby region is healthy and has been serving a small share of traffic for weeks.",
      tone: "warn",
    },
    {
      at: "T+00:02",
      title: "The record is repointed",
      body: "On-call changes the service record to the standby address with a 30-second TTL. The authoritative zone serves the new answer immediately.",
      tone: "info",
    },
    {
      at: "T+00:04",
      title: "Failover is announced as complete",
      body: "The routing change has propagated from the authoritative servers, and synthetic checks against the new address pass. The status page reports that traffic has failed over.",
      tone: "success",
    },
    {
      at: "T+00:09",
      title: "A subset of clients keeps failing",
      body: "Overall success improves, then plateaus. Roughly a third of requests still arrive at the failed primary address, spread across a long tail of client networks and runtimes.",
      tone: "danger",
    },
    {
      at: "T+00:16",
      title: "The cache window explains the gap",
      body: "The record carried a one-hour TTL until a change window fifteen minutes before the incident lowered it. Resolvers that fetched the old answer still hold it, and some application runtimes cache addresses independently of DNS.",
      tone: "warn",
    },
    {
      at: "T+00:23",
      title: "The old address is kept useful",
      body: "The former entry point is kept reachable with a fast redirect to the standby. Internal clients are restarted in jittered batches so they re-resolve without arriving together.",
      tone: "info",
    },
    {
      at: "T+00:44",
      title: "Most clients recover",
      body: "Client success passes ninety-five percent as the largest resolver cohorts expire. Support volume falls, but a small set of long-lived connections remains on the old path.",
      tone: "success",
    },
    {
      at: "T+01:08",
      title: "The RTO is missed",
      body: "The last observed cohort recovers more than an hour after the routing change. The fifteen-minute RTO was measured from record update, not from the first successful user request.",
      tone: "danger",
    },
  ],
  decisions: [
    {
      id: "stuck-clients",
      prompt:
        "The record has changed, but a third of clients still reach the failed address. What do you do first?",
      options: [
        {
          id: "keep-old-path",
          label:
            "Keep the old address answering with a fast redirect, and restart internal clients in jittered waves.",
          consequence:
            "Cached clients get a usable response instead of a timeout, and controlled clients re-resolve without a synchronized stampede. The team can measure which resolver cohorts remain instead of guessing.",
          quality: "good",
        },
        {
          id: "revert-record",
          label: "Revert the record to the old address until caches drain.",
          consequence:
            "The change adds a second answer to an already inconsistent cache population. Clients that picked up the standby address may now fail, and the recovery window restarts.",
          quality: "poor",
        },
        {
          id: "zero-ttl",
          label: "Set the record TTL to zero and wait for clients to catch up.",
          consequence:
            "A zero TTL affects future lookups but cannot evict answers already held. It also raises query volume, and some resolvers enforce a minimum TTL, so the expected effect does not arrive.",
          quality: "poor",
        },
      ],
      debrief:
        "Once clients hold an answer, the authoritative zone no longer controls when they stop using it. The useful levers are making the old path harmless, re-resolving clients you control, and measuring the cohorts you cannot control. Reverting or setting TTL to zero mostly creates more cache states to explain.",
    },
    {
      id: "rto-design",
      prompt: "Which change would make the next failover meet its RTO?",
      options: [
        {
          id: "pre-lower",
          label:
            "Pre-lower TTL at least one old-TTL window before planned changes, use health-checked routing, and measure client success.",
          consequence:
            "Resolvers have time to replace their cached answers before the event, and the team sees the recovery tail as it happens. Planned failovers become predictable, though unplanned failures still depend on the TTL already in place.",
          quality: "good",
        },
        {
          id: "global-short-ttl",
          label: "Set every record to a 30-second TTL permanently.",
          consequence:
            "Cached answers expire sooner, but query volume rises and runtime caches still ignore DNS TTL. The change treats one layer as the whole path and does not address pooled connections.",
          quality: "mixed",
        },
        {
          id: "app-config",
          label: "Move failover into application configuration pushed to every service.",
          consequence:
            "The configuration system has its own propagation delay and cache, and some clients will miss the push. The failover path becomes harder to observe without removing the DNS dependency.",
          quality: "poor",
        },
      ],
      debrief:
        "DNS recovery is bounded by the slowest cache in the path, including recursive resolvers, operating-system stubs, language runtimes, and connection pools. The design response is to lower TTL before the event, keep the old endpoint from causing timeouts, and report progress from client success rather than from the control plane.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "The primary entry point failed and the service record moved to a healthy standby in two minutes. The routing change was correct, but clients that had cached the old answer kept using it. Recovery took more than an hour, so the incident missed its RTO even though the DNS operator had done everything the runbook asked.",
    },
    {
      type: "h3",
      text: "Why the tail was long",
    },
    {
      type: "list",
      items: [
        "The TTL was lowered only fifteen minutes before the incident, so many resolvers still held the one-hour answer.",
        "Application runtimes cached resolved addresses beyond the DNS TTL, and connection pools reused established paths.",
        "Failover progress was measured at the authoritative zone, not at client success.",
        "The old address returned timeouts instead of a fast, useful response, which lengthened retries and support load.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Planned changes lower TTL at least two old-TTL windows ahead and restore it only after the observation window.",
        "The old entry point serves a redirect during cutover so cached clients fail fast rather than hang.",
        "Dashboards break success down by resolver and client cohort, with a p95 time-to-recover metric.",
        "Internal clients re-resolve on connection failure and restart in jittered batches during failover.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A DNS record is a pointer with a cache lifetime, not a command. Changing it updates what new lookups see; it does not update what existing clients already believe. Any RTO that depends on DNS must account for the TTL that was in force before the incident, the caches above DNS, and the time it takes clients to notice that their current path is broken. If those bounds exceed the promised RTO, the design needs a faster path than DNS or a smaller scope for the promise.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, percentages, and cache observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "RFC 1034: Domain Names - Concepts and Facilities",
      url: "https://www.rfc-editor.org/rfc/rfc1034",
      publisher: "IETF",
      kind: "standard",
      note: "Authoritative data, caching, and TTL behavior.",
    },
    {
      title: "RFC 2308: Negative Caching of DNS Queries",
      url: "https://www.rfc-editor.org/rfc/rfc2308",
      publisher: "IETF",
      kind: "standard",
      note: "Why failed lookups can also be cached and extend recovery.",
    },
    {
      title: "Time to Live (TTL)",
      url: "https://www.cloudflare.com/learning/cdn/glossary/time-to-live-ttl/",
      publisher: "Cloudflare Learning Center",
      kind: "docs",
      note: "How TTL controls cache lifetime and why lowering it is not retroactive.",
    },
    {
      title: "Choosing a routing policy",
      url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html",
      publisher: "Amazon Route 53 Documentation",
      kind: "docs",
      note: "Health-checked and failover routing options at the DNS layer.",
    },
  ],
};

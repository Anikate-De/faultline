import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Client-side DNS cache and connection reuse after an endpoint cutover",
  accuracyNote:
    "This is an original composite scenario, not a real incident and not a real company incident. It combines common DNS cutover, runtime-cache, and connection-pool failure modes into one representative scenario. It does not describe any company's architecture, traffic, dates, or internal decisions. All times are relative and all telemetry is illustrative.",
  architecture: { id: "request-path" },
  timeline: [
    {
      at: "T+00:00",
      title: "The service record moves to a new endpoint",
      body: "The authoritative record is updated from the old load balancer address to a new one. The record TTL is 60 seconds, and most clients are expected to follow the change within a few minutes.",
      tone: "info",
    },
    {
      at: "T+00:03",
      title: "Most traffic shifts",
      body: "New connections from the application fleet and external clients reach the new endpoint. Error rates are close to baseline, and the old endpoint receives mostly residual traffic.",
      tone: "success",
    },
    {
      at: "T+00:12",
      title: "One service tier keeps failing",
      body: "A Java-based service reports connection timeouts. Its instances are healthy, the new endpoint is healthy, and other clients resolve the name correctly. The failure is isolated to one runtime family.",
      tone: "warn",
    },
    {
      at: "T+00:25",
      title: "The record checks out",
      body: "Authoritative and recursive resolvers both return the new address. A request from an operator workstation succeeds. The evidence seems to contradict the failing service.",
      tone: "info",
    },
    {
      at: "T+00:40",
      title: "The process is using the old address",
      body: "A socket inspection shows established connections to the old endpoint. A diagnostic endpoint reveals that the process resolved the name once and cached the positive answer indefinitely; it never asked again.",
      tone: "danger",
    },
    {
      at: "T+00:52",
      title: "Cache TTL and pooled connections are corrected",
      body: "The runtime is configured with a finite positive cache TTL, and instances are restarted in a rolling sequence. Pooled connections are drained so that old sockets are not reused after the restart.",
      tone: "warn",
    },
    {
      at: "T+01:15",
      title: "The tier recovers",
      body: "Restarted instances resolve the new address and connect successfully. Error rates return to baseline, while untouched instances continue serving until their turn in the rollout.",
      tone: "success",
    },
    {
      at: "T+02:30",
      title: "Cutovers gain a runtime checklist",
      body: "The team adds per-runtime DNS behavior, connection reuse, and cache settings to the endpoint migration checklist, along with a dual-address overlap period.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "why-one-client",
      prompt: "The DNS record is correct and other clients recovered, but one runtime still fails. What do you check?",
      options: [
        {
          id: "resolved-and-connected",
          label: "Compare the address that process resolves with the destinations of its established connections.",
          consequence:
            "The process is shown to be using a cached answer or an old socket, which explains why the authoritative record and its behavior disagree. Recovery can target that cache and those connections.",
          quality: "good",
        },
        {
          id: "recheck-record",
          label: "Recheck the record and TTL at multiple public resolvers.",
          consequence:
            "The record is already correct, so this confirms healthy infrastructure but not client behavior. The failing process remains unexplained while the investigation loops.",
          quality: "mixed",
        },
        {
          id: "rollback-record",
          label: "Roll the record back to the old address so the failing tier recovers.",
          consequence:
            "The failing tier may recover, but clients that already moved to the new endpoint are sent back. The rollback adds another cache lifetime to an already prolonged cutover.",
          quality: "poor",
        },
      ],
      debrief:
        "DNS is a distributed cache with many independent caches. The authoritative answer is only one view. A client can hold a positive answer in process memory and can hold a usable socket to an old address. Comparing resolved addresses with actual connection destinations separates a resolver problem from a runtime-cache or connection-reuse problem.",
    },
    {
      id: "lasting-cutover",
      prompt: "What change makes future endpoint cutovers recover predictably across runtimes?",
      options: [
        {
          id: "ttl-and-overlap",
          label: "Set finite per-runtime DNS cache TTLs, drain pools on restart, and overlap old and new endpoints.",
          consequence:
            "Every runtime has a bounded cache lifetime, restarts do not resurrect old sockets, and the overlap keeps both addresses valid while caches converge. Recovery becomes a known sequence.",
          quality: "good",
        },
        {
          id: "lower-record-ttl",
          label: "Lower the record TTL and rely on clients to respect it.",
          consequence:
            "Well-behaved resolvers converge faster, but a process that caches forever or reuses a socket is unaffected. The fix addresses the shared layer and ignores the actual stragglers.",
          quality: "mixed",
        },
        {
          id: "restart-everything",
          label: "Restart every service immediately after the record change.",
          consequence:
            "Restarts clear caches, but a synchronized restart creates a load spike and disrupts unrelated traffic. The underlying unbounded cache setting remains for the next cutover.",
          quality: "poor",
        },
      ],
      debrief:
        "DNS recovery is bounded by the slowest cache, not by the record TTL. Each runtime needs an explicit finite cache policy, and connection pools need draining so old sockets do not outlive the name change. An overlap window keeps both endpoints valid while clients converge. Restarting everything can force convergence, but it is a blunt instrument that leaves the cause in place.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "An endpoint moved and the DNS record was updated correctly. Most clients followed within minutes, but one Java-based service had a runtime cache configured to retain positive lookups indefinitely, and it also reused established connections. The process kept using the old address while every DNS check reported the new one.",
    },
    {
      type: "h3",
      text: "Why it was hard to see",
    },
    {
      type: "list",
      items: [
        "The authoritative record and public resolvers were healthy, so DNS appeared to be fixed.",
        "No metric showed which address a process had resolved or where its sockets were connected.",
        "The runtime cache setting was inherited from a base image and undocumented.",
        "Pooled connections kept old destinations alive even after the name would have been re-resolved.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Runtimes use an explicit finite DNS cache TTL, reviewed with the base image.",
        "Cutover runbooks include a rolling restart and connection-pool drain per runtime family.",
        "Old and new endpoints overlap long enough for the slowest client cache to expire.",
        "Dashboards show resolved address and connection destination for critical services.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A DNS change is complete only when clients use it. Resolver TTL, process-level caching, and connection reuse are three separate lifetimes. The slowest one sets the recovery time. Cutovers should assume that some client will ignore the new answer, keep the old endpoint valid during the overlap, and give operators a way to see which address a process is actually using.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, TTLs, and connection observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Networking properties",
      url: "https://docs.oracle.com/en/java/javase/21/core/networking-properties.html",
      publisher: "Oracle",
      kind: "docs",
      note: "JVM DNS cache settings, including networkaddress.cache.ttl.",
    },
    {
      title: "RFC 1035: Domain names, implementation and specification",
      url: "https://www.rfc-editor.org/rfc/rfc1035",
      publisher: "IETF",
      kind: "standard",
      note: "DNS resolution and caching semantics.",
    },
    {
      title: "DNS TTL and record changes",
      url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-values-basic.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "How TTL affects resolver caching after a record change.",
    },
  ],
};

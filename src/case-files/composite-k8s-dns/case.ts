import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Intermittent DNS resolution timeouts under load",
  accuracyNote:
    "This is an original composite scenario and not a real incident. It combines common Kubernetes DNS search-path, CoreDNS capacity, and query-amplification failure modes into one representative case. It does not describe any company's architecture, traffic, dates, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "Service names start timing out",
      body: "At peak traffic, a fraction of requests fail while resolving a short service name. The application reports lookup timeouts against cluster DNS. Requests to a direct pod IP still succeed, so the network path and the destination process are reachable.",
      tone: "warn",
    },
    {
      at: "T+00:30",
      title: "Restarting the application makes it worse",
      body: "The team restarts the application pods to clear the errors. New pods start with empty DNS caches, and their first lookups arrive together. The DNS error rate rises instead of falling.",
      tone: "danger",
    },
    {
      at: "T+01:15",
      title: "The resolver configuration explains the multiplier",
      body: "A debug pod shows ndots set to five and a search list with the namespace, service, and cluster domains. A short name expands into several queries before the absolute name is tried. A fully qualified name with a trailing dot resolves quickly.",
      tone: "warn",
    },
    {
      at: "T+02:00",
      title: "CoreDNS is saturated and throttled",
      body: "CoreDNS runs two replicas with a low CPU limit. Query rate is several times the request rate, and both replicas show sustained CPU throttling. Some UDP queries are dropped, so clients wait for a timeout and retry.",
      tone: "danger",
    },
    {
      at: "T+02:40",
      title: "More DNS capacity helps, but only partly",
      body: "The team scales CoreDNS to five replicas and raises its CPU limit. Timeouts become less frequent, but the query volume is still amplified and the next traffic spike fills the new capacity.",
      tone: "warn",
    },
    {
      at: "T+04:00",
      title: "Query volume is reduced at the source",
      body: "The application sets ndots to two for names it always writes in full, and callers add trailing dots to external names. Query volume falls by more than half, CoreDNS throttling clears, and lookup latency returns to normal.",
      tone: "success",
    },
    {
      at: "T+1 day",
      title: "DNS gets its own service level",
      body: "CoreDNS autoscaling follows query rate and CPU, NodeLocal DNSCache is deployed on the busiest nodes, and alerts cover DNS error rate, latency, and throttling rather than only application errors.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-split",
      prompt:
        "A service name times out under load, but a direct pod IP works. What is the first split?",
      options: [
        {
          id: "resolver-test",
          label:
            "From an affected pod, compare a short name, a trailing-dot fully qualified name, and a direct pod IP, then read the resolver configuration and CoreDNS health.",
          consequence:
            "The test separates name resolution from routing and application behavior. The short name fails, the fully qualified name succeeds, and the resolver configuration shows why query volume is amplified.",
          quality: "good",
        },
        {
          id: "restart-app",
          label: "Restart the application pods to clear stale connections.",
          consequence:
            "New pods lose their DNS caches and issue synchronized lookups. A resolution problem becomes a larger resolution problem, while the underlying query amplification is untouched.",
          quality: "poor",
        },
        {
          id: "check-endpoints",
          label: "Check Service endpoints and proxy rules first.",
          consequence:
            "The check is useful for routing failures, but a working pod IP already shows that the destination is reachable. Time spent on routing delays the resolver test that the evidence points to.",
          quality: "mixed",
        },
      ],
      debrief:
        "DNS resolution and Service routing are separate layers. Resolution turns a name into an address; routing moves the packet to a pod. A direct pod IP working proves the network path and the server, while a failing name points to the resolver, its search path, or DNS capacity. The split is cheap and should come before any restart, because restarts add cold caches and synchronized queries.",
    },
    {
      id: "durable-fix",
      prompt: "What combination should prevent the next DNS-driven latency incident?",
      options: [
        {
          id: "reduce-and-scale",
          label:
            "Reduce query amplification with trailing-dot names or a lower ndots, right-size and scale CoreDNS, cache the hot names, and monitor DNS latency.",
          consequence:
            "Each lookup generates fewer queries, and the remaining queries have capacity and cache behind them. The fix addresses both the multiplier and the ceiling.",
          quality: "good",
        },
        {
          id: "client-timeout",
          label: "Raise client DNS timeouts and retry counts only.",
          consequence:
            "Requests wait longer and retries add more queries to an already saturated service. The symptom moves from fast failure to slow failure without reducing load.",
          quality: "poor",
        },
        {
          id: "one-big-replica",
          label: "Replace CoreDNS with one larger replica.",
          consequence:
            "Capacity may rise, but a single replica removes redundancy and a restart takes DNS down for every pod. The amplified query volume still consumes the larger budget.",
          quality: "poor",
        },
      ],
      debrief:
        "DNS query amplification is the multiplier; CoreDNS capacity is the ceiling. A name with fewer dots than ndots is tried against every search domain before the absolute name, so one application lookup can become several DNS queries. Trailing dots force an absolute lookup, and a lower ndots changes the threshold for names written in full. Scaling CoreDNS and caching handle the remaining volume. Both sides matter: capacity alone is consumed again by amplification, and resolver changes alone leave no headroom for a cold cache.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "At peak traffic, short service-name lookups began to time out. Direct pod IPs worked, which placed the fault in name resolution rather than the network path. Pods used the default search list with ndots set to five, so short names and names written with a few dots generated several queries before the absolute name. CoreDNS had only two replicas and a low CPU limit, and the amplified query rate pushed it into sustained throttling and dropped UDP queries.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "The default ndots value expanded short names and partially qualified names into multiple queries.",
        "CoreDNS had two replicas and a low CPU limit, with no autoscaling on query rate.",
        "Restarting the application created cold caches and synchronized first lookups.",
        "Application dashboards showed request errors but not DNS query rate, latency, or CoreDNS throttling.",
        "Client retries added more queries while the resolver was already saturated.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Applications use trailing-dot fully qualified names or a lower ndots for names they always write in full.",
        "CoreDNS runs with a CPU request that reflects peak query load and scales on query rate and CPU.",
        "NodeLocal DNSCache is deployed on the busiest node pools to absorb repeated lookups.",
        "Alerts cover DNS error rate, lookup latency, and CoreDNS throttling alongside application errors.",
        "Load tests include a cold-cache DNS phase so query amplification appears before production.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "DNS is a shared dependency on the request path, and it fails in a way that looks like application latency. The first split is always resolution versus routing versus the application. Once the fault is in resolution, inspect the resolver configuration before adding capacity, because search paths can multiply every lookup. Capacity and caching are still necessary, but they should sit behind a query budget that does not grow with the number of names a client writes.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, replica counts, query rates, and latency values in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "DNS for Services and Pods",
      url: "https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Service DNS names, search paths, ndots, and pod DNS configuration.",
    },
    {
      title: "Debugging DNS Resolution",
      url: "https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Testing lookups from a pod and inspecting resolver behavior.",
    },
    {
      title: "Customizing DNS Service",
      url: "https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Configuring pod DNS policy, search domains, and ndots.",
    },
    {
      title: "Using NodeLocal DNSCache in Kubernetes Clusters",
      url: "https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Node-local caching to reduce DNS latency and load.",
    },
    {
      title: "Autoscale the DNS Service in a Cluster",
      url: "https://kubernetes.io/docs/tasks/administer-cluster/dns-horizontal-autoscaling/",
      publisher: "Kubernetes",
      kind: "docs",
      note: "Scaling CoreDNS with cluster size and load.",
    },
  ],
};

import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Synchronized cache expiry that saturated the origin database",
  accuracyNote:
    "This is an original composite case file, not a real incident and not a real company incident. It combines common cache-expiry, stampede, and origin-overload failure modes into one representative scenario. It does not describe any company's architecture, dates, traffic, or internal decisions. All relative times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "A popular key expires",
      body: "A deployment has just rewritten the cache with a uniform ten-minute TTL. The most-read configuration key, present on every instance, expires at the same moment the morning traffic ramp begins.",
      tone: "warn",
    },
    {
      at: "T+00:02",
      title: "Misses reach the database",
      body: "Requests that would normally hit the cache now query the origin. Database CPU reaches one hundred percent, and query latency rises from tens of milliseconds to seconds.",
      tone: "danger",
    },
    {
      at: "T+00:04",
      title: "The pool fills",
      body: "Application connection pools are exhausted by queries waiting on the database. New requests time out before they can even acquire a connection, and error rate climbs.",
      tone: "danger",
    },
    {
      at: "T+00:07",
      title: "The pattern is identified",
      body: "Miss rate is many times the normal rate for a small set of keys, all with the same expiry time. The cache is healthy; the problem is that every instance is asking the origin for the same values at once.",
      tone: "warn",
    },
    {
      at: "T+00:11",
      title: "Coalescing and stale serving are enabled",
      body: "The application enables single-flight for cache misses and allows the most popular keys to serve a bounded stale value while one request refreshes. Database CPU falls and the connection pool begins to drain.",
      tone: "success",
    },
    {
      at: "T+00:18",
      title: "Error rate returns to baseline",
      body: "Most requests are served from cache again, and the origin has capacity for the remaining misses. The team keeps the stale window in place while it prepares a safer expiry policy.",
      tone: "success",
    },
    {
      at: "T+00:50",
      title: "TTLs are spread",
      body: "New writes use a randomized TTL around the ten-minute target. A background refresh begins before expiry for keys above a request threshold.",
      tone: "info",
    },
    {
      at: "T+02:10",
      title: "The next expiry is quiet",
      body: "Keys continue to expire, but no single minute produces a spike. The database stays within its normal range and the incident is closed.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-mitigation",
      prompt:
        "The database is at one hundred percent CPU and every instance is missing the same key. What is the first move?",
      options: [
        {
          id: "coalesce",
          label:
            "Enable request coalescing and let the hot keys serve a bounded stale value during refresh.",
          consequence:
            "Only one request per instance refreshes a key, and the rest are served immediately. Origin load falls within seconds, at the cost of briefly serving a value that may be seconds old.",
          quality: "good",
        },
        {
          id: "scale-db",
          label: "Add database read capacity as the primary response.",
          consequence:
            "New replicas take time to provision and may not be in the read path for every query. The miss traffic keeps arriving while capacity is added, and the origin may remain saturated.",
          quality: "mixed",
        },
        {
          id: "flush-cache",
          label: "Flush the cache so all instances start from a clean state.",
          consequence:
            "Flushing removes every remaining hit and sends the full working set to the database at once. It converts a partial miss storm into a complete one.",
          quality: "poor",
        },
      ],
      debrief:
        "The immediate problem is duplicate work, so the first control should collapse duplicate requests. Single-flight reduces the origin to one refresh per key, and a bounded stale window keeps users served while that refresh completes. Adding capacity can help later, but it does not stop thousands of identical queries arriving now.",
    },
    {
      id: "recurrence",
      prompt: "How do you prevent the next synchronized expiry?",
      options: [
        {
          id: "jitter-refresh",
          label: "Randomize TTLs and refresh high-traffic keys probabilistically before expiry.",
          consequence:
            "Expirations spread across time, and popular keys are refreshed while they are still being served. The cache stays warm without a coordinated burst, though freshness becomes a distribution rather than a fixed instant.",
          quality: "good",
        },
        {
          id: "longer-ttl",
          label: "Raise the TTL to one hour for every key and leave the expiry pattern unchanged.",
          consequence:
            "Expirations become less frequent, but they still cluster, and the blast radius of stale data grows. The next deploy that rewrites the cache recreates the same synchronized event.",
          quality: "mixed",
        },
        {
          id: "no-expiry",
          label: "Remove expiry from the popular keys and rely on explicit updates.",
          consequence:
            "The stampede disappears for those keys, but a missed update can leave stale data indefinitely. The system now depends on every writer remembering to invalidate the right entries.",
          quality: "poor",
        },
      ],
      debrief:
        "The root cause is synchronization, not the TTL length. Jitter spreads expiry, and early refresh moves the work to a moment when the value is still useful. Raising the TTL only changes the interval; removing expiry trades a load problem for a correctness problem.",
    },
    {
      id: "stale-policy",
      prompt: "What should happen when a hot key is expired and the refresh is slow?",
      options: [
        {
          id: "bounded-stale",
          label: "Serve the last known value for a short, explicit window while one refresh runs.",
          consequence:
            "Users get a fast response, the origin sees one query, and the staleness is bounded and observable. The application must tolerate a value that is briefly behind.",
          quality: "good",
        },
        {
          id: "fail-fast",
          label: "Return an error immediately so no stale value is ever served.",
          consequence:
            "The origin is protected from duplicate work, but a slow refresh becomes a user-visible failure. Availability is traded for strict freshness even when the data is safe to reuse briefly.",
          quality: "poor",
        },
        {
          id: "stale-forever",
          label: "Serve the last known value until a refresh succeeds, with no time limit.",
          consequence:
            "Availability is preserved, but a failed refresher can serve old data indefinitely. Users may see prices, flags, or configuration that no longer match the source of truth.",
          quality: "poor",
        },
      ],
      debrief:
        "Stale data is a valid availability tool only when its age is bounded and visible. A short window with a single refresh protects both the origin and the user. Without a bound, the cache stops being a cache and becomes an unversioned copy of the data.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A deployment rewrote a popular cache entry with a uniform ten-minute TTL. When it expired, every application instance missed at once and queried the database for the same value. The origin saturated, connection pools filled, and user-facing errors followed. Coalescing and bounded stale serving restored service; jittered TTLs and early refresh prevented a repeat.",
    },
    {
      type: "h3",
      text: "Why it cascaded",
    },
    {
      type: "list",
      items: [
        "TTLs were assigned uniformly at write time, so a large set of keys expired together.",
        "The cache client had no single-flight, so each concurrent miss became a separate origin query.",
        "Connection pools were sized for normal query latency, not for a miss storm.",
        "The cache cluster's health metrics were green, which made the incident look like a database problem.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "TTLs receive randomized jitter, and high-traffic keys refresh before expiry.",
        "Single-flight is enabled for all cache misses, with a bounded stale-while-revalidate window.",
        "Dashboards pair cache hit rate with origin query rate and per-key miss concentration.",
        "Database pools include a queue timeout and load shedding so a miss storm cannot consume every connection.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A cache is a load amplifier in reverse: when it works, it removes most origin traffic; when many entries expire together, it returns that traffic in a burst. The controls are layered because no single one covers the whole event. Coalescing limits duplicate work now, jitter prevents the next synchronized expiry, and early refresh keeps popular values warm. Capacity is the last resort, not the first response.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, CPU figures, and miss rates in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Caching challenges and strategies",
      url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies/",
      publisher: "AWS Builders' Library",
      kind: "docs",
      note: "Cache stampedes, hot keys, and origin protection.",
    },
    {
      title: "EXPIRE",
      url: "https://redis.io/docs/latest/commands/expire/",
      publisher: "Redis Documentation",
      kind: "docs",
      note: "Key expiry semantics and TTL behavior.",
    },
    {
      title: "Optimal Probabilistic Cache Stampede Prevention",
      url: "https://arxiv.org/abs/1505.01233",
      publisher: "arXiv",
      kind: "docs",
      note: "Probabilistic early refresh and the XFetch approach.",
    },
    {
      title: "Addressing Cascading Failures",
      url: "https://sre.google/sre-book/addressing-cascading-failures/",
      publisher: "Google SRE",
      kind: "book",
      note: "How synchronized load and shared pools turn a local miss into an outage.",
    },
  ],
};

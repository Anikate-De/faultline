import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Hot-key skew that saturated one cache shard at peak",
  accuracyNote:
    "This is an original composite case file, not a real incident and not a real company incident. It combines common hot-key, cache-skew, local-cache, and key-splitting failure modes into one representative scenario. It does not describe any company's architecture, dates, traffic, or internal decisions. All relative times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "Peak traffic arrives",
      body: "A scheduled promotion more than doubles catalog read traffic. The cache cluster is healthy in aggregate, and the hit rate remains above ninety-five percent.",
      tone: "info",
    },
    {
      at: "T+00:06",
      title: "One shard saturates",
      body: "Shard seven reaches ninety-five percent CPU while the other shards sit near thirty. Read p99 for the catalog path crosses the SLO, but the cluster-wide average barely moves.",
      tone: "warn",
    },
    {
      at: "T+00:12",
      title: "The skew is measured",
      body: "Per-key sampling shows that a single promotion key accounts for roughly half of all reads and hashes to shard seven. The key is small, read-only, and changed once per promotion, so the concentration is entirely in request volume.",
      tone: "danger",
    },
    {
      at: "T+00:17",
      title: "A local cache absorbs the reads",
      body: "Each application instance adds a one-second in-process cache for the promotion key and coalesces concurrent misses. Shard seven falls to sixty percent CPU, and p99 returns inside the SLO with at most one second of staleness.",
      tone: "success",
    },
    {
      at: "T+00:55",
      title: "The promotion continues safely",
      body: "Traffic stays at peak, and the local cache keeps the shard below its warning threshold. The team deliberately leaves the change in place while it designs a fix that does not depend on every instance's memory.",
      tone: "info",
    },
    {
      at: "T+01:40",
      title: "Key replication is prepared",
      body: "The team writes the value under several suffixed variants and updates readers to choose a variant at random. A fallback to the unsuffixed key covers the transition and any stale variant.",
      tone: "info",
    },
    {
      at: "T+03:20",
      title: "The hot key is spread",
      body: "Salted reads distribute across all shards. Shard seven settles near fifty percent CPU, the other shards rise slightly, and the promotion key no longer dominates any single node.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-mitigation",
      prompt:
        "One shard is at ninety-five percent CPU and the SLO is burning. What do you do first?",
      options: [
        {
          id: "local-cache",
          label: "Add a short-TTL in-process cache for the hot key with request coalescing.",
          consequence:
            "Most repeated reads never reach the shard, so its CPU falls within seconds. The cost is bounded staleness, which is acceptable for a promotion value that changes rarely.",
          quality: "good",
        },
        {
          id: "add-replicas",
          label: "Add read replicas for the saturated shard and spread reads across them.",
          consequence:
            "Replication can add read capacity, but the client must route to replicas and the new nodes need time to provision and fill. The single key's load may still concentrate on whichever node serves it.",
          quality: "mixed",
        },
        {
          id: "reshard",
          label: "Reshard the cluster so the hot key lands on a less busy node.",
          consequence:
            "Moving the key relocates the same concentrated load to another node and requires slot migration while the cluster is at peak. The operation is slow and can add errors before it helps.",
          quality: "poor",
        },
      ],
      debrief:
        "A hot key is a request-distribution problem, not a cluster-size problem. Resharding changes which node receives the load, not how concentrated it is. A short local cache with coalescing removes most of the repeated work immediately, and one second of staleness is usually an acceptable trade for a read-mostly value.",
    },
    {
      id: "durable-fix",
      prompt: "Which durable change best fits a read-heavy key that changes rarely?",
      options: [
        {
          id: "key-replication",
          label:
            "Replicate the value under multiple suffixed keys and have readers choose one at random.",
          consequence:
            "Read load spreads across shards without changing the value's semantics. Writes must update every variant or tolerate a short mixed-version window, which is manageable for rare updates.",
          quality: "good",
        },
        {
          id: "keep-local",
          label: "Keep the one-second local cache as the permanent fix for every read path.",
          consequence:
            "It protects the shard but makes freshness depend on instance clocks and memory, and every fleet change alters the hit pattern. Other keys with different consistency needs may not tolerate the same TTL.",
          quality: "mixed",
        },
        {
          id: "bigger-shard",
          label: "Move the key to a larger instance type and leave the access pattern unchanged.",
          consequence:
            "The shard gets more headroom, but the next traffic increase recreates the same concentration. Cost rises and the architecture still has a single-key failure domain.",
          quality: "mixed",
        },
      ],
      debrief:
        "The durable options trade consistency, write cost, and migration effort. Key replication fits a read-heavy value because it spreads reads without moving data between nodes and keeps the write path manageable. A permanent local cache is a useful layer, but it should not be the only control for a key whose blast radius is one shard.",
    },
    {
      id: "update-path",
      prompt: "How should updates behave once reads use salted variants?",
      options: [
        {
          id: "versioned-dual-write",
          label:
            "Write all variants with a version and have readers fall back when a variant is missing or older.",
          consequence:
            "Readers see a consistent value or a safe fallback, and a partial write cannot expose an old value indefinitely. The write path is more expensive, but updates are rare.",
          quality: "good",
        },
        {
          id: "single-write",
          label: "Write only the primary key and let the variants expire naturally.",
          consequence:
            "Readers may receive different values depending on which variant they choose. The inconsistency lasts for the variant TTL and is hard to reason about during an update.",
          quality: "poor",
        },
        {
          id: "invalidate-all",
          label: "Write one variant and delete the others.",
          consequence:
            "The next reads refill from the origin and may stampede the database. It avoids mixed values but converts a small write into a read spike.",
          quality: "mixed",
        },
      ],
      debrief:
        "Splitting a key moves complexity into the update path. The safe pattern is versioned values plus a fallback to the canonical key, so a partial migration or partial write degrades to a known value rather than to whichever variant a reader happened to choose.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A promotion made one catalog key account for half of all reads. The cache cluster looked healthy in aggregate, but the key hashed to a single shard, which saturated and pushed the read path past its SLO. A one-second local cache with request coalescing restored latency within minutes, and salted key replication removed the concentration later.",
    },
    {
      type: "h3",
      text: "Why it was hard to see",
    },
    {
      type: "list",
      items: [
        "Cluster-wide hit rate and average CPU hid the skew on one shard.",
        "The key was small and read-only, so memory and eviction metrics showed no pressure.",
        "The application's client library did not expose per-key or per-shard request counts.",
        "The promotion was planned, but no one translated its access pattern into a cache placement check.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Dashboards show per-shard CPU and the top keys by request rate, not only cluster averages.",
        "High-fan-out keys are replicated with versioned variants and a canonical fallback.",
        "The cache client supports short local caching and single-flight for designated read-mostly keys.",
        "Promotion reviews include an access-pattern check for keys expected to exceed a shard's share.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Partitioning spreads keys, not load. A single key always lands on one partition unless the application splits it or caches it closer to the reader. Aggregate metrics are especially misleading for hot keys because the concentration is small in cardinality and large in volume. The fastest mitigation is usually to stop sending repeated reads to the shard; the durable fix is to change how the key is addressed.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, percentages, and CPU observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Caching challenges and strategies",
      url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies/",
      publisher: "AWS Builders' Library",
      kind: "docs",
      note: "Hot keys, cache scaling, and protecting the origin.",
    },
    {
      title: "Diagnosing latency issues",
      url: "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/",
      publisher: "Redis Documentation",
      kind: "docs",
      note: "Latency sources and per-shard saturation in a Redis deployment.",
    },
    {
      title: "Redis cluster specification",
      url: "https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/",
      publisher: "Redis Documentation",
      kind: "docs",
      note: "Hash slots, key placement, and why one key maps to one shard.",
    },
    {
      title: "The Tail at Scale",
      url: "https://research.google/pubs/the-tail-at-scale/",
      publisher: "Google Research",
      kind: "docs",
      note: "Tail latency and the effect of a single slow or hot component.",
    },
  ],
};

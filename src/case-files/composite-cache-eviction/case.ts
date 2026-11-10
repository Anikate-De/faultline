import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Cache hit-rate collapse after working-set eviction",
  accuracyNote:
    "This is an original composite scenario and not a real incident. It combines common Redis maxmemory, eviction-policy, TTL, and cache-isolation failure modes into one representative case. It does not describe any company's architecture, traffic, dates, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "The cache is healthy",
      body: "The product cache holds a working set that fits comfortably in memory. Hit rate is 96%, memory use is 72% of maxmemory, and evictions are near zero.",
      tone: "success",
    },
    {
      at: "T+01:00",
      title: "A batch job floods the cache",
      body: "A nightly backfill writes three million short-lived lookup keys. The keys have no expiry, and the job touches far more distinct keys than the interactive workload. Memory reaches maxmemory.",
      tone: "warn",
    },
    {
      at: "T+01:15",
      title: "allkeys-lru evicts the hot set",
      body: "The policy considers every key eligible. Evictions rise above 40,000 per second, and recently written batch keys displace product keys that were being served steadily. Hit rate falls from 96% to 71%.",
      tone: "danger",
    },
    {
      at: "T+01:30",
      title: "The origin absorbs the misses",
      body: "Origin request rate rises to 2.3 times baseline. Database CPU reaches 88%, and p99 for uncached reads crosses the SLO. The cache is still answering, so a simple availability check stays green.",
      tone: "danger",
    },
    {
      at: "T+02:00",
      title: "More memory only buys time",
      body: "The team adds 25% memory. The cache fills again within forty minutes because the batch continues and the working set has grown. The eviction rate returns to its previous level.",
      tone: "warn",
    },
    {
      at: "T+03:00",
      title: "The policy matches the data",
      body: "The batch is paused, and the policy is switched to allkeys-lfu so frequently used product keys are protected from one-off scans. Hit rate recovers to 88% within thirty minutes and continues climbing as frequency counters mature.",
      tone: "success",
    },
    {
      at: "T+1 day",
      title: "The workloads are separated",
      body: "Batch keys receive short TTLs and move to a dedicated cache. Product keys keep a frequency-friendly policy, eviction-rate alerts are added, and the capacity plan includes the measured working set plus headroom.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "immediate-policy",
      prompt:
        "Memory is at maxmemory, evictions are high, and hit rate is falling. The policy is allkeys-lru. What is the best immediate change?",
      options: [
        {
          id: "lfu-and-pause-scan",
          label:
            "Pause the batch scan and switch to allkeys-lfu so frequent keys survive one-off traffic.",
          consequence:
            "Eviction pressure falls immediately, and the frequency policy protects the interactive working set from the scan. Hit rate recovers as counters build, without discarding the cache's availability.",
          quality: "good",
        },
        {
          id: "volatile-lru",
          label: "Switch to volatile-lru without checking which keys have a TTL.",
          consequence:
            "Only keys with an expiry are eligible for eviction. If the hot product keys have no TTL and memory is full, writes can fail with an out-of-memory error instead of evicting anything.",
          quality: "poor",
        },
        {
          id: "add-memory",
          label: "Increase maxmemory and leave the policy and batch behavior unchanged.",
          consequence:
            "The cache gets temporary headroom, but the batch keeps adding non-expiring keys and the working set keeps growing. The same eviction pattern returns, at a higher cost.",
          quality: "mixed",
        },
      ],
      debrief:
        "The immediate question is which keys should be evicted, not just whether there is more memory. allkeys-lru treats a one-off scan key and a frequently requested product key as equally eligible, so scan traffic can pollute the cache and displace the working set. allkeys-lfu uses access frequency to resist that pollution. A volatile policy is only safe when the keys you want to evict actually have TTLs; otherwise Redis has nothing it is allowed to remove and writes fail.",
    },
    {
      id: "lasting-design",
      prompt: "What should protect the hot working set the next time memory fills?",
      options: [
        {
          id: "classify-and-isolate",
          label:
            "Classify data by value and TTL, isolate batch and durable keys, choose a policy per cache, and alert on evictions and hit rate.",
          consequence:
            "Each cache has an eviction policy that matches its data. A scan cannot displace the product working set, and capacity has a measured basis with headroom.",
          quality: "good",
        },
        {
          id: "noeviction",
          label: "Use noeviction so Redis never discards a key.",
          consequence:
            "Hot keys are not evicted, but once memory is full every write that needs more space fails. The cache becomes a read-only store at the worst possible moment.",
          quality: "poor",
        },
        {
          id: "allkeys-random",
          label: "Use allkeys-random to spread evictions evenly.",
          consequence:
            "Eviction is simple and never refuses a write, but it ignores recency and frequency entirely. Hot keys are dropped at random, so hit rate falls even when the working set would otherwise fit.",
          quality: "poor",
        },
      ],
      debrief:
        "Eviction policy is a statement about data value. A pure cache whose entries are recomputable can use an allkeys policy, with LFU when scans would otherwise pollute recency. A cache that shares space with durable or TTL-bearing keys needs isolation, because a single policy cannot protect both classes. If the working set genuinely exceeds memory, no policy fixes it: shard, reduce value size, or add capacity with headroom. Alert on eviction rate and hit rate together, since either one alone can look acceptable while the other is failing.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A nightly batch wrote millions of non-expiring keys into the product cache. Memory reached maxmemory, and the allkeys-lru policy evicted a mix of batch and product keys. The batch kept introducing new keys, so the hot working set was displaced repeatedly. Hit rate collapsed, origin load rose, and the database became the bottleneck.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "The batch shared an instance with the interactive workload and had no TTL discipline.",
        "allkeys-lru made every key eligible, including one-off scan keys.",
        "The first response added memory without changing the growth pattern.",
        "Dashboards showed cache availability but not eviction rate or hit-rate trend.",
        "The working set had no capacity model, so growth was discovered through incidents.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Batch and product workloads use separate caches with policies matched to their data.",
        "Non-expiring batch keys were given short TTLs, and durable keys were moved out of the cache.",
        "The product cache uses allkeys-lfu with a reviewed sampling setting.",
        "Alerts fire on sustained evictions and on hit rate below the service target.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "Maxmemory is a capacity boundary, but the eviction policy decides which data pays for it. allkeys policies can evict hot data because every key is eligible; volatile policies can refuse writes when no eligible key has a TTL. The right choice follows from what the data is worth and whether it can be recomputed. Isolation and TTLs are often more important than the policy name, and no policy substitutes for enough memory to hold the working set.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, rates, and hit-rate values in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Key eviction",
      url: "https://redis.io/docs/latest/develop/reference/eviction/",
      publisher: "Redis",
      kind: "docs",
      note: "Eviction policies, approximate LRU/LFU, and maxmemory behavior.",
    },
    {
      title: "Redis configuration",
      url: "https://redis.io/docs/latest/operate/oss_and_stack/management/config/",
      publisher: "Redis",
      kind: "docs",
      note: "maxmemory, maxmemory-policy, and sampling settings.",
    },
    {
      title: "Managing reserved memory",
      url: "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/redis-reserved-memory.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Memory overhead and capacity planning for managed Redis.",
    },
  ],
};

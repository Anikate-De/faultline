export interface Drill {
  id: string;
  moduleId: string;
  question: string;
  answer: string;
  hints: string[];
}

export const DRILLS: Drill[] = [
  {
    id: "drill-hot-key",
    moduleId: "caching-hot-key-sharding",
    question: "One Redis key receives 40% of traffic across an eight-shard cluster. Walk me through the diagnosis and the first fix.",
    answer:
      "First, confirm it is a hot key and not a cluster-wide problem: compare per-shard CPU, per-key command counts, and p99. If one shard is saturated while the others are idle, resizing the cluster will not help. The first fix depends on the constraint. A local in-process cache removes the most traffic fastest but introduces per-instance staleness. Key salting spreads one key across shards but requires every reader to fan out and a migration. Read replicas offload reads but add lag and can saturate a replica. Pick the smallest change that protects the SLO, state the tradeoff, and measure the hottest shard afterward.",
    hints: [
      "The aggregate hit rate can look healthy while one shard is on fire.",
      "Name the fix and the cost before you name the next fix.",
    ],
  },
  {
    id: "drill-retry-storm",
    moduleId: "foundations-retry-backoff-jitter",
    question: "A dependency returns 503 for two seconds and your platform stays degraded for twenty minutes. What happened, and what do you change first?",
    answer:
      "Synchronized retries amplified the failure. Every caller retried at the same time, so offered load rose while the dependency was least able to serve it. First, reduce retries and add jitter or a retry budget; if the dependency is still failing, open the circuit. Then verify recovery by watching retry volume and upstream error rate, not only the dependency's health check. The tradeoff is that a tighter retry policy makes transient single-request failures visible to users, so pair it with a bounded fallback or a clear error.",
    hints: [
      "The dependency recovered before the platform did.",
      "Retry amplification is a feedback loop, not a capacity problem.",
    ],
  },
  {
    id: "drill-canary",
    moduleId: "deployment-canary-metric-gate",
    question: "A canary at 5% traffic passes error rate and latency. Why can the full rollout still fail, and what gate was missing?",
    answer:
      "A 5% canary does not exercise shared-resource behavior at full scale: caches, locks, connection pools, quotas, and downstream capacity may only saturate when all traffic moves. It also may not have enough samples to detect a rare failure. The missing gate is a capacity or saturation check at the target traffic level, plus a staged rollout that watches the next bottleneck. The tradeoff is longer rollout time and more load-test cost for a smaller blast radius.",
    hints: [
      "Error rate is not the only signal a canary can miss.",
      "Think about what only happens when every request moves.",
    ],
  },
  {
    id: "drill-db-failover",
    moduleId: "reliability-db-failover",
    question: "The database failover completed and the new writer is healthy, but the application is still down. What do you check first?",
    answer:
      "Application recovery is separate from database recovery. Check DNS resolution, pooled connections to the old writer, reconnect storms, and whether clients are retrying with jitter. A new writer can be overwhelmed by every client reconnecting at once. The first move is often to reduce reconnect pressure and route through a proxy or pool, then confirm writes are reaching the new primary. The tradeoff is that a proxy adds a hop and its own failure mode.",
    hints: [
      "The database being healthy does not mean the application has recovered.",
      "What do all clients do at the same moment after failover?",
    ],
  },
];

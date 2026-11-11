# Faultline — Curriculum Review

Review date: 2026-11-10. Source: `docs/MODULE_MANIFEST.md`. Generated metadata: `src/generated/module-manifest.json`.

## 1. Count by track

| Track | Planned | Manifest rows | Delta |
|---|---|---|---|
| Foundations | 32 | 32 | 0 |
| Observability | 34 | 34 | 0 |
| Traffic & Edge | 34 | 34 | 0 |
| Caching | 28 | 28 | 0 |
| Relational Data | 32 | 32 | 0 |
| Document Data | 22 | 22 | 0 |
| Streaming & Messaging | 32 | 32 | 0 |
| Containers & ECS | 26 | 26 | 0 |
| Service Mesh | 22 | 22 | 0 |
| Release Engineering | 28 | 28 | 0 |
| Reliability & Incidents | 32 | 32 | 0 |
| Cloud Networking | 32 | 32 | 0 |
| Compliance & GRC | 20 | 20 | 0 |
| Capacity & Cost | 22 | 22 | 0 |
| Case Files | 64 | 64 | 0 |
| Kubernetes | 16 | 16 | 0 |
| **Total** | **476** | **476** | **0** |

The allocation matches the plan exactly. No track was padded with filler; the three rows that were rescoped during review are recorded in section 4. Only `caching-hot-key-sharding` is authored and implemented at Gate 2; the rest are planned rows.

## 2. Mandatory coverage

Every concept from the curriculum brief maps to at least one module. Canonical modules are listed first.

### Foundations

| Concept | Module(s) |
|---|---|
| USE and RED methods | foundations-use-red |
| Little's Law | foundations-littles-law |
| Queueing theory and the utilization knee | foundations-queueing-knee |
| p50/p95/p99 and tail latency | foundations-percentiles |
| Coordinated omission | foundations-coordinated-omission |
| SLI/SLO/SLA and error budgets | foundations-sli-slo-error-budget; reliability-error-budget-policy |
| Capacity headroom and N+1 | foundations-capacity-headroom; capacity-headroom-cost |
| Idempotency | foundations-idempotency; mongodb-retryable-writes |
| Timeouts | foundations-timeouts; mesh-timeouts |
| Retries, exponential backoff, jitter | foundations-retry-backoff-jitter; mesh-retries |
| Circuit breaking | foundations-circuit-breaking; mesh-circuit-breaking |
| Bulkheads | foundations-bulkheads |
| Load shedding | foundations-load-shedding; reliability-load-shedding |
| Graceful degradation | foundations-graceful-degradation; reliability-graceful-degradation |
| CAP and PACELC | foundations-cap-pacelc |
| Consistency models | foundations-consistency-models |
| Linux CPU saturation | foundations-linux-cpu |
| Linux memory and OOM | foundations-linux-memory |
| Linux disk I/O | foundations-linux-disk-io |
| Linux network saturation | foundations-linux-network-saturation |
| File descriptors | foundations-file-descriptors |
| Conntrack | foundations-conntrack |
| TLS handshake | foundations-tls-handshake; traffic-tls-termination |
| HTTP/2 and keep-alive | foundations-http2-keepalive; traffic-keepalive-idle-timeout |
| Connection pools | foundations-connection-pools; databases-pgbouncer |
| Password hashing (bcrypt/Argon2, salt, cost, timing) | foundations-password-hashing |
| Rate limiting algorithms | foundations-rate-limiting; traffic-edge-rate-limiting |
| Caching strategies and invalidation | foundations-caching-strategies; foundations-cache-invalidation |
| Admission control | foundations-admission-control |

### Observability

| Concept | Module(s) |
|---|---|
| Datadog metrics, logs, traces, tags | observability-datadog-tags; observability-datadog-apm; observability-structured-logging |
| Datadog cardinality and custom metric cost | observability-datadog-tags; observability-datadog-metric-cost; observability-telemetry-cost |
| Grafana and PromQL | observability-promql-rate; observability-promql-histogram-quantile; observability-grafana-dashboard |
| VictoriaMetrics architecture, retention, cardinality, downsampling | observability-victoriametrics-architecture; observability-victoriametrics-cardinality; observability-victoriametrics-retention |
| OpenTelemetry context propagation and sampling | observability-otel-context; observability-otel-head-sampling; observability-otel-tail-sampling |
| Structured logging and PII redaction | observability-structured-logging; observability-pii-redaction |
| Distributed tracing and tail sampling | observability-distributed-tracing; observability-trace-critical-path |
| Golden signals | observability-golden-signals |
| Symptom-based alerts and alert fatigue | observability-symptom-alerting; observability-alert-fatigue |
| SLO burn-rate alerts | observability-slo-burn-rate |
| Anomaly detection pitfalls | observability-anomaly-detection |
| Incident timeline reconstruction | observability-incident-timeline; reliability-timeline |
| Continuous profiling | observability-continuous-profiling |
| Synthetic monitoring | observability-synthetic-monitoring |
| RUM and Web Vitals | observability-rum-web-vitals |
| Dashboard design | observability-grafana-dashboard; observability-dashboard-question |
| Monitoring the monitor | observability-meta-monitoring |
| Error grouping | observability-error-grouping |

### Traffic & Edge

| Concept | Module(s) |
|---|---|
| L4 vs L7 | traffic-l4-vs-l7 |
| ALB and NLB | traffic-alb-target-groups; traffic-nlb-in-front-of-alb |
| Target groups and health checks | traffic-alb-target-groups; traffic-alb-health-checks |
| ALB connection limits and LCU | traffic-alb-connection-limit; traffic-alb-lcu-cost |
| NLB in front of ALB | traffic-nlb-in-front-of-alb |
| ALB sharding by tenant, host, path | traffic-alb-sharding; traffic-host-routing |
| Cross-AZ load balancing and zonal isolation | traffic-cross-zone-lb; traffic-zonal-isolation |
| Sticky sessions and connection draining | traffic-sticky-sessions; traffic-connection-draining |
| DNS TTL, Route 53 health checks, routing policies, failover | traffic-dns-ttl-failover; traffic-route53-health-checks; traffic-route53-routing |
| Anycast | traffic-anycast |
| CDN cache keys, TTL, purge, origin shield, request collapsing | traffic-cdn-cache-keys; traffic-cdn-ttl-purge; traffic-origin-shield |
| Cloudflare and Akamai behavior | traffic-edge-provider-behavior; traffic-anycast |
| WAF, DDoS, Shield, edge rate limits | traffic-waf-rate-limits; traffic-ddos-shield; traffic-edge-rate-limiting |
| HTTP/3 and QUIC | traffic-http3-quic |
| TLS termination | traffic-tls-termination |
| Keep-alive and idle timeout mismatch | traffic-keepalive-idle-timeout |
| Global Accelerator | traffic-global-accelerator |
| Debugging 502/503/504 | traffic-502-debug; traffic-503-debug; traffic-504-debug |
| Rule priority and host routing | traffic-alb-rule-priority; traffic-host-routing |
| WebSockets and gRPC load balancing | traffic-websocket-lb; traffic-grpc-lb |
| Upstream connection reuse | traffic-upstream-connection-reuse |

### Caching

| Concept | Module(s) |
|---|---|
| Redis data types | caching-redis-data-types |
| Persistence (RDB/AOF) | caching-redis-persistence |
| Eviction policies | caching-eviction-policies |
| Hot key detection, hot shard, sharding | caching-hot-key-detection; caching-hot-key-sharding; caching-hot-shard-cluster |
| Key salting | caching-key-salting |
| Read replicas and staleness | caching-read-replicas |
| Stampede and thundering herd | caching-cache-stampede; caching-request-coalescing |
| Probabilistic early expiration and TTL jitter | caching-probabilistic-expiration; caching-ttl-jitter |
| Local cache plus Redis, coherence, invalidation | caching-local-cache; caching-coherence |
| Cache penetration, negative caching, Bloom filters | caching-cache-penetration; caching-negative-caching |
| Redis Cluster slots, resharding, MOVED/ASK | caching-hot-shard-cluster; caching-cluster-resharding |
| Redis vs Memcached | caching-redis-vs-memcached |
| Cache-aside, write-through, write-behind | caching-aside-vs-write-through; caching-write-behind |
| Big keys and slow commands | caching-big-keys; caching-slow-commands |
| Lua and atomicity | caching-lua-atomicity |
| Pool exhaustion and local bypass | caching-connection-pool; caching-local-bypass |
| Memory fragmentation, warming, failover | caching-memory-fragmentation; caching-warming; caching-cluster-failover |

### Relational Data

| Concept | Module(s) |
|---|---|
| RDS/Aurora architecture | databases-rds-aurora-arch |
| Primary/replica and replication lag | databases-primary-replica-lag; databases-replication-threads |
| Read replicas, routing, read-after-write | databases-read-replica-routing; databases-read-after-write |
| Aurora Global Database, cross-region lag, write forwarding | databases-aurora-global; databases-cross-region-rpo; databases-write-forwarding |
| Connection pooling, PgBouncer, RDS Proxy | databases-pgbouncer; databases-rds-proxy |
| Max connections and connection storms | databases-max-connections; databases-connection-storm |
| Failover, DNS, split brain | databases-failover-dns; databases-split-brain |
| Backups, PITR, Aurora Backtrack | databases-backups-pitr; databases-aurora-backtrack |
| DR drills, RTO/RPO, Multi-AZ vs multi-region | databases-dr-drills; databases-multi-az-vs-region |
| Vacuum, bloat, locks, deadlocks, long transactions | databases-vacuum-bloat; databases-locks-deadlocks; databases-long-transactions |
| Indexing, query plans, N+1 | databases-indexing; databases-query-plans; databases-n-plus-one |
| Partitioning, sharding, hot partitions | databases-partitioning; databases-hot-partitions |
| Cross-AZ latency and cost | databases-cross-az-cost |
| Serverless, parameters, storage autoscaling | databases-aurora-serverless; databases-parameter-groups; databases-storage-autoscaling |
| Cold replicas and connection leaks | databases-read-replica-cold; databases-connection-leak |

### Document Data

| Concept | Module(s) |
|---|---|
| Replica sets, elections, oplog | mongodb-replica-set; mongodb-elections; mongodb-replication-lag |
| Read preference and write concern | mongodb-read-preference; mongodb-write-concern; mongodb-read-concern |
| Adding readers, cold secondaries, replication lag | mongodb-adding-readers; mongodb-cold-secondary; mongodb-replication-lag |
| Sharding, shard keys, hot shards | mongodb-sharding; mongodb-shard-key; mongodb-hot-shard |
| Chunk migration and balancer | mongodb-chunk-migration; mongodb-balancer |
| Connection storms, indexes, aggregation | mongodb-connection-storm; mongodb-index-design; mongodb-aggregation-perf |
| Change streams, retryable writes, transactions | mongodb-change-streams; mongodb-retryable-writes; mongodb-transactions |
| Backup/restore, write amplification, mongos | mongodb-backup-restore; mongodb-write-amplification; mongodb-mongos-routing |

### Streaming & Messaging

| Concept | Module(s) |
|---|---|
| Kafka partitions, keys, ordering | streaming-kafka-partitions; streaming-keys-ordering |
| Consumer groups, offsets, rebalancing | streaming-consumer-groups; streaming-rebalancing |
| Hot partition, partition count, retention | streaming-hot-partition; streaming-partition-count; streaming-retention |
| Producer acks, idempotence, ISR | streaming-producer-acks; streaming-idempotent-producer; streaming-kafka-isr |
| Backpressure, lag, slow consumers | streaming-backpressure; streaming-consumer-lag; streaming-slow-consumers |
| Poison messages and DLQ | streaming-poison-messages; streaming-dlq |
| Exactly-once and transactions | streaming-exactly-once; streaming-transactions |
| Confluent Cloud, schema registry, ksqlDB | streaming-confluent-cloud; streaming-schema-registry; streaming-ksqldb |
| WarpStream and object-storage streaming | streaming-warpstream; streaming-object-storage-latency |
| MQTT QoS, retained messages, fan-out, broker scaling | streaming-mqtt-qos; streaming-mqtt-retained; streaming-mqtt-fanout; streaming-mqtt-broker-scaling |
| SQS visibility timeout and FIFO | streaming-sqs-visibility; streaming-sqs-fifo |
| SNS and EventBridge | streaming-eventbridge |
| Outbox and CDC | streaming-outbox; streaming-cdc |
| Queue depth vs latency | streaming-queue-depth |

### Containers & ECS

| Concept | Module(s) |
|---|---|
| Task definitions and services | containers-task-definitions; containers-services |
| Placement, capacity providers, multi-AZ | containers-placement; containers-capacity-providers; containers-multi-az-scheduling |
| Target tracking, step scaling, cooldowns | containers-target-tracking; containers-step-scaling; containers-scaling-cooldowns |
| Circuit breaker and rolling deployments | containers-deployment-circuit-breaker; containers-rolling-deployments |
| Fargate cold starts, image pull, Spot | containers-fargate-cold-start; containers-image-pull; containers-fargate-spot |
| ALB registration and draining | containers-alb-target-registration; containers-draining |
| Exec, logs, health checks | containers-ecs-exec; containers-logs; containers-health-checks |
| Service discovery and Cloud Map | containers-service-discovery; containers-cloud-map |
| CPU/memory limits and OOM | containers-cpu-memory-limits; containers-oom-kills |
| Task IAM roles and secrets | containers-task-iam-roles; containers-secrets |
| Batch vs service and sidecars | containers-batch-vs-service; containers-sidecar-patterns |

### Service Mesh

| Concept | Module(s) |
|---|---|
| Envoy listeners, clusters, routes | mesh-envoy-listeners; mesh-envoy-clusters; mesh-envoy-routes |
| Kuma control plane and policies | mesh-kuma-control-plane; mesh-policy-conflict |
| mTLS and certificate rotation | mesh-mtls; mesh-cert-rotation |
| Retries, timeouts, circuit breaking | mesh-retries; mesh-timeouts; mesh-circuit-breaking |
| Outlier detection and failover | mesh-outlier-detection; mesh-failover |
| Traffic splitting and canary | mesh-traffic-splitting; mesh-canary |
| Access logs and tracing | mesh-access-logs; mesh-tracing |
| Sidecar overhead and ingress | mesh-sidecar-overhead; mesh-ingress |
| Cross-cluster and locality | mesh-cross-cluster; mesh-locality |
| Retry storm and Envoy admin | mesh-retry-storm; mesh-envoy-admin |

### Release Engineering

| Concept | Module(s) |
|---|---|
| Rolling, blue-green, canary | deployment-rolling; deployment-blue-green; deployment-canary |
| Feature flags and metric gates | deployment-feature-flags; deployment-canary-metric-gate |
| Automated rollback | deployment-automated-rollback; deployment-rollback-vs-rollforward |
| Database migrations and expand/contract | deployment-blue-green-db-migration; deployment-expand-contract; deployment-schema-compat |
| Verification and smoke tests | deployment-verification; deployment-smoke-tests |
| Traffic shifting and capacity | deployment-traffic-shifting; deployment-canary-capacity |
| Freeze windows and change management | deployment-freeze-windows; deployment-change-management |
| GitOps, CI/CD, immutability, promotion | deployment-gitops; deployment-cicd; deployment-immutable-artifacts; deployment-artifact-promotion |
| Config drift and build once | deployment-config-drift; deployment-build-once |
| Shadow traffic and dark launch | deployment-shadow-traffic; deployment-dark-launch |
| Deploying during incidents and rollback data loss | deployment-incident-deploy; deployment-rollback-data-loss |
| Deployment frequency and lead time | deployment-frequency; deployment-lead-time |

### Reliability & Incidents

| Concept | Module(s) |
|---|---|
| Incident command, roles, comms cadence | reliability-incident-command; reliability-roles; reliability-comms-cadence |
| Severity, escalation, runbooks, playbooks, checklists | reliability-severity-levels; reliability-escalation; reliability-runbooks; reliability-playbooks; reliability-checklists |
| Blameless postmortems and action items | reliability-blameless-postmortems; reliability-action-items; reliability-postmortem-actions; reliability-incident-review |
| On-call handoff, paging fatigue, error budget policy | reliability-oncall-handoff; reliability-paging-fatigue; reliability-error-budget-policy |
| Chaos engineering and game days | reliability-chaos; reliability-game-days |
| Load shedding, degradation, dependency failure | reliability-load-shedding; reliability-graceful-degradation; reliability-dependency-failure |
| Retry storms, cache failure, DB failover | reliability-retry-storms; reliability-cache-failure; reliability-db-failover |
| Multi-region and DNS failure | reliability-multi-region; reliability-dns-failure |
| Status pages, customer and legal comms | reliability-status-pages; reliability-customer-comms; reliability-legal |
| Decision logs, toil, timeline | reliability-decision-logs; reliability-toil; reliability-timeline |
| Severity matrix | reliability-severity-matrix |

### Cloud Networking

| Concept | Module(s) |
|---|---|
| VPC, subnets, route tables, blackholes | cloud-networking-vpc; cloud-networking-subnets; cloud-networking-route-tables |
| NAT, IGW, security groups, NACLs | cloud-networking-nat-gateway; cloud-networking-igw; cloud-networking-security-groups; cloud-networking-nacls |
| Peering vs Transit Gateway, propagation, asymmetry | cloud-networking-peering-vs-tgw; cloud-networking-route-propagation |
| Cross-account networking and RAM | cloud-networking-cross-account; cloud-networking-ram |
| PrivateLink and VPC endpoints | cloud-networking-privatelink; cloud-networking-vpc-endpoints; cloud-networking-s3-gateway-endpoint |
| Route 53 Resolver and private zones | cloud-networking-route53-resolver; cloud-networking-private-hosted-zones |
| Direct Connect, VPN, BGP | cloud-networking-direct-connect; cloud-networking-vpn; cloud-networking-bgp |
| Cross-AZ/region latency and cost | cloud-networking-cross-az-region; cloud-networking-egress-cost |
| IAM roles, least privilege, confused deputy | cloud-networking-iam-roles; cloud-networking-least-privilege; cloud-networking-confused-deputy |
| KMS, encryption, secrets | cloud-networking-kms; cloud-networking-encryption; cloud-networking-secrets |
| WAF, Shield, zero trust | cloud-networking-waf-shield; cloud-networking-zero-trust |
| Reachability Analyzer, flow logs, NAT scaling | cloud-networking-reachability-analyzer; cloud-networking-flow-logs; cloud-networking-nat-scaling |

### Compliance & GRC

| Concept | Module(s) |
|---|---|
| HIPAA, PHI, BAA | compliance-hipaa; compliance-phi; compliance-baa |
| Access controls and audit logs | compliance-access-controls; compliance-audit-logs |
| GDPR, residency, erasure, DPA | compliance-gdpr; compliance-data-residency; compliance-right-to-erasure; compliance-dpa |
| SOC 2 and ISO 27001 | compliance-soc2; compliance-iso27001 |
| PCI DSS and data classification | compliance-pci-dss; compliance-data-classification |
| Retention, audit trails, evidence | compliance-retention; compliance-audit-trails; compliance-evidence |
| Vendor risk and subprocessors | compliance-vendor-risk; compliance-subprocessors |
| Incident notification | compliance-incident-notification |
| Policy as code | compliance-policy-as-code |

### Capacity & Cost

| Concept | Module(s) |
|---|---|
| Cost per request and unit economics | capacity-cost-per-request; capacity-unit-economics |
| Autoscaling policies, target tracking, warm pools | capacity-autoscaling-policies; containers-target-tracking; capacity-warm-pools |
| Scheduled scaling and race conditions | capacity-scheduled-scaling; capacity-scheduled-scaling-race |
| Reserved Instances, Savings Plans, committed use | capacity-reserved-instances; capacity-savings-plans; capacity-committed-use |
| Spot interruptions | capacity-spot-interruptions |
| Storage lifecycle | capacity-storage-lifecycle |
| Observability and data-transfer cost | capacity-observability-cost; cloud-networking-egress-cost |
| Rightsizing, load testing, capacity models | capacity-rightsizing; capacity-load-testing; capacity-capacity-models |
| Peak events, seasonal forecast | capacity-peak-events; capacity-seasonal-forecast |
| Noisy neighbor and queueing headroom | capacity-noisy-neighbor; capacity-queueing-headroom |
| Cost allocation and scale to zero | capacity-cost-allocation; capacity-scale-to-zero |

## 3. Dedupe and prerequisite audit

- The validator normalizes IDs, purposes, production questions, and learning deltas, then compares token sets. No exact duplicate and no pair above the similarity thresholds (0.82 for learning deltas, 0.86 for purposes and questions) remains.
- Every prerequisite resolves to an existing module ID. The graph is acyclic. Nineteen back-edges were removed during review; the final graph is validated by `npm run validate:manifest`.
- No standard module re-teaches only its prerequisite. Each row states a distinct failure mode, signal, or tradeoff in its learning delta.
- No two case files cover the same incident class. Real incidents use their own public postmortems; composites are explicitly labeled and target concepts that lack a suitable public incident.
- No Kubernetes modules exist. The reserved track has no rows.
- No placeholder rows. Each row has a concrete sim mechanic, break condition, and interactive plan.
- No `TODO`, `TBD`, `Lorem`, `Coming soon`, `example.com`, or localhost content in the manifest.

## 4. Findings and resolutions

| Finding | Resolution |
|---|---|
| 19 prerequisite cycles (mutual references) | Removed one back-edge from each cycle; validator now passes acyclic check |
| `capacity-storage-lifecycle` row had 15 cells | Restored prerequisites, case-file, and interview columns |
| `traffic-host-routing` used example.com names | Replaced with `meridian.internal` names |
| Two rows referenced unrelated prerequisites | Replaced with relevant foundation modules |
| Cloudflare/Akamai behavior had no canonical row | Rescoped `traffic-alb-body-limits` to `traffic-edge-provider-behavior` |
| SNS had no explicit coverage | Rescoped `streaming-eventbridge` to `SNS and EventBridge Routing` |
| Case-file count initially 61 due to duplicate order 57 | Removed the duplicate observability-agent case; each remaining case has a unique order |
| Real-incident verification is incomplete at manifest time | 17 real-incident candidates are listed with public sources; 43 composites are labeled. Accuracy review verifies each real incident before authoring |

## 5. Case-file note

The 60 case files are 17 public-incident candidates and 43 clearly labeled composites. This meets the 30-case-file minimum and the target count. The real-incident candidates are: AWS S3 2017, AWS Kinesis 2020, AWS us-east-1 2021, AWS Lambda 2023, Cloudflare 2019, Cloudflare 2020, Cloudflare 2022, Fastly 2021, Facebook 2021, GitHub 2018, GitHub 2020, GitLab 2017, Slack 2021, Atlassian 2022, Roblox 2021, Netflix 2012, Google Cloud 2019. No case file will be authored from memory; each real incident is verified against its public postmortem and labeled. Composites are original scenarios, not disguised real incidents.

## 6. Attestation

I reviewed all 456 initial modules for overlap and coverage. No two modules share the same purpose or learning delta. Every mandatory concept is mapped. The manifest was frozen for authoring. On 2026-11-11 the user requested the reserved Kubernetes track and Kubernetes case files; 16 Kubernetes modules and 4 composites were added, bringing the validated total to 476 with no duplicate learning deltas.


## Addendum — Kubernetes extension (2026-11-11)

The reserved Kubernetes track is now authored: 16 modules covering pods and deployments, Services and endpoints, Ingress, requests and limits, probes, scheduling, HPA, disruption budgets, DNS, StatefulSets, ConfigMaps and Secrets, RBAC, node pressure, upgrades, multitenancy, and cluster triage. Four clearly labeled Kubernetes composites were added to the case-file track. The manifest validates at 476 rows: 412 standard modules and 64 case files.

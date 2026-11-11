# Faultline — Curriculum

Target: 476 modules (412 core + 64 case files). Minimum acceptable: 300 modules with at least 30 case files. Never ship filler.

| Track | ID | Purpose | Modules |
|---|---|---|---|
| Foundations | `foundations` | Mental models, queueing, Linux, HTTP, resilience, security basics | 32 |
| Observability | `observability` | Datadog, Grafana, VictoriaMetrics, OTel, SLOs, alerting | 34 |
| Traffic & Edge | `traffic` | DNS, ALB/NLB, CDN, WAF, rate limits, connection management | 34 |
| Caching | `caching` | Redis, hot keys, stampede, local cache, coherence | 28 |
| Relational Data | `databases` | RDS/Aurora, replication, failover, backups, DR | 32 |
| Document Data | `mongodb` | Replica sets, sharding, read preference, write concern | 22 |
| Streaming & Messaging | `streaming` | Kafka, Confluent, WarpStream, MQTT, SQS/SNS | 32 |
| Containers & ECS | `containers` | ECS/Fargate, autoscaling, task lifecycle, deployments | 26 |
| Service Mesh | `mesh` | Envoy, Kuma, mTLS, retries, circuit breaking, locality | 22 |
| Release Engineering | `deployment` | Canary, blue-green, flags, migrations, rollback | 28 |
| Reliability & Incidents | `reliability` | Incident command, postmortems, chaos, load shedding | 32 |
| Cloud Networking | `cloud-networking` | VPC, peering, TGW, route tables, PrivateLink, IAM | 32 |
| Compliance & GRC | `compliance` | HIPAA, GDPR, SOC 2, audit, data residency | 20 |
| Capacity & Cost | `capacity` | Autoscaling, scaling races, unit economics | 22 |
| Case Files | `case-files` | Real incidents and clearly labeled composites | 64 |
| Kubernetes | `kubernetes` | Pods, Services, Ingress, scheduling, autoscaling, storage, RBAC, upgrades | 16 |

## Paths

- Beginner: Foundations → Observability → Traffic → Caching → Databases.
- Incident response: Foundations → Observability → Caching → Databases → Reliability.
- AWS: Traffic → Containers → Databases → Cloud Networking → Capacity.
- Kubernetes: Kubernetes → Containers → Deployment.

Prerequisites are guidance, not locks. Case files slot every 5–6 modules within a track where a real public incident fits.

The full per-module list is `docs/MODULE_MANIFEST.md`. Coverage and dedupe attestation is `docs/CURRICULUM_REVIEW.md`.

The learner-facing flat path is `/curriculum`. It orders modules by effective level (monotonic), respects prerequisites, rotates categories within a level, and inserts case files as purple milestones after the knowledge they depend on. The ordering algorithm is `src/content/learningPath.ts`.

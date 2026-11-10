import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Metric label cardinality explosion after a release",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common metric-label, cardinality, and cost-governance failure modes into one representative case. It does not describe any company's architecture, dates, traffic, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "A debugging label ships to production",
      body: "A release adds a user identifier label to the main request counter so engineers can follow one session through dashboards. The label is cheap in staging, where a few hundred users generate a few thousand series.",
      tone: "warn",
    },
    {
      at: "T+00:10",
      title: "Series count multiplies",
      body: "In production the label combines with route, region, method, and status. Active series grow from tens of thousands to several million within minutes, and the metrics pipeline begins to fall behind.",
      tone: "danger",
    },
    {
      at: "T+00:40",
      title: "Queries slow down",
      body: "Dashboards that aggregate the request counter time out. The index and query workers are saturated by series churn, so unrelated dashboards and alerts also become sluggish.",
      tone: "danger",
    },
    {
      at: "T+02:00",
      title: "The budget alert fires",
      body: "A usage alert reaches the platform team: ingestion volume and active-series charges are several times the forecast. The alert is configured to notify finance at month end, but an engineering budget threshold happens to page the on-call.",
      tone: "warn",
    },
    {
      at: "T+03:00",
      title: "The source is found",
      body: "The on-call ranks metrics by series count, then labels by distinct values. One request counter owns most of the growth, and its newest label has millions of values. The release diff shows where it was added.",
      tone: "info",
    },
    {
      at: "T+03:20",
      title: "Growth is stopped at ingestion",
      body: "A relabeling rule drops the user identifier before storage, and the application change removes it at the source. Existing series age out with retention; new series stop arriving immediately.",
      tone: "warn",
    },
    {
      at: "T+06:00",
      title: "Dashboards recover",
      body: "Query latency returns to normal as series churn falls. The team keeps per-user diagnosis in sampled traces and logs, where the identifier is an attribute rather than an index dimension.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "find-the-source",
      prompt: "Dashboards are slow and the metrics bill is climbing. How do you find the cause?",
      options: [
        {
          id: "rank-series",
          label:
            "Rank metrics by active series, then rank labels by distinct values, and compare with the release diff.",
          consequence:
            "The highest-cardinality metric and its new label are identified directly. The method also shows which other metrics are close to their limits, so the team can fix more than the current offender.",
          quality: "good",
        },
        {
          id: "scale-backend",
          label: "Add query and ingestion capacity to the metrics backend.",
          consequence:
            "Dashboards may recover temporarily, but the new label keeps multiplying series. Cost and churn continue to grow, and the underlying design problem becomes harder to see.",
          quality: "mixed",
        },
        {
          id: "delete-dashboards",
          label: "Delete the slowest dashboards until query latency improves.",
          consequence:
            "Some load disappears, but the high-cardinality metric keeps ingesting and charging. The team loses visibility while the cause remains in production.",
          quality: "poor",
        },
      ],
      debrief:
        "Cardinality is multiplicative. A label with a million values does not add a million data points; it multiplies every existing combination of route, region, method, and status. Ranking active series by metric and label finds the multiplier faster than reading dashboards or the bill.",
    },
    {
      id: "immediate-mitigation",
      prompt: "What is the best immediate mitigation while the code fix is prepared?",
      options: [
        {
          id: "drop-label",
          label:
            "Drop the high-cardinality label at ingestion, aggregate to bounded dimensions, and keep the identifier in traces.",
          consequence:
            "Series growth stops within a scrape interval and the application fix can ship without urgency. Per-user debugging remains possible through sampled traces and logs, with a small loss of metric-level detail.",
          quality: "good",
        },
        {
          id: "sample-series",
          label: "Keep the label but sample a fraction of the series.",
          consequence:
            "Ingestion falls somewhat, but the label still creates millions of potential combinations and query planning remains expensive. Sampling also makes per-user lookups unreliable.",
          quality: "mixed",
        },
        {
          id: "disable-metrics",
          label: "Disable metric collection for the affected service.",
          consequence:
            "Cost and query load drop sharply, but so does the ability to see the incident and its recovery. Other teams lose the service's health signals at the moment they are most needed.",
          quality: "poor",
        },
      ],
      debrief:
        "The fastest control is at the edge of the metrics pipeline, because it does not wait for a deploy. Dropping the label preserves the useful aggregate series and moves high-cardinality diagnosis to traces, logs, or exemplars. Sampling a high-cardinality label reduces volume but not the shape of the index.",
    },
    {
      id: "governance",
      prompt: "What control keeps the next release from repeating this?",
      options: [
        {
          id: "series-budget",
          label:
            "Give each team a series budget, enforce a label allowlist in CI, and page the owning team on cost anomalies.",
          consequence:
            "New labels are reviewed against a known budget before they ship, and the team that creates the cost sees it. The allowlist blocks the common mistake without requiring a central gate for every metric.",
          quality: "good",
        },
        {
          id: "monthly-review",
          label: "Review observability cost with finance at the end of each month.",
          consequence:
            "The increase is visible eventually, but the feedback arrives after weeks of ingestion and after the release is long gone. The owning team is not involved at the point of change.",
          quality: "poor",
        },
        {
          id: "ban-labels",
          label: "Prohibit all new metric labels.",
          consequence:
            "The explosion is prevented, but legitimate bounded labels such as version, tenant tier, or queue name also become impossible. Teams work around the ban by encoding values into metric names.",
          quality: "mixed",
        },
      ],
      debrief:
        "A cardinality budget makes the cost visible at design time, and an allowlist keeps rare debugging identifiers out of indexed dimensions. The alert must reach the team that owns the metric, not only a monthly finance report. The goal is bounded labels, not no labels.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A release added a user identifier to a high-volume request counter. The value multiplied against existing route, region, method, and status dimensions, creating millions of series. Query latency and ingestion cost rose together, and the source was found only after ranking metrics and labels by series count.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "The label was tested only at staging cardinality, where the series count looked harmless.",
        "Cost alerts went to finance on a monthly cadence instead of to the team that owned the metric.",
        "No dashboard showed active series per metric or per team, so the increase was invisible until queries slowed.",
        "The label duplicated information already available in traces and logs at higher fidelity.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Each service has a series budget, and new labels require an allowlisted bounded value set.",
        "CI checks metric definitions for unbounded identifiers such as user, cart, request, and session IDs.",
        "Cost and cardinality anomalies page the owning team with a runbook for finding the top label.",
        "High-cardinality diagnosis moved to sampled traces, logs, and exemplars rather than metric labels.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A metric label is an index dimension, not a field. Cost grows with the product of label cardinalities, so one unbounded identifier can dominate a pipeline even when the event rate is unchanged. Governance works best at the point of change: a bounded label set, a series budget, and an alert that reaches the owner before the next invoice.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, series counts, and cost figures in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Instrumentation",
      url: "https://prometheus.io/docs/practices/instrumentation/",
      publisher: "Prometheus Documentation",
      kind: "docs",
      note: "Label design, cardinality, and avoiding unbounded values.",
    },
    {
      title: "Storage",
      url: "https://prometheus.io/docs/prometheus/latest/storage/",
      publisher: "Prometheus Documentation",
      kind: "docs",
      note: "How series and labels are indexed and retained.",
    },
    {
      title: "Metrics",
      url: "https://opentelemetry.io/docs/concepts/signals/metrics/",
      publisher: "OpenTelemetry Documentation",
      kind: "docs",
      note: "Metric attributes, aggregation, and the cost of high-cardinality dimensions.",
    },
  ],
};

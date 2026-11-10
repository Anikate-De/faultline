import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Post-launch cloud cost far above forecast",
  accuracyNote:
    "This is an original composite scenario and not a real incident. It combines common launch-forecasting, data-transfer, storage-growth, and telemetry-cost failure modes into one representative case. It does not describe any company's architecture, traffic, dates, or internal decisions. All times, amounts, and telemetry are illustrative.",
  timeline: [
    {
      at: "T-30 days",
      title: "The launch forecast is built",
      body: "The model estimates compute, database, and object storage from expected request volume. It prices those dimensions at current rates and produces a monthly forecast. Data transfer and observability are treated as small overhead.",
      tone: "info",
    },
    {
      at: "T+00:00",
      title: "The feature launches",
      body: "Users upload images and receive generated thumbnails. The launch meets its latency and availability targets. Request volume lands within ten percent of the forecast.",
      tone: "success",
    },
    {
      at: "T+3 days",
      title: "The delivery path is less efficient than planned",
      body: "The content cache hit rate settles near 62% instead of the modeled 95%. More requests reach the origin, and origin egress to the internet grows faster than request count.",
      tone: "warn",
    },
    {
      at: "T+7 days",
      title: "The projection reaches three times forecast",
      body: "The cost-management tool projects the current run rate at three times the launch model. Compute is close to plan; the variance is concentrated in data transfer and log ingestion.",
      tone: "danger",
    },
    {
      at: "T+10 days",
      title: "Telemetry is a major line item",
      body: "Debug logging was left at full sampling. Each request writes several kilobytes, and retention is set to ninety days. Log ingestion and storage account for nearly a quarter of the projected bill.",
      tone: "danger",
    },
    {
      at: "T+14 days",
      title: "The two largest drivers are reduced",
      body: "Cache keys are corrected and the hit rate rises above 90%. Debug logs are sampled, payload size is capped, and retention is shortened. The run rate falls by roughly half but remains above forecast.",
      tone: "success",
    },
    {
      at: "T+30 days",
      title: "The model gains unit costs",
      body: "The team rebuilds the forecast around cost per thousand requests, cost per gigabyte delivered, storage growth per upload, and telemetry per request. Launch reviews now require those units and a budget alarm at the projected run rate.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "find-the-driver",
      prompt:
        "The bill is three times forecast and request volume is on plan. What is the most useful first step?",
      options: [
        {
          id: "attribute-units",
          label:
            "Break down cost by service, usage type, and tag, then compare each dimension's unit cost with the forecast.",
          consequence:
            "Data transfer and telemetry separate from compute immediately. The team can attack the dimensions that grew faster than usage instead of applying a blanket cut.",
          quality: "good",
        },
        {
          id: "ask-finance",
          label: "Ask finance for a single total and divide it by request volume.",
          consequence:
            "The average cost per request rises, but the average hides which dimension changed. The team learns that the bill is higher without learning where to intervene.",
          quality: "mixed",
        },
        {
          id: "cut-nonprod",
          label: "Shut down every non-production environment as the first action.",
          consequence:
            "Some spend disappears, but production continues to grow at the same rate. The action adds delivery friction and may not touch the dominant line item at all.",
          quality: "poor",
        },
      ],
      debrief:
        "A total is an output, not a diagnosis. Cost and usage data can be grouped by service, usage type, and tag, which turns the bill into a set of unit costs. The useful comparison is cost per request, per gigabyte delivered, per gigabyte stored, and per log event against the model. When request volume is on plan, the variance must come from a dimension whose unit cost or volume per request was underestimated.",
    },
    {
      id: "lasting-model",
      prompt: "What should the next launch use so a hidden dimension cannot dominate the bill?",
      options: [
        {
          id: "unit-economics-gate",
          label:
            "Model fixed and variable unit costs, require tags, alert on the projected run rate, and gate the launch on the model.",
          consequence:
            "The forecast exposes data transfer and telemetry as first-class costs. Growth is visible before the invoice, and the owning team is paged when the run rate departs from plan.",
          quality: "good",
        },
        {
          id: "commit-discount",
          label: "Buy a long-term commitment to lower the unit prices.",
          consequence:
            "The discount reduces the rate but not the consumption. The workload keeps growing along the unmodeled dimension, and the commitment can lock in spend for a pattern that may change.",
          quality: "mixed",
        },
        {
          id: "hard-cap",
          label: "Set a hard account-level spending cap and stop all workloads at the threshold.",
          consequence:
            "The bill is bounded, but a production launch can be taken offline by an unrelated cost increase. The cap treats the symptom and creates a new availability risk.",
          quality: "poor",
        },
      ],
      debrief:
        "Unit economics makes cost a design input: cost per request, per delivery, per stored object, and per telemetry event. Each dimension needs an owner and a growth assumption. Budget alarms should watch the projected run rate, not only the month-to-date total, because a fast-growing dimension can look small until late in the cycle. Discounts and caps change the price or the blast radius; they do not fix an unmodeled consumption path.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A launch forecast modeled compute, database, and storage but treated data transfer and observability as minor overhead. The content cache performed below plan, so more bytes left the origin, while debug logging ran at full sampling with long retention. Request volume was close to forecast, but cost per request was not, and the projected run rate reached three times the model.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "The forecast used aggregate totals instead of cost per request and per gigabyte.",
        "Cache hit rate was assumed rather than tested with production-like object sizes and keys.",
        "Debug logging and retention were left at defaults after launch.",
        "Tags were incomplete, so the first bill could not be split cleanly by feature.",
        "Budget alerts watched month-to-date spend, which lagged the run-rate change.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Launch reviews require a unit-cost model covering compute, storage, data transfer, and telemetry.",
        "Cache hit rate and egress per request are launch SLIs, not post-launch surprises.",
        "Log sampling, payload limits, and retention are set before the first production request.",
        "Budgets alert on projected run rate, and every resource carries the feature tag.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "Cost is a distributed systems property: it scales with requests, bytes moved, bytes stored, and events emitted, and those dimensions grow at different rates. A forecast that prices only the resources someone remembered will miss the dimension with the steepest slope. Build the model from unit costs, instrument the units in production, and treat the launch as incomplete until the projected run rate is inside the approved range.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, multipliers, and cost amounts in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "What is the AWS Cost and Usage Report?",
      url: "https://docs.aws.amazon.com/cur/latest/userguide/what-is-cur.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Line-item detail for cost attribution by service, usage type, and tag.",
    },
    {
      title: "AWS Well-Architected: Cost Optimization Pillar",
      url: "https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Cost-aware design, expenditure awareness, and optimization practices.",
    },
    {
      title: "Unit Economics",
      url: "https://www.finops.org/framework/capabilities/unit-economics/",
      publisher: "FinOps Foundation",
      kind: "docs",
      note: "Per-unit cost modeling and business-aligned cost metrics.",
    },
    {
      title: "Managing costs with AWS Budgets",
      url: "https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Budget thresholds and projected-spend alerts.",
    },
  ],
};

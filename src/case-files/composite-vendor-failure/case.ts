import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Third-party payment failure escalated to a full checkout outage",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common vendor-failure, retry, isolation, and reconciliation failure modes into one representative case. It does not describe any company's architecture, dates, traffic, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "The payment provider slows",
      body: "One payment provider begins returning server errors and timing out on authorization requests. Its public status page still shows normal operation.",
      tone: "warn",
    },
    {
      at: "T+00:02",
      title: "Every cart fails",
      body: "Checkout wraps the provider call in a shared error handler. Any provider failure returns a 500 for the entire cart, including saved-card and alternate-method flows that could still complete.",
      tone: "danger",
    },
    {
      at: "T+00:06",
      title: "Retries multiply the load",
      body: "The browser retries three times and the checkout service retries twice. Some authorization attempts have no idempotency key, so a timeout can mean either no charge or a charge whose response was lost.",
      tone: "danger",
    },
    {
      at: "T+00:15",
      title: "Customers retry without guidance",
      body: "The error page says only that checkout failed. Cart abandonment rises, support cannot say whether a charge succeeded, and some customers submit the same order repeatedly.",
      tone: "danger",
    },
    {
      at: "T+00:22",
      title: "The failure is contained",
      body: "The team disables the affected card method, routes eligible carts to the alternate provider, preserves cart state, and opens a breaker so calls to the failing provider fail fast. Checkout returns a clear temporary-unavailable message instead of a generic 500.",
      tone: "warn",
    },
    {
      at: "T+00:45",
      title: "Ambiguous charges are reconciled",
      body: "The team matches internal order identifiers and idempotency keys against the provider's settlement data. Orders with an unknown outcome are held for verification before customers are invited to retry.",
      tone: "info",
    },
    {
      at: "T+02:10",
      title: "Traffic returns to normal",
      body: "The provider recovers, the breaker closes gradually, and the affected method is re-enabled in stages. The alternate path remains available as a tested fallback.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "contain-provider",
      prompt: "The provider is failing and checkout returns 500 for every cart. What is the first move?",
      options: [
        {
          id: "isolate-method",
          label:
            "Fail fast on the affected method, preserve the cart, keep alternate methods available, and show a specific message.",
          consequence:
            "Unrelated payment paths keep working and customers can choose another method. The failing provider stops consuming checkout capacity, and support gets a consistent explanation.",
          quality: "good",
        },
        {
          id: "retry-harder",
          label: "Increase retries and raise the timeout so more authorizations can complete.",
          consequence:
            "Requests occupy checkout workers for longer while the provider is already struggling. Attempts multiply, ambiguous outcomes increase, and the queue grows faster than it drains.",
          quality: "poor",
        },
        {
          id: "stop-checkout",
          label: "Take the entire checkout offline until the provider recovers.",
          consequence:
            "The failure is contained, but every payment method and every cart stops, including flows that do not depend on the failing provider. The outage becomes larger and longer than the vendor's.",
          quality: "mixed",
        },
      ],
      debrief:
        "A vendor failure should be contained at the vendor boundary. The blast radius is determined by the error handler, not by the provider's availability. Failing fast on the affected method, preserving cart state, and keeping independent methods available turns a total checkout outage into a degraded payment option.",
    },
    {
      id: "ambiguous-charge",
      prompt:
        "Some authorization requests timed out and the outcome is unknown. How do you handle customers who want to retry?",
      options: [
        {
          id: "reconcile-first",
          label:
            "Reconcile order identifiers and idempotency keys against provider settlement data before inviting a retry.",
          consequence:
            "The team distinguishes a failed authorization from a successful charge whose response was lost. Customers avoid duplicate charges, and support can give a definitive answer per order.",
          quality: "good",
        },
        {
          id: "retry-all",
          label: "Treat every timeout as a failure and let customers submit the order again.",
          consequence:
            "Recovery is fast for genuinely failed requests, but some customers are charged twice. Refunds, disputes, and support cost arrive after the incident and are harder to resolve than the original delay.",
          quality: "poor",
        },
        {
          id: "fail-all-refund",
          label: "Mark every ambiguous order as failed and issue refunds later.",
          consequence:
            "No customer is charged twice, but some successful orders are reversed and inventory is released incorrectly. The refund process creates a second wave of customer contact and accounting work.",
          quality: "mixed",
        },
      ],
      debrief:
        "An ambiguous timeout is not evidence of failure. Before asking a customer to retry a payment, the system needs an idempotency key and a way to look up the authoritative outcome. Reconciliation is slower than a blanket retry, but it prevents the duplicate charges that turn a provider incident into a trust incident.",
    },
    {
      id: "durable-isolation",
      prompt: "What design would keep one provider from failing the whole checkout?",
      options: [
        {
          id: "bulkhead-breaker",
          label:
            "Give each provider its own pool, timeout, breaker, error taxonomy, and a tested fallback route.",
          consequence:
            "A failing provider consumes only its own capacity, and the orchestration can map its errors to method-specific outcomes. Fallback capacity must be real, but the blast radius is bounded by design.",
          quality: "good",
        },
        {
          id: "global-timeout",
          label: "Use one global timeout and retry policy for all payment calls.",
          consequence:
            "The configuration is simple, but providers with different latency and failure behavior share the same limits. A slow provider can exhaust the pool used by healthy methods.",
          quality: "mixed",
        },
        {
          id: "trust-sla",
          label: "Rely on the provider's SLA and status page during an incident.",
          consequence:
            "The contract may compensate for downtime later, but it does not preserve checkout availability now. Status pages often lag the failure, so the team learns from customers rather than telemetry.",
          quality: "poor",
        },
      ],
      debrief:
        "Third-party isolation is the same bulkhead and breaker problem as any internal dependency, with one addition: the error contract is outside your control. Each provider needs its own capacity, timeout, and failure classification, plus a fallback path that is exercised before it is needed. An SLA is a financial remedy, not a runtime control.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "One payment provider began timing out. A shared checkout error handler converted those failures into 500s for every cart, including flows that used other methods. Client and server retries increased load and created ambiguous outcomes, and the first customer message gave no guidance. The team isolated the method, opened a breaker, reconciled uncertain charges, and restored checkout.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "One provider's errors were mapped to a failure of the entire checkout orchestration.",
        "Retries were multiplied at two layers, and not every authorization carried an idempotency key.",
        "The provider status page lagged the failure, so monitoring depended on customer reports.",
        "The error page did not distinguish a failed payment from an unknown outcome.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Each provider has a separate connection pool, timeout, breaker, and error taxonomy.",
        "Authorization requests carry idempotency keys, and reconciliation is a documented incident step.",
        "Checkout exposes method-specific outcomes and preserves carts across provider failures.",
        "Fallback routing is tested in game days with one provider disabled.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A vendor outage becomes your outage through shared error handling, shared capacity, and shared retry policy. Isolation at the provider boundary limits the first, bulkheads limit the second, and idempotency with reconciliation limits the third. The customer-facing question is not which vendor failed but which actions are still safe.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, error rates, and charge outcomes in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Timeouts, retries, and backoff with jitter",
      url: "https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/",
      publisher: "AWS Builders' Library",
      kind: "docs",
      note: "Retry amplification, timeouts, and idempotent retries.",
    },
    {
      title: "Error handling",
      url: "https://docs.stripe.com/error-handling",
      publisher: "Stripe Documentation",
      kind: "docs",
      note: "Payment error types, idempotency, and safe retry behavior.",
    },
    {
      title: "Circuit Breaker pattern",
      url: "https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker",
      publisher: "Microsoft Azure Architecture Center",
      kind: "docs",
      note: "Breaker states, failure thresholds, and fallback behavior.",
    },
  ],
};

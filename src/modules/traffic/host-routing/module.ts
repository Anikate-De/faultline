import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const HOSTS = [
  "app.meridian.internal",
  "api.meridian.internal",
  "admin.meridian.internal",
  "app.eu.meridian.internal",
];
const RULE_LIMIT = 100;
const REQUEST_RATE = 10_000;

const params = [
  {
    id: "tenantHost",
    label: "Request host",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Request",
    help: "0 app.meridian.internal, 1 api.meridian.internal, 2 admin.meridian.internal, 3 app.eu.meridian.internal. The last host has two labels before the base domain.",
    format: "count" as const,
  },
  {
    id: "certificateScope",
    label: "Certificate scope (0 exact, 1 wildcard, 2 SAN)",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "TLS",
    help: "0 covers app only. 1 is *.meridian.internal, which covers one label. 2 is a SAN certificate covering all four hosts. The certificate is on the ALB, or on the targets when the TLS path is NLB passthrough.",
    format: "count" as const,
  },
  {
    id: "ruleCoverage",
    label: "Host rules deployed (0 app, 1 app+api, 2 all)",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Routing",
    help: "Which hosts have a listener rule. A host without a rule falls through to the default action.",
    format: "count" as const,
  },
  {
    id: "tlsTermination",
    label: "TLS path (0 ALB, 1 NLB passthrough)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "TLS",
    help: "0 terminates TLS at the ALB, which can read the host header and apply host rules. 1 uses an NLB TCP listener to pass encrypted bytes to the targets; the ALB is bypassed and the target must route by host.",
    format: "count" as const,
  },
  {
    id: "ruleCount",
    label: "ALB listener rules configured",
    min: 1,
    max: 120,
    step: 1,
    value: 24,
    unit: "",
    group: "Limits",
    help: "Rules configured on the ALB. The default quota is 100 rules per ALB excluding the default rule; this is an adjustable quota.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface State {
  hostIndex: number;
  host: string;
  scope: number;
  coverage: number;
  termination: number;
  ruleCount: number;
  certCovered: boolean;
  rulesCovered: boolean;
  tlsFailures: number;
  defaultHits: number;
  misrouted: number;
  success: number;
  certCoverage: number;
  ruleCoverage: number;
  ruleHeadroom: number;
  configError: number;
  p99: number;
}

function compute(p: Params): State {
  const hostIndex = Math.min(3, Math.max(0, Math.round(num(p, "tenantHost", 0))));
  const scope = Math.min(2, Math.max(0, Math.round(num(p, "certificateScope", 2))));
  const coverage = Math.min(2, Math.max(0, Math.round(num(p, "ruleCoverage", 2))));
  const termination = num(p, "tlsTermination", 0) >= 0.5 ? 1 : 0;
  const ruleCount = Math.min(120, Math.max(1, Math.round(num(p, "ruleCount", 24))));
  const certCovered = scope === 2 || (scope === 0 && hostIndex === 0) || (scope === 1 && hostIndex !== 3);
  const rulesCovered = coverage === 2 || (coverage === 0 && hostIndex === 0) || (coverage === 1 && hostIndex <= 1);
  const tlsFailures = certCovered ? 0 : 100;
  const defaultHits = certCovered && (!rulesCovered || termination === 1) ? 100 : 0;
  const misrouted = tlsFailures > 0 ? 0 : defaultHits;
  const success = 100 - tlsFailures - misrouted;
  const certCoverage = certCovered ? 100 : 0;
  const ruleCoverage = termination === 0 && rulesCovered ? 100 : 0;
  const ruleHeadroom = Math.max(0, RULE_LIMIT - ruleCount);
  const configError = ruleCount > RULE_LIMIT ? 1 : 0;
  const p99 = tlsFailures > 0 ? 0 : misrouted > 0 ? 55 : 15;
  return {
    hostIndex,
    host: HOSTS[hostIndex],
    scope,
    coverage,
    termination,
    ruleCount,
    certCovered,
    rulesCovered,
    tlsFailures,
    defaultHits,
    misrouted,
    success,
    certCoverage,
    ruleCoverage,
    ruleHeadroom,
    configError,
    p99,
  };
}

function scopeLabel(scope: number): string {
  if (scope === 0) return "exact app.meridian.internal";
  if (scope === 1) return "wildcard *.meridian.internal";
  return "SAN: all four hosts";
}

function coverageLabel(coverage: number): string {
  if (coverage === 0) return "app only";
  if (coverage === 1) return "app and api";
  return "all four hosts";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const s = compute(p);
  const clientHealth: Health = s.success < 95 ? "crit" : s.configError ? "warn" : "ok";
  const albHealth: Health =
    s.tlsFailures >= 5 || s.misrouted >= 5 || s.configError
      ? "crit"
      : s.ruleCount >= 80
        ? "warn"
        : "ok";
  const targetHealth: Health = "ok";
  const albDetail =
    `Request host ${s.host}. Certificate: ${scopeLabel(s.scope)}. ` +
    `Rules cover ${coverageLabel(s.coverage)}. ` +
    `TLS terminates at the ALB, so the host header is visible to host rules. ` +
    `Listener rules used: ${s.ruleCount} of the ${RULE_LIMIT} default quota.`;
  const nlbDetail =
    `Request host ${s.host}. Certificate: ${scopeLabel(s.scope)} on the targets. ` +
    `The NLB TCP listener passes encrypted bytes to the target group; the ALB and its host rules are not in the path. ` +
    `The target must terminate TLS and route by host, or serve its default app.`;
  const targetDetail =
    s.tlsFailures > 0
      ? "No HTTP request reached a target group. The certificate presented to the client did not cover the host, so the TLS handshake failed."
      : s.termination === 1
        ? "The NLB forwarded the TCP connection to a target. The ALB is bypassed, so the tenant host rule cannot run; this lab models the target as a single default app."
        : s.misrouted > 0
          ? "The request reached the default target group instead of the tenant target group. The host rule either does not exist, does not match, or is shadowed."
          : "The host rule matched and forwarded the request to the tenant target group.";
  const ingress = s.termination === 0 ? "alb" : "nlb";
  const nodes: SimFrame["nodes"] = [
    {
      id: "client",
      label: "Clients",
      kind: "client",
      health: clientHealth,
      throughput: s.tlsFailures > 0 ? 0 : REQUEST_RATE,
      sublabel: s.tlsFailures > 0 ? "TLS handshake failed" : s.misrouted > 0 ? "default path" : "tenant route",
      meta: { view: "flow" },
    },
  ];
  if (s.termination === 0) {
    nodes.push({
      id: "alb",
      label: "ALB HTTPS listener",
      kind: "lb",
      health: albHealth,
      throughput: s.tlsFailures > 0 ? 0 : REQUEST_RATE,
      sublabel: `${scopeLabel(s.scope)} · ${s.ruleCount} rules`,
      detail: albDetail,
      meta: { view: "flow" },
    });
  } else {
    nodes.push({
      id: "nlb",
      label: "Network Load Balancer",
      kind: "lb",
      health: "ok",
      throughput: s.tlsFailures > 0 ? 0 : REQUEST_RATE,
      sublabel: "TCP listener · ALB bypassed",
      detail: nlbDetail,
      meta: { view: "flow" },
    });
  }
  nodes.push({
    id: "targets",
    label: "Target groups",
    kind: "service",
    health: targetHealth,
    throughput: s.tlsFailures > 0 ? 0 : REQUEST_RATE,
    sublabel: s.tlsFailures > 0 ? "healthy · no traffic" : s.misrouted > 0 ? "default app" : "tenant group",
    detail: targetDetail,
    meta: { view: "flow" },
  });
  return {
    t: 0,
    nodes,
    edges: [
      edge(`client-${ingress}`, "client", ingress, s.tlsFailures > 0 ? 0 : 1, s.tlsFailures > 0 ? "crit" : "ok"),
      edge(`${ingress}-targets`, ingress, "targets", s.tlsFailures > 0 ? 0 : 1, targetHealth),
    ],
    metrics: [
      metric("tls-handshake-failures", "TLS handshake failures", s.tlsFailures, "%", 0.5, 5, "percent"),
      metric("misrouted", "Requests outside tenant rule", s.misrouted, "%", 1, 5, "percent"),
      metric("default-hits", "Default path requests", s.defaultHits, "%", 1, 5, "percent"),
      metric("certificate-coverage", "Certificate coverage", s.certCoverage, "%", undefined, undefined, "percent"),
      metric("rule-coverage", "ALB host rule coverage", s.ruleCoverage, "%", undefined, undefined, "percent"),
      metric("rules-used", "ALB listener rules configured", s.ruleCount, "", 80, 100, "count"),
      metric("rule-headroom", "Rule headroom", s.ruleHeadroom, "", undefined, undefined, "count"),
      metric("success", "Successful requests", s.success, "%", undefined, undefined, "percent"),
      ...(s.termination === 0 && s.tlsFailures === 0
        ? [metric("p99", "HTTP p99", s.p99, "ms", 50, 150, "ms")]
        : []),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      hostIndex: s.hostIndex,
      scope: s.scope,
      coverage: s.coverage,
      termination: s.termination,
      ruleCount: s.ruleCount,
    },
    summary: `${s.host}: ${s.tlsFailures.toFixed(0)}% TLS failures; ${s.misrouted.toFixed(0)}% outside a tenant host rule via ${s.termination === 0 ? "ALB" : "NLB passthrough"}; ${s.success.toFixed(0)}% successful; ${s.ruleCount} rules configured.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const value =
        item.value * (0.97 + 0.05 * Math.sin((index + (seed % 7)) / 2.3)) +
        Math.sin(index / 2.1) * amplitude;
      const bounded = item.format === "percent" ? Math.min(100, value) : value;
      return Math.max(0, bounded);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "tls-handshake-failures",
    metricId: "tls-handshake-failures",
    warn: 0.5,
    crit: 5,
    title: "The certificate does not cover the requested host",
    cause:
      "The client requested a host name that is not in the certificate's subject or subject alternative names. A wildcard certificate covers only one subdomain level and does not cover the apex or a multi-level name such as app.eu.meridian.internal.",
    fix:
      "Add the host to a SAN certificate or issue an exact certificate for it. Attach the certificate to the ALB listener, or to the targets when an NLB passes TLS through. Confirm SNI selects it, and test the handshake with the real host name, not the load balancer DNS name.",
    checkFirst: [
      "Check the certificate's subject alternative names, not only its common name.",
      "Confirm the requested host has the expected label depth for the wildcard.",
      "Run a TLS handshake with SNI set to the tenant host and read the certificate presented.",
    ],
  },
  {
    id: "misrouted",
    metricId: "misrouted",
    warn: 1,
    crit: 5,
    title: "The request left the tenant host rule",
    cause:
      "The host rule is missing, does not match the requested host, is shadowed by an earlier rule, or an NLB TCP listener bypasses the ALB entirely. In the bypass case, no ALB host rule can run.",
    fix:
      "Terminate TLS at the ALB if the ALB should own host routing. Otherwise implement host routing at the targets behind the NLB. Then add or correct the ALB host condition and place it before a broad fallback.",
    checkFirst: [
      "Check whether the request reaches the ALB over HTTP after TLS termination.",
      "Run describe-rules and confirm the host condition and priority.",
      "Read the access log for the chosen target group and the host header.",
    ],
  },
  {
    id: "default-hits",
    metricId: "default-hits",
    warn: 1,
    crit: 5,
    title: "Tenant traffic is on the default path",
    cause:
      "No earlier host rule matched the host, or the ALB is bypassed by an NLB TCP listener. The default action may return a 404 or send the request to a shared fallback service, which can be worse than an error because it looks successful.",
    fix:
      "Add a host rule for the tenant and verify it matches before the default, or terminate TLS at the ALB if ALB host routing is required. Keep the default action explicit and monitor its hit rate.",
    checkFirst: [
      "Check the default rule action and whether it is shared across tenants.",
      "Compare the host header with the condition values.",
      "Check the rule priority order for a broad rule that matches first.",
    ],
  },
  {
    id: "rules-used",
    metricId: "rules-used",
    warn: 80,
    crit: 100,
    title: "The listener is close to its rule quota",
    cause:
      "Every tenant or route adds a listener rule. The default quota is 100 rules per ALB excluding the default rule; the quota is adjustable, but more rules also mean more evaluation and overlap risk.",
    fix:
      "Consolidate routes that share a target group, remove dead rules, or split tenants across ALBs or listeners. Confirm the quota before a deployment that adds host rules.",
    checkFirst: [
      "Inventory rules by host and target group.",
      "Check for overlapping conditions that could share one rule.",
      "Confirm the quota in Service Quotas before the next tenant onboarding.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const hostRoutingModel: SimModel = {
  id: "traffic-host-routing",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const s = compute(p);
    const next = buildFrame(p, seed);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: key };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const noise = rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * (1 + noise)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (s.tlsFailures > 0 && frame.flags.tlsMismatch !== 1) {
      pushEvent(next, {
        id: "tls-host-mismatch",
        at: frame.t,
        severity: "crit",
        title: "TLS failed before host routing",
        detail: `${s.host} is not covered by the ${scopeLabel(s.scope)} certificate on the ${s.termination === 0 ? "ALB" : "targets"}. No HTTP request reached a host rule, so changing rule priority cannot fix this.`,
        nodeId: s.termination === 0 ? "alb" : "targets",
        metricId: "tls-handshake-failures",
      });
      next.flags.tlsMismatch = 1;
    } else if (s.tlsFailures === 0) {
      next.flags.tlsMismatch = 0;
    }
    if (s.misrouted > 0 && frame.flags.hostMiss !== 1) {
      pushEvent(next, {
        id: "host-rule-miss",
        at: frame.t,
        severity: "crit",
        title: "The host rule did not serve the tenant",
        detail: s.termination === 1
          ? "The NLB TCP listener sends encrypted bytes to the target group. The ALB is bypassed, so no host rule runs; the target serves its default app unless it routes the host itself."
          : `${s.host} has no matching host rule (deployed coverage: ${coverageLabel(s.coverage)}). The default action served the request instead.`,
        nodeId: s.termination === 0 ? "alb" : "nlb",
        metricId: "misrouted",
      });
      next.flags.hostMiss = 1;
    } else if (s.misrouted === 0) {
      next.flags.hostMiss = 0;
    }
    if (s.configError === 1 && frame.flags.ruleLimit !== 1) {
      pushEvent(next, {
        id: "rule-limit",
        at: frame.t,
        severity: "warn",
        title: "Listener rule quota exceeded",
        detail: `${s.ruleCount} rules are configured against the ${RULE_LIMIT}-rule default quota. The quota is adjustable, but new host rules may fail to deploy until it is raised or rules are consolidated.`,
        nodeId: "alb",
        metricId: "rules-used",
      });
      next.flags.ruleLimit = 1;
    } else if (s.configError === 0) {
      next.flags.ruleLimit = 0;
    }
    next.flags.hostIndex = s.hostIndex;
    next.flags.scope = s.scope;
    next.flags.coverage = s.coverage;
    next.flags.termination = s.termination;
    next.flags.ruleCount = s.ruleCount;
    next.summary = `${s.host}: ${s.tlsFailures.toFixed(0)}% TLS failures; ${s.misrouted.toFixed(0)}% outside a tenant host rule via ${s.termination === 0 ? "ALB" : "NLB passthrough"}; ${s.success.toFixed(0)}% successful; ${s.ruleCount} rules configured.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const s = compute(p);
    const items: string[] = [];
    items.push(`Request host is ${s.host}; the certificate is ${scopeLabel(s.scope)}.`);
    if (!s.certCovered) {
      items.push(
        `The TLS handshake fails before an HTTP host rule runs. A wildcard covers one label, not a multi-level name. The certificate is on the ${s.termination === 0 ? "ALB" : "targets"}.`,
      );
    }
    if (s.certCovered) {
      items.push(
        s.termination === 0
          ? "TLS terminates at the ALB, so the host header is available to host rules."
          : "The NLB passes encrypted TCP to the targets. The ALB and its host rules are bypassed, so the target must route the host itself.",
      );
    }
    items.push(`ALB host rules cover ${coverageLabel(s.coverage)}; ${s.defaultHits.toFixed(0)}% of requests are outside a tenant host rule.`);
    items.push(`${s.ruleCount} ALB listener rules are configured; ${s.ruleHeadroom} remain under the ${RULE_LIMIT}-rule default quota.`);
    if (s.misrouted > 0) items.push("A default app can look like a successful response while the tenant is on the wrong service.");
    if (s.success === 100) items.push("Certificate scope, TLS path, and host rule coverage all agree.");
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Tenant route",
    description: "SAN certificate, host rules for every tenant, and TLS terminated at the ALB.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Rule headroom",
    description: "A correct tenant route with 95 rules on the listener, close to the default quota.",
    tone: "warn",
    params: defaults({ tenantHost: 1, certificateScope: 1, ruleCoverage: 2, tlsTermination: 0, ruleCount: 95 }),
  },
  {
    id: "failure",
    label: "Wildcard gap",
    description: "A multi-level tenant host is requested while the certificate is only a one-label wildcard.",
    tone: "crit",
    params: defaults({ tenantHost: 3, certificateScope: 1, ruleCoverage: 2, tlsTermination: 0, ruleCount: 24 }),
  },
  {
    id: "recovery",
    label: "SAN covers the tenant",
    description: "The same multi-level host with a SAN certificate and a matching host rule.",
    tone: "ok",
    params: defaults({ tenantHost: 3, certificateScope: 2, ruleCoverage: 2, tlsTermination: 0, ruleCount: 24 }),
  },
];

const experiment: Experiment = {
  id: "predict-wildcard-gap",
  title: "Predict what the wildcard covers",
  simId: "host-routing",
  question:
    "The listener has a *.meridian.internal certificate and a host rule for app.eu.meridian.internal. A client requests app.eu.meridian.internal. What happens first?",
  prediction: {
    options: [
      { id: "cert-fails", label: "The TLS handshake fails because the wildcard covers only one subdomain level." },
      { id: "rule-fails", label: "TLS succeeds, but the host rule does not match because the host is too long." },
      { id: "default", label: "TLS succeeds and the default rule serves the request." },
      { id: "works", label: "It works because the wildcard covers every subdomain under meridian.internal." },
    ],
    correctOptionId: "cert-fails",
    explanation:
      "A *.meridian.internal certificate covers app.meridian.internal, api.meridian.internal, and admin.meridian.internal, but not app.eu.meridian.internal. The wildcard replaces exactly one label and does not cover the apex or a multi-level name. Certificate selection happens during the TLS handshake, before the ALB reads the HTTP host header, so the host rule is never evaluated.",
  },
  setup: defaults({ tenantHost: 3, certificateScope: 1, ruleCoverage: 2, tlsTermination: 0, ruleCount: 24 }),
  runFor: 10,
  observe: [
    "TLS handshake failures reach 100% and successful requests fall to zero.",
    "The target groups stay healthy but receive no traffic.",
    "Certificate coverage is 0% even though the host rule exists for the tenant.",
    "Changing the rule priority or adding a rule cannot fix a handshake failure.",
  ],
  explain:
    "The certificate's subject alternative names decide whether the client can verify the name. The wildcard matches one label, so app.eu has one label too many. The request never becomes HTTP, which is why the target group metrics are empty. The fix is a certificate that explicitly covers the tenant, either a SAN entry or an exact certificate.",
  fix: defaults({ tenantHost: 3, certificateScope: 2, ruleCoverage: 2, tlsTermination: 0, ruleCount: 24 }),
  debrief:
    "With a SAN certificate, the handshake succeeds and the host rule forwards the request to the tenant target group. The rule was correct all along. The tradeoff is certificate management: every new tenant host must be added to the certificate or covered by a carefully scoped wildcard, and the certificate list per listener has its own quota.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Host and path routing uses the HTTP request fields to choose a target group. The host header carries the domain name the client requested; the path carries the resource. An Application Load Balancer (ALB) listener can match both with listener rules. The rules run in priority order, and the first match wins. Host routing is usually the cheapest way to put several tenants or services behind one load balancer, but it depends on the ALB being able to read the HTTP request.",
  },
  {
    type: "p",
    text: "To read the host header, the ALB must terminate TLS. During the TLS handshake, the client sends the server name with the Server Name Indication (SNI) extension. The ALB chooses a certificate whose subject or subject alternative names (SANs) cover that name. A wildcard certificate such as *.meridian.internal covers exactly one label: app.meridian.internal, api.meridian.internal, and admin.meridian.internal, but not meridian.internal or app.eu.meridian.internal. Certificate selection happens before any HTTP host rule.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, DNS, ALB HTTPS listener, certificate selection, host or path rule, target group. DNS points the tenant names at the ALB. The TLS listener presents a matching certificate. The host rule selects the tenant target group. If an NLB sits in front with a TCP listener that forwards to the ALB, TLS can still terminate at the ALB and host routing still works. If that NLB forwards encrypted bytes all the way to the targets, the ALB is bypassed and host routing must move to the targets.",
  },
  {
    type: "compare",
    leftTitle: "Terminate TLS at the ALB",
    rightTitle: "NLB TCP passthrough to targets",
    rows: [
      { label: "Host header", left: "Visible to ALB host rules", right: "Encrypted; ALB is bypassed and targets must route" },
      { label: "Certificate", left: "Managed on the ALB, selected with SNI", right: "Managed on each target" },
      { label: "Routing", left: "Centralized host and path rules", right: "Must happen in the target application or a proxy" },
      { label: "End-to-end encryption", left: "Client to ALB; re-encrypt to targets if required", right: "Client to target" },
      { label: "Operational cost", left: "Certificate and rule management on one resource", right: "Certificate management on every target" },
    ],
  },
  {
    type: "p",
    text: "Certificate scope and rule scope are separate failure domains. A missing rule produces an HTTP response from the default action; a missing certificate produces a TLS handshake failure and no HTTP request at all. Diagnose in that order: first can the client complete TLS for this host, then did an HTTP rule match it.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "TLS handshake failures and certificate coverage for the requested host.",
      "Default-route share, host rule coverage, and successful request share.",
      "Listener rules used and headroom against the 100-rule default quota.",
      "A target group node that can stay healthy while receiving zero traffic because TLS failed earlier.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with the SAN certificate and a matching host rule. Switch the certificate to the wildcard and request app.eu.meridian.internal. TLS fails before routing. Switch the TLS path to NLB passthrough with the SAN certificate: TLS succeeds at the targets, the NLB replaces the ALB in the path, and the ALB host rules are bypassed.",
  },
  {
    type: "table",
    headers: ["Symptom", "Layer", "First check"],
    rows: [
      ["Handshake error for one tenant", "Certificate", "SAN entries and wildcard label depth" ],
      ["TLS succeeds, tenant gets the default app", "Host rule", "Rule existence, condition match, and priority" ],
      ["Rule cannot be added", "Quota", "Rules per ALB and overlap with existing rules" ],
      ["ALB host rules bypassed", "TLS path", "Whether an NLB TCP listener sends traffic directly to the targets" ],
    ],
  },
  { type: "sim", simId: "host-routing" },
  { type: "experiment", experimentId: "predict-wildcard-gap" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The wildcard certificate covered app, api, and admin, but not app.eu. The client's TLS handshake for app.eu failed before the ALB read the host header, so the host rule never ran. The target groups were healthy and received no traffic. Replacing the certificate with one that has a SAN for app.eu fixed the handshake, and the existing host rule then routed the request correctly.",
  },
  {
    type: "p",
    text: "The second failure mode is different: with an NLB TCP listener passing encrypted bytes to the targets, the handshake can succeed at the target but the ALB is bypassed. The target serves its default app unless it routes the host itself, even though every certificate and rule is valid. The TLS path decides which layer can route.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ALB: `ClientTLSNegotiationErrorCount` for handshake failures, `RequestCount` by target group, and `RuleEvaluations` for rule work.",
      "Access logs: the host header, the certificate presented, the chosen target group, and the response code. A host with no HTTP log line points to TLS.",
      "Certificates: `describe-certificates` and `describe-listener-certificates`, including SAN entries and the default certificate.",
      "DNS: the tenant name must resolve to the ALB, and the certificate must cover the name the client actually uses.",
      "Rules: `describe-rules` for host conditions, priorities, and the default action; Service Quotas for the rules-per-ALB limit.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Test the TLS handshake with the tenant host name and SNI before changing any rule. If the handshake fails, fix the certificate scope. If it succeeds and the tenant still lands on the default app, check the host condition, rule priority, and whether TLS actually terminates at the ALB.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Decide where TLS terminates; host routing requires a layer that can read the decrypted request.",
      "Inventory every tenant host and its label depth.",
      "Issue or attach a certificate that covers each host, using SANs or a deliberately scoped wildcard.",
      "Add a host rule for each tenant and place it before any broad fallback.",
      "Keep the default action explicit and monitor its hit rate.",
      "Verify the handshake with SNI, then verify the target group in the access log.",
      "Check the rules-per-ALB quota before onboarding the next tenant.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A wildcard certificate is convenient for one-label tenants but does not cover the apex or multi-level names; a SAN certificate is precise but must be updated for each host.",
      "Terminating TLS at the ALB centralizes certificates and routing but requires re-encryption if traffic to targets must also be encrypted.",
      "Passing TLS through to targets preserves end-to-end encryption but moves host routing into the application or a proxy.",
      "One ALB with host rules is cheaper than an ALB per tenant but shares rule limits, certificate limits, and blast radius.",
      "A default action that returns a fixed response is obvious; a default that forwards to a shared app can hide a missing tenant rule.",
      "More host rules improve isolation but add evaluation work and overlap risk; consolidate routes that share a target group.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "where-host-routing",
    question:
      "You need to route api.meridian.internal and app.meridian.internal to different services. Where does routing belong, and what has to be true first?",
    difficulty: 2,
    hints: [
      "Host routing needs the decrypted HTTP request.",
      "Certificate coverage is a separate prerequisite.",
    ],
    answer:
      "I would put both names on an ALB HTTPS listener, terminate TLS at the ALB, and use host conditions to forward each name to its own target group. The certificate must cover both names, either with a wildcard that matches one label or with SAN entries. DNS must point both names at the ALB. I would keep the default rule explicit and place the host rules before any broad fallback. If an NLB sits in front and forwards TCP to the ALB, the ALB still terminates TLS and sees the host. If the NLB forwards encrypted bytes directly to the targets, the ALB is bypassed and host routing must happen at the application.",
    followUps: [
      "What certificate would you choose for a new multi-level tenant?",
      "How would you verify the host rule matched?",
      "What changes if the services are in different VPCs?",
    ],
    redFlags: [
      "Routes by host at a TCP listener.",
      "Ignores certificate coverage.",
      "Uses the load balancer DNS name in the certificate.",
    ],
    rubric: [
      "Places routing at a request-aware layer.",
      "Names certificate coverage and DNS.",
      "Keeps the default rule explicit.",
      "Explains the passthrough limitation.",
    ],
  },
  {
    id: "wildcard-scope",
    question:
      "A *.meridian.internal certificate works for app and api but fails for app.eu.meridian.internal. Why, and what do you do?",
    difficulty: 2,
    hints: [
      "A wildcard replaces one label.",
      "The certificate is selected before the HTTP host header is read.",
    ],
    answer:
      "A wildcard certificate covers exactly one subdomain level. app.meridian.internal and api.meridian.internal each have one label before the base domain, so the wildcard matches. app.eu.meridian.internal has two labels, so it does not match. The TLS handshake fails before the ALB can evaluate a host rule. I would add app.eu.meridian.internal as a SAN on the certificate or issue an exact certificate for it, attach it to the listener, and verify SNI selects it. I would not try to fix this with a rule priority change.",
    followUps: [
      "Does the wildcard cover the apex meridian.internal?",
      "How does SNI choose among multiple certificates?",
      "What happens if a matched certificate is incompatible with the client?",
    ],
    redFlags: [
      "Assumes the wildcard covers every depth.",
      "Changes the host rule instead of the certificate.",
      "Forgets that the handshake precedes HTTP routing.",
    ],
    rubric: [
      "Explains one-label wildcard scope.",
      "Places the failure before HTTP routing.",
      "Adds a SAN or exact certificate.",
      "Verifies with SNI.",
    ],
  },
  {
    id: "tls-ok-default",
    question:
      "TLS succeeds for a tenant host, but the request lands on the default target group. What do you check?",
    difficulty: 3,
    hints: [
      "The handshake is fine; the problem is after decryption.",
      "A rule may be missing, shadowed, or unable to see the host.",
    ],
    answer:
      "I would first confirm the TLS path. If an NLB TCP listener forwards encrypted bytes directly to the targets, the ALB is bypassed and no host rule can run; the target must route the host itself. If TLS terminates at the ALB, I would run describe-rules and look for a host condition that matches the exact name, check its priority against any broad rule, and confirm the rule is attached to the listener. I would read the access log to see the host header and the chosen target group. I would also check whether the host rule count is near the quota, because a new rule may not have deployed.",
    followUps: [
      "How would you prove the rule exists but is shadowed?",
      "What would you put in the default action?",
      "How would you test this before the next tenant onboarding?",
    ],
    redFlags: [
      "Starts by changing the certificate.",
      "Assumes the default rule is harmless.",
      "Ignores the TLS termination point.",
    ],
    rubric: [
      "Checks termination point first.",
      "Inspects host condition and priority.",
      "Uses access logs.",
      "Considers rule quota and default action.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every tenant host is listed with its certificate coverage and rule.",
      "Wildcard certificates are checked against multi-level and apex names.",
      "TLS termination point and host-routing layer are documented.",
      "The default rule has an intentional, observable action.",
      "Rules-per-ALB headroom and certificate-per-listener limits are tracked.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Test the TLS handshake with the real host name and SNI.",
      "Separate handshake failures from HTTP routing failures.",
      "Check the host condition, rule priority, and default action.",
      "Confirm TLS terminates at the ALB before debugging host rules.",
      "Read the access log for the host header and chosen target group.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a synthetic TLS and HTTP check for every tenant host.",
      "Verify certificate renewal covers all SANs.",
      "Review rule count and consolidate overlapping host rules.",
      "Document the certificate and routing ownership for the next tenant.",
    ],
  },
];

const references = [
  {
    title: "Condition types for listener rules",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-condition-types.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Host and path conditions, wildcard behavior, and match limits.",
  },
  {
    title: "SSL certificates for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/https-listener-certificates.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Default certificate, SNI certificate list, wildcard scope, and certificate selection.",
  },
  {
    title: "Listener rules for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-rules.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Priority order, first match, default rule, and rule components.",
  },
  {
    title: "Quotas for your Application Load Balancers",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-limits.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Rules per ALB, certificates per ALB, and other listener limits.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "host-routing": {
      model: hostRoutingModel,
      presets,
      instructions:
        "Start with the SAN certificate and a matching host rule. Switch to the wildcard and request app.eu; TLS fails before routing. Switch the TLS path to NLB passthrough with the SAN certificate and watch the NLB replace the ALB, then restore ALB termination and verify the tenant target group.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Request volume, latency, and the four-host inventory are teaching values. AWS documents wildcard scope, SNI certificate selection, host-rule behavior, and the 100-rule default quota; the exact tenant set and certificate limits depend on the account.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-alb-rule-priority", "traffic-alb-target-groups", "traffic-tls-termination"],
};

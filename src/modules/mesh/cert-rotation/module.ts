import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "certLifetimeDays",
    label: "Leaf certificate lifetime",
    min: 7,
    max: 90,
    step: 1,
    value: 30,
    unit: " d",
    group: "Certificate",
    help: "Validity period of a data plane proxy certificate. Kuma's built-in CA defaults to 30 days.",
    format: "number" as const,
  },
  {
    id: "renewalLeadDays",
    label: "Renewal lead time",
    min: 0,
    max: 30,
    step: 1,
    value: 7,
    unit: " d",
    group: "Automation",
    help: "How early automation requests a replacement. Zero means renewal starts at expiry, which is a race, not a plan.",
    format: "number" as const,
  },
  {
    id: "trustOverlapDays",
    label: "Trust bundle overlap",
    min: 0,
    max: 30,
    step: 1,
    value: 7,
    unit: " d",
    group: "Trust",
    help: "How long the old CA remains trusted after a new leaf is issued. Zero drops the old trust before every peer has the new bundle.",
    format: "number" as const,
  },
  {
    id: "reloadIntervalHours",
    label: "Certificate reload interval",
    min: 0,
    max: 24,
    step: 1,
    value: 4,
    unit: " h",
    group: "Reload",
    help: "How often the proxy reloads certificates. Zero means renewal happens but the proxy keeps serving the old certificate.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Outcome {
  lifetime: number;
  lead: number;
  overlap: number;
  reload: number;
  handshakeFailures: number;
  expiredCerts: number;
  notReloaded: number;
  trustRejections: number;
  riskDays: number;
  lateRenewal: boolean;
}

function compute(p: Params): Outcome {
  const lifetime = Math.max(1, num(p, "certLifetimeDays", 30));
  const lead = Math.min(lifetime, Math.max(0, num(p, "renewalLeadDays", 7)));
  const overlap = Math.max(0, num(p, "trustOverlapDays", 7));
  const reload = Math.max(0, num(p, "reloadIntervalHours", 4));
  const lateRenewal = lead / lifetime < 0.05;
  let handshakeFailures = 0;
  if (reload === 0) handshakeFailures = 100;
  else if (lead === 0) handshakeFailures = 40;
  else {
    if (overlap === 0) handshakeFailures += 12;
    if (lateRenewal) handshakeFailures += 3;
  }
  return {
    lifetime,
    lead,
    overlap,
    reload,
    handshakeFailures: Math.min(100, handshakeFailures),
    expiredCerts: reload === 0 ? 100 : lead === 0 ? 40 : 0,
    notReloaded: reload === 0 ? 100 : 0,
    trustRejections: overlap === 0 && reload > 0 && lead > 0 ? 12 : 0,
    riskDays: Math.max(0, 3 - lead),
    lateRenewal,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(o: Outcome, seed: number): SimFrame {
  const proxyHealth = healthFor(o.handshakeFailures, 1, 5);
  const caHealth = o.overlap === 0 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "control-plane",
        label: "Kuma control plane",
        kind: "mesh",
        health: o.reload === 0 ? "warn" : "ok",
        throughput: 0,
        sublabel: o.reload === 0 ? "renewal only · no reload" : "renewal automation",
        detail: `Issues and rotates data plane certificates. Kuma's built-in CA rotates proxies after 4/5 of the validity period by default. Issuing a new certificate is not the same as loading it.`,
        meta: { view: "flow" },
      },
      {
        id: "ca",
        label: "CA · trust bundle",
        kind: "mesh",
        health: caHealth,
        throughput: 0,
        sublabel: `${o.overlap}d overlap`,
        detail: `The trust bundle tells a peer which certificate authorities to accept. During rotation, the old and new CA must overlap until every proxy has the new bundle; zero overlap creates a trust gap even when every leaf is valid.`,
        meta: { view: "flow" },
      },
      {
        id: "proxy-a",
        label: "Envoy A · east",
        kind: "mesh",
        health: proxyHealth,
        utilization: clamp(o.handshakeFailures / 100),
        throughput: 10_000,
        sublabel: o.reload === 0 ? "serving expired cert" : `SDS reload every ${o.reload}h`,
        detail: `The proxy obtains certificates through the Secret Discovery Service (SDS) and reloads them without a restart. If reload is disabled or stalled, the proxy keeps serving the old certificate after it expires.`,
        meta: { view: "flow" },
      },
      {
        id: "proxy-b",
        label: "Envoy B · west",
        kind: "mesh",
        health: proxyHealth,
        utilization: clamp(o.handshakeFailures / 100),
        throughput: 10_000,
        sublabel: o.reload === 0 ? "serving expired cert" : `SDS reload every ${o.reload}h`,
        detail: `A second proxy with the same rotation configuration. A partial rollout can leave one proxy on the old cert or old trust bundle while the other is current.`,
        meta: { view: "flow" },
      },
      {
        id: "payments",
        label: "Payments service",
        kind: "service",
        health: proxyHealth,
        utilization: clamp(o.handshakeFailures / 100),
        throughput: 10_000 * (1 - o.handshakeFailures / 100),
        sublabel: "mTLS inbound",
        detail: `Rejects handshakes from peers whose certificate is expired or not trusted. The failure is at the TLS layer, before any HTTP request or application log.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("cp-ca", "control-plane", "ca", 1, "ok"),
      edge("ca-a", "ca", "proxy-a", 1, proxyHealth),
      edge("ca-b", "ca", "proxy-b", 1, proxyHealth),
      edge("a-payments", "proxy-a", "payments", 1, proxyHealth),
      edge("b-payments", "proxy-b", "payments", 1, proxyHealth),
    ],
    metrics: [
      metric("handshake-failures", "Failed mTLS handshakes", o.handshakeFailures, "%", 1, 5, "percent"),
      metric("expired-certs", "Proxies serving expired certs", o.expiredCerts, "%", 1, 20, "percent"),
      metric("not-reloaded", "Proxies not reloading", o.notReloaded, "%", 1, 20, "percent"),
      metric("trust-rejections", "Trust bundle rejections", o.trustRejections, "%", 1, 5, "percent"),
      metric("rotation-risk", "Rotation margin gap", o.riskDays, " d", 1, 3, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      lifetime: o.lifetime,
      lead: o.lead,
      overlap: o.overlap,
      reload: o.reload,
      err: o.handshakeFailures,
      trust: o.trustRejections,
      reloadSeen: 0,
      trustSeen: 0,
      paramsKey: "",
    },
    summary: `${o.handshakeFailures.toFixed(1)}% handshake failures; ${o.expiredCerts}% expired; ${o.trustRejections}% trust rejections; ${o.reload}h reload.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = Math.abs(item.value) * 0.01 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.99 + 0.02 * Math.sin((index + (seed % 6)) / 2.4)) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "handshake-failures",
    metricId: "handshake-failures",
    warn: 1,
    crit: 5,
    title: "mTLS handshakes are failing across the mesh",
    cause:
      "A proxy is presenting an expired certificate, a peer does not trust the current CA, or the proxy never loaded the renewed certificate. The failure happens at TLS, before the application sees the request.",
    fix:
      "Check certificate expiry and the trust bundle on both sides. Confirm that the proxy loaded the renewed certificate through SDS. Fix reload first if certificates are valid but stale.",
    checkFirst: [
      "Open /certs on the proxy and read days until expiration.",
      "Check whether renewed certificates were loaded, not only issued.",
      "Check the trust bundle on the peer that rejects the handshake.",
    ],
  },
  {
    id: "expired-certs",
    metricId: "expired-certs",
    warn: 1,
    crit: 20,
    title: "Proxies are serving an expired certificate",
    cause:
      "Automation may have renewed the certificate, but the proxy kept the old one because reload is disabled or stalled. Expiry is a scheduled outage when nothing loads the replacement.",
    fix:
      "Enable automated reload through SDS, or restart the proxies as a fallback. Add an alert well before expiry and verify the loaded certificate, not just the issued one.",
    checkFirst: [
      "Compare issuance time with the proxy's loaded certificate.",
      "Check the reload interval and SDS connection.",
      "Check whether the control plane can reach the proxy.",
    ],
  },
  {
    id: "trust-rejections",
    metricId: "trust-rejections",
    warn: 1,
    crit: 5,
    title: "Peers reject certificates from the new trust bundle",
    cause:
      "The old CA was removed from the trust bundle before every peer received the new one. The leaf certificate can be valid and still be rejected because its issuer is no longer trusted.",
    fix:
      "Restore the old CA to the bundle, roll the new bundle to every peer, and only then remove the old CA. Overlap is a rollout requirement, not a grace period.",
    checkFirst: [
      "Compare the trust bundle on the client and server proxies.",
      "Check when the old CA was removed and which peers still use it.",
      "Check whether the failure is one direction or both.",
    ],
  },
  {
    id: "rotation-risk",
    metricId: "rotation-risk",
    warn: 1,
    crit: 3,
    title: "The renewal margin is too thin for a failed automation run",
    cause:
      "Renewal starts too close to expiry relative to the certificate lifetime. A failed job, a slow control plane, or a holiday window leaves no time to retry before the certificate expires.",
    fix:
      "Renew at a fixed fraction of the lifetime with room for at least one retry, and alert on the remaining margin. Short-lived certificates need more reliable automation, not less.",
    checkFirst: [
      "Compare the renewal lead with the certificate lifetime and job frequency.",
      "Check whether the renewal job has retries and alerting.",
      "Check the last successful renewal and the next scheduled run.",
    ],
  },
];

function advanceFlags(frame: SimFrame, next: SimFrame): void {
  next.flags.reloadSeen = Number(frame.flags.reloadSeen ?? 0);
  next.flags.trustSeen = Number(frame.flags.trustSeen ?? 0);
}

export const certRotationModel: SimModel = {
  id: "cert-rotation",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const o = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(o, seed);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: key };
    advanceFlags(frame, next);
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const jitter = rng.between(-0.006, 0.006);
    next.metrics = next.metrics.map((item) =>
      item.id === "handshake-failures" ? { ...item, value: Math.max(0, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    const prevErr = Number(frame.flags.err ?? 0);
    const prevTrust = Number(frame.flags.trust ?? 0);
    if (o.reload === 0 && o.expiredCerts > 0 && next.flags.reloadSeen !== 1) {
      pushEvent(next, {
        id: "reload-disabled",
        at: frame.t,
        severity: "crit",
        title: "Certificate reload is disabled",
        detail: `Renewal may still run, but the proxy keeps serving its old certificate. ${o.expiredCerts}% of proxies are expired.`,
        nodeId: "proxy-a",
        metricId: "expired-certs",
      });
      next.flags.reloadSeen = 1;
    }
    if (o.trustRejections > 0 && prevTrust === 0 && next.flags.trustSeen !== 1) {
      pushEvent(next, {
        id: "trust-gap",
        at: frame.t,
        severity: "crit",
        title: "The old CA left the trust bundle too early",
        detail: `${o.trustRejections}% of handshakes fail because a peer does not trust the new issuer. Restore the old CA and complete the bundle rollout.`,
        nodeId: "ca",
        metricId: "trust-rejections",
      });
      next.flags.trustSeen = 1;
    }
    if (o.handshakeFailures >= 5 && prevErr < 5) {
      pushEvent(next, {
        id: "mtls-failure",
        at: frame.t,
        severity: "crit",
        title: "mTLS handshakes are failing",
        detail: `${o.handshakeFailures.toFixed(1)}% of handshakes fail. Check expiry, the loaded certificate, and the trust bundle before changing the application.`,
        nodeId: "payments",
        metricId: "handshake-failures",
      });
    }
    if (o.handshakeFailures < 1 && prevErr >= 1) {
      pushEvent(next, {
        id: "mtls-recovered",
        at: frame.t,
        severity: "info",
        title: "mTLS handshakes are succeeding again",
        detail: "Certificates are valid and trusted. Confirm that the renewal margin and the alert are in place before closing.",
        nodeId: "payments",
      });
    }
    next.summary = `${o.handshakeFailures.toFixed(1)}% handshake failures; ${o.expiredCerts}% expired; ${o.trustRejections}% trust rejections; ${o.reload}h reload.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const o = compute(p);
    return [
      `Leaf lifetime is ${o.lifetime} days and renewal starts ${o.lead} days before expiry. Kuma's built-in CA rotates at 4/5 of the validity period by default, which is 6 days before expiry for a 30-day certificate.`,
      `${o.expiredCerts}% of proxies are serving an expired certificate; ${o.notReloaded}% are not reloading; ${o.trustRejections}% of handshakes fail on trust.`,
      `Trust bundle overlap is ${o.overlap} days. Overlap is the window in which both the old and new CA are trusted; zero overlap removes the old trust before every peer has the new bundle.`,
      "Issuing a certificate is not loading it. Envoy receives certificates through SDS and can reload without a restart, but a disabled or stalled SDS stream leaves the old certificate in place.",
      "The rotation margin gap is the distance between the renewal lead and the minimum safe margin. A short-lived certificate reduces the exposure window and increases the cost of a missed renewal.",
    ];
  },
  legend: [
    { label: "Valid", tone: "ok" },
    { label: "Renewal risk", tone: "warn" },
    { label: "Handshake failing", tone: "crit" },
    { label: "Expired", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "30-day certificates, renewal 7 days ahead, 7-day trust overlap, and a reload every 4 hours.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Late renewal",
    description: "Renewal starts 1 day before expiry. The certificate is still valid, but the margin is too thin for a retry.",
    tone: "warn",
    params: defaults({ certLifetimeDays: 30, renewalLeadDays: 1, trustOverlapDays: 7, reloadIntervalHours: 4 }),
  },
  {
    id: "failure",
    label: "No reload",
    description: "Renewal runs 7 days ahead, but the proxy never reloads. At midnight the old certificate expires and every handshake fails.",
    tone: "crit",
    params: defaults({ certLifetimeDays: 30, renewalLeadDays: 7, trustOverlapDays: 7, reloadIntervalHours: 0 }),
  },
  {
    id: "trust-gap",
    label: "Trust gap",
    description: "The certificate renews and reloads, but the old CA is removed immediately. Peers with the old bundle reject the new leaf.",
    tone: "crit",
    params: defaults({ certLifetimeDays: 30, renewalLeadDays: 7, trustOverlapDays: 0, reloadIntervalHours: 4 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Renewal, overlap, and reload are all in place. Handshakes succeed and the old CA is retired after the overlap.",
    tone: "ok",
    params: defaults({ certLifetimeDays: 30, renewalLeadDays: 7, trustOverlapDays: 7, reloadIntervalHours: 4 }),
  },
];

const experiment: Experiment = {
  id: "predict-expiry-reload",
  title: "Predict what fails at midnight",
  simId: "cert-rotation",
  question:
    "Certificates have a 30-day lifetime. Automation renews them 7 days before expiry, but the proxies never load the replacement. What happens when the original certificate expires?",
  prediction: {
    options: [
      { id: "nothing", label: "Nothing, because the control plane already issued a replacement" },
      { id: "handshake", label: "Every handshake fails because the proxy still presents the expired certificate" },
      { id: "trust", label: "Only new connections fail until the trust bundle is rotated" },
      { id: "app", label: "The application returns 500 responses because its TLS library expires" },
    ],
    correctOptionId: "handshake",
    explanation:
      "Issuing a new certificate does not change what the proxy presents. Without a reload through SDS or a restart, the proxy keeps the old certificate and its private key. At expiry, every peer rejects the handshake, so requests fail at TLS before any application code runs. Renewal without reload is a scheduled outage.",
  },
  setup: defaults({ certLifetimeDays: 30, renewalLeadDays: 7, trustOverlapDays: 7, reloadIntervalHours: 0 }),
  runFor: 30,
  observe: [
    "The control plane has renewed the certificate, but the proxy still serves the old one.",
    "Expired certificates reach 100% and handshake failures reach 100%.",
    "The payments service receives no requests, so there is no application error log.",
    "Trust rejections stay at zero; this failure is expiry, not trust.",
  ],
  explain:
    "The certificate lifecycle has three separate steps: issue, distribute, and load. Automation handled issue and distribution, but not load. Envoy loads certificates through SDS, and without a reload it keeps the old certificate in memory. At expiry the peer rejects the handshake. The fix is not a longer certificate; it is a reliable reload path plus an alert that checks the loaded certificate before expiry.",
  fix: defaults({ certLifetimeDays: 30, renewalLeadDays: 7, trustOverlapDays: 7, reloadIntervalHours: 4 }),
  debrief:
    "With a 4-hour reload, the proxy presents the renewed certificate well before expiry, and handshakes succeed. The 7-day trust overlap covers peers that have not received the new bundle yet. The remaining risk is automation failure: the renewal margin gives at least one retry, and the expiry alert fires before the certificate is the only thing standing between the mesh and an outage.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Mesh mTLS gives every workload an identity certificate. The proxy presents the certificate to its peer, the peer verifies the signature against a trusted certificate authority, and both sides derive session keys. The leaf certificate has a validity period, the trust bundle says which authorities are accepted, and a rotation process replaces both before they expire. Kuma's built-in CA issues data plane proxy certificates for 30 days by default and rotates them after four fifths of that period.",
  },
  {
    type: "p",
    text: "Rotation has three steps that are easy to conflate: issue a new certificate, distribute it to the proxy, and make the proxy use it. A control plane can issue and distribute successfully while the proxy keeps serving the old certificate. The certificate is valid until it is not, and the old one expires on a clock that does not care whether the reload path works.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The control plane acts as the certificate authority or delegates to one. The proxy receives certificates through the Secret Discovery Service, or SDS, and reloads them without restarting the process. The peer validates the presented chain against its trust bundle. During a CA rotation, the old and new authorities must both be trusted for a window, because not every proxy receives the new bundle at the same moment.",
  },
  {
    type: "table",
    headers: ["Failure", "What is valid", "What the peer sees"],
    rows: [
      ["No reload", "A new certificate was issued", "The old, now-expired certificate"],
      ["Short renewal margin", "The certificate is still valid", "No time to retry if automation fails"],
      ["No trust overlap", "The new leaf is valid", "An issuer the peer does not trust"],
      ["Clock skew", "The certificate is valid on the issuer", "Not yet valid or already expired on the peer"],
      ["Partial rollout", "Some proxies reloaded", "Two identities or two trust bundles in one mesh"],
    ],
  },
  {
    type: "p",
    text: "The trust bundle is the part teams forget. A leaf can be correctly signed, correctly loaded, and still rejected because the peer does not trust the CA that signed it. Removing the old CA at the same moment the new leaf is issued creates a window where the new certificate is untrusted and the old one is no longer accepted. Overlap is a rollout requirement, not a grace period.",
  },
  {
    type: "compare",
    leftTitle: "Long-lived manual rotation",
    rightTitle: "Short-lived automated rotation",
    rows: [
      { label: "Exposure window", left: "Long, if a key is compromised", right: "Short, by design" },
      { label: "Operational cost", left: "Rare, manual, easy to forget", right: "Frequent, automated, must be reliable" },
      { label: "Failure mode", left: "A forgotten expiry takes down the mesh", right: "A broken automation run takes down the mesh faster" },
      { label: "Alerting", left: "Calendar reminder", right: "Expiry and reload telemetry" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A control plane, a CA and trust bundle, two Envoy proxies, and a payments service.",
      "Controls for certificate lifetime, renewal lead time, trust overlap, and reload interval.",
      "Failed handshakes, proxies serving expired certificates, proxies not reloading, trust rejections, and rotation margin.",
      "A CA node that warns when the trust bundle has no overlap.",
      "Events for disabled reload, a trust gap, handshake failure, and recovery.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Late renewal and read the margin gap before the error rate. Apply No reload and watch expired certificates reach 100% while trust rejections stay at zero. Apply Trust gap and compare. Then use Recovery and confirm both the expiry and trust metrics clear.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Teaching values",
    body: "Lifetimes, overlap windows, and error percentages are illustrative teaching values. Kuma's 30-day default and 4/5 rotation point are real; exact behavior depends on the CA backend and proxy configuration.",
  },
  { type: "sim", simId: "cert-rotation" },
  { type: "experiment", experimentId: "predict-expiry-reload" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The certificate was issued and distributed, but the proxy did not load it. At expiry, the proxy kept presenting the old certificate and every peer rejected the handshake. The application saw no requests and wrote no error, because the failure happened at TLS. In the trust-gap variant, the certificate was current and loaded, but the peer no longer trusted its issuer; the handshake failed for a different reason.",
  },
  {
    type: "p",
    text: "The healthy configuration had all three controls: enough renewal margin for a retry, an overlap window where both CAs were trusted, and a reload path that made the proxy present the new certificate. Removing any one of them produced a different failure, and the error rate alone did not say which one.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Envoy `/certs` with the loaded certificate, serial number, subject alternative names, and days until expiration.",
      "TLS handshake failures at the proxy, before HTTP status codes or application logs.",
      "The trust bundle on both sides of a failing connection, compared by issuer and not only by expiry.",
      "Kuma certificate rotation telemetry: last regeneration, expiration, and regeneration count per data plane proxy.",
      "Control-plane and SDS health: whether renewed certificates reach the proxy and whether the stream is connected.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the loaded certificate, not the issued one. Read /certs for expiry, then check whether the proxy reloaded after renewal. If the certificate is current, compare the trust bundle on both peers. Expiry and trust produce the same client symptom but need different fixes.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Restore service: reload the certificate on the proxy, or restart it if reload is unavailable.",
      "If the leaf is current, restore the old CA to the trust bundle and complete the bundle rollout.",
      "Fix the reload path and verify it with a real rotation, not a config review.",
      "Set renewal at a safe fraction of the lifetime, with at least one retry before expiry.",
      "Alert on days until expiry and on reload failures, not only on handshake errors.",
      "Keep the old CA in the bundle until every proxy has the new one, then remove it.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Short-lived certificates reduce the exposure window and increase the frequency of automation failures.",
      "Long-lived certificates reduce operational load and increase the blast radius of a leaked key.",
      "Trust overlap adds a window where two CAs are trusted; removing it too early causes a trust gap.",
      "Automated reload is faster and safer than restarts, but it depends on a working SDS stream and control plane.",
      "A manual rotation is easy to understand and easy to forget; the calendar is not a monitoring system.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "expiry-midnight",
    question:
      "Certificates expire at midnight and handshakes start failing. What do you check, and what is the fastest safe fix?",
    difficulty: 3,
    hints: [
      "Issued is not loaded.",
      "TLS fails before the application.",
    ],
    answer:
      "I would read the loaded certificate on a failing proxy and compare its expiry with the certificate the control plane issued. If the loaded one is expired, the reload path failed. The fastest safe fix is to reload or restart the proxy so it presents the renewed certificate, then verify /certs and a test handshake. If the leaf is current, I would compare the trust bundle on both peers, because the rejection may be an untrusted issuer rather than expiry. After service is restored, I would fix the automation and add an expiry alert.",
    followUps: [
      "How would you tell expiry from trust failure?",
      "What would you do if only one proxy is affected?",
      "How would you prevent the next midnight?",
    ],
    redFlags: [
      "Restarts everything before reading the certificate.",
      "Assumes the control plane is down.",
      "Checks only the application.",
    ],
    rubric: [
      "Compares loaded and issued certificates.",
      "Names reload or restart as the fast fix.",
      "Separates expiry from trust.",
      "Adds prevention.",
    ],
  },
  {
    id: "trust-overlap",
    question:
      "Why does a CA rotation need an overlap window, and what happens if it is zero?",
    difficulty: 3,
    hints: [
      "Peers receive the new bundle at different times.",
      "A valid leaf can be untrusted.",
    ],
    answer:
      "During a CA rotation, some peers have the new trust bundle and some still have the old one. An overlap window keeps both CAs trusted while the bundles roll out, so a peer with the old bundle still accepts a leaf signed by the old CA and a peer with the new bundle accepts the new one. With zero overlap, the old CA is removed before every peer has the new bundle, so a valid new leaf is rejected by peers that still trust only the old CA. The fix is to restore the old CA, finish the rollout, and only then remove it.",
    followUps: [
      "How would you verify every peer has the new bundle?",
      "What is the failure direction?",
      "How long should the overlap be?",
    ],
    redFlags: [
      "Assumes all proxies update at once.",
      "Treats overlap as optional.",
      "Rotates the leaf without rotating trust.",
    ],
    rubric: [
      "Explains staggered rollout.",
      "Requires both CAs during overlap.",
      "Describes the trust gap.",
      "Names a verification step.",
    ],
  },
  {
    id: "short-lived-certs",
    question:
      "Would you shorten certificate lifetimes to one day? What must be true first?",
    difficulty: 4,
    hints: [
      "Shorter lifetime means more automation, not less.",
      "The reload path is part of the design.",
    ],
    answer:
      "Only if issuance, distribution, reload, and alerting are reliable enough to run many times a day. A one-day certificate reduces the exposure window after a key compromise, but it also reduces the time to recover from a failed renewal. I would need automated retries, an alert on renewal failure and loaded expiry, a tested reload path through SDS, and a way to rotate trust bundles without a gap. I would start by shortening gradually and measuring renewal success and handshake failures before going to one day.",
    followUps: [
      "What would you measure before shortening again?",
      "How would you handle a control-plane outage?",
      "What is the failure mode of a one-day certificate?",
    ],
    redFlags: [
      "Shortens lifetime without automation.",
      "Assumes reload is instantaneous.",
      "Has no expiry alert.",
    ],
    rubric: [
      "Requires reliable automation.",
      "Names retries and alerting.",
      "Tests reload and trust.",
      "Shortens gradually.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every proxy has an automated reload path through SDS or an equivalent.",
      "Renewal starts with enough margin for at least one retry before expiry.",
      "The trust bundle overlaps during CA rotation, and removal is a separate step.",
      "Alerts cover days until expiry, reload failure, and handshake failures.",
      "Rotation is tested end to end with a real certificate, not only a config review.",
      "The runbook says how to read the loaded certificate and how to force a reload.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the loaded certificate on a failing proxy; compare it with the issued one.",
      "Check whether the proxy reloaded after renewal.",
      "If the leaf is current, compare trust bundles on both peers.",
      "Reload or restart the proxy to restore service, then verify a handshake.",
      "Restore the old CA before completing a broken trust rollout.",
      "Record whether the cause was expiry, reload, or trust.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix the reload or trust path and test it with a real rotation.",
      "Add or repair the expiry alert and the reload-failure alert.",
      "Review the renewal margin against the automation's retry budget.",
      "Verify that the old CA is removed only after every peer has the new bundle.",
      "Document the failure mode and the time to detect it.",
    ],
  },
];

const references = [
  {
    title: "Kuma mutual TLS and certificate rotation",
    url: "https://kuma.io/docs/latest/policies/mutual-tls/",
    publisher: "Kuma Project",
    kind: "docs" as const,
    note: "Data plane proxy certificates, the 30-day default, rotation at 4/5 of validity, and rotation telemetry.",
  },
  {
    title: "Kuma certificate management",
    url: "https://kuma.io/docs/latest/production/secure-deployment/certificates/",
    publisher: "Kuma Project",
    kind: "docs" as const,
    note: "CA backends, certificate issuance, and the trust material used by data plane proxies.",
  },
  {
    title: "SPIFFE concepts",
    url: "https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/",
    publisher: "SPIFFE Project",
    kind: "docs" as const,
    note: "Workload identities, SPIFFE IDs, and short-lived certificate rotation.",
  },
  {
    title: "Envoy Secret Discovery Service",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/security/secret",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "SDS configuration and certificate reload without a proxy restart.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cert-rotation": {
      model: certRotationModel,
      presets,
      instructions:
        "Start Healthy, then apply Late renewal, No reload, and Trust gap. Read loaded-certificate metrics before handshake failures. Use Recovery to confirm both expiry and trust clear.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Lifetimes and error percentages are teaching values; Kuma's 30-day default and 4/5 rotation behavior are documented.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-mtls", "mesh-ingress", "mesh-kuma-control-plane", "case-composite-cert-expiry"],
};

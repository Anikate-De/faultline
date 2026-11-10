import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  Params,
  ParamSpec,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SERVER_P95 = 200;
const PAGE_LOADS = 120;

const params: ParamSpec[] = [
  {
    id: "mobileShare",
    label: "Mobile sessions",
    min: 0,
    max: 100,
    step: 5,
    value: 60,
    unit: "%",
    group: "Audience",
    help: "Share of sessions on a phone-class device. Mobile sessions carry more rendering and network cost.",
    format: "percent",
  },
  {
    id: "networkRtt",
    label: "Mobile network RTT",
    min: 20,
    max: 400,
    step: 10,
    value: 180,
    unit: " ms",
    group: "Network",
    help: "Round-trip time on the mobile profile. Connection setup and request chains multiply this delay.",
    format: "ms",
  },
  {
    id: "bundleKb",
    label: "JavaScript bundle",
    min: 100,
    max: 3_000,
    step: 50,
    value: 900,
    unit: " KB",
    group: "Frontend",
    help: "Compressed JavaScript the browser must download, parse, and execute before the page settles.",
    format: "count",
  },
  {
    id: "thirdPartyScripts",
    label: "Third-party scripts",
    min: 0,
    max: 15,
    step: 1,
    value: 2,
    unit: "",
    group: "Frontend",
    help: "Tags, chat widgets, and analytics that run on the main thread. Each adds work and layout risk.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  mobileShare: number;
  networkRtt: number;
  bundleKb: number;
  thirdPartyScripts: number;
  desktopLcp: number;
  mobileLcp: number;
  lcp: number;
  cls: number;
  inp: number;
  mobileBlend: number;
}

function compute(p: Params): Computed {
  const mobileShare = Math.round(num(p, "mobileShare", 60));
  const networkRtt = Math.round(num(p, "networkRtt", 180));
  const bundleKb = Math.round(num(p, "bundleKb", 900));
  const thirdPartyScripts = Math.round(num(p, "thirdPartyScripts", 2));
  const desktopLcp =
    SERVER_P95 + 0.6 * networkRtt + 0.35 * bundleKb + 6 * thirdPartyScripts + 120;
  const mobileLcp =
    SERVER_P95 + 1.5 * networkRtt + 1.2 * bundleKb + 12 * thirdPartyScripts + 250;
  const mobileBlend = clamp((mobileShare - 20) / 60, 0, 1);
  const lcp = desktopLcp + (mobileLcp - desktopLcp) * mobileBlend;
  const cls = 0.02 + 0.025 * thirdPartyScripts + (bundleKb > 1_500 ? 0.05 : 0);
  const inp = 80 + 18 * thirdPartyScripts + 0.05 * bundleKb;
  return {
    mobileShare,
    networkRtt,
    bundleKb,
    thirdPartyScripts,
    desktopLcp,
    mobileLcp,
    lcp,
    cls,
    inp,
    mobileBlend,
  };
}

function healthFromLcp(value: number): Health {
  if (value >= 4_000) return "crit";
  if (value >= 2_500) return "warn";
  return "ok";
}

function healthFromInp(value: number): Health {
  if (value >= 500) return "crit";
  if (value >= 200) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metrics: [string, number, number][] = [
    ["lcp-p75", values.lcp, 30],
    ["cls-p75", values.cls * 100, 0.5],
    ["inp-p75", values.inp, 4],
    ["server-p95", SERVER_P95, 3],
  ];
  for (const [id, value, amplitude] of metrics) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value + Math.sin((index + (seed % 10)) / 2.7) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const lcpHealth = healthFromLcp(values.lcp);
  const inpHealth = healthFromInp(values.inp);
  return {
    t: 0,
    nodes: [
      {
        id: "user",
        label: "Real user",
        kind: "client",
        health: lcpHealth,
        sublabel: `${PAGE_LOADS} page loads/s, LCP ${(values.lcp / 1_000).toFixed(1)}s p75`,
        meta: { view: "flow" },
      },
      {
        id: "cdn",
        label: "CDN",
        kind: "cdn",
        health: "ok",
        sublabel: `${values.bundleKb} KB JS`,
        meta: { view: "flow" },
      },
      {
        id: "web",
        label: "Browser",
        kind: "service",
        health: inpHealth,
        sublabel: `INP ${values.inp.toFixed(0)}ms`,
        meta: { view: "flow" },
      },
      {
        id: "api",
        label: "Application API",
        kind: "service",
        health: "ok",
        throughput: PAGE_LOADS,
        sublabel: `server p95 ${SERVER_P95}ms`,
        meta: { view: "flow" },
      },
      {
        id: "rum",
        label: "RUM pipeline",
        kind: "storage",
        health: "ok",
        sublabel: "field sessions",
        meta: { view: "flow" },
      },
    ],
    edges: [
      { id: "user-cdn", from: "user", to: "cdn", rate: 1, health: lcpHealth },
      { id: "cdn-web", from: "cdn", to: "web", rate: 1, health: lcpHealth },
      { id: "web-api", from: "web", to: "api", rate: 1, health: "ok" },
      { id: "web-rum", from: "web", to: "rum", rate: 0.15, health: "ok" },
    ],
    metrics: [
      metric("lcp-p75", "Field LCP p75 (modeled)", values.lcp, "ms", 2_500, 4_000, "ms"),
      metric("cls-p75", "Field CLS p75 (×100)", values.cls * 100, "", 10, 25, "number"),
      metric("inp-p75", "Field INP p75", values.inp, "ms", 200, 500, "ms"),
      metric("server-p95", "Server p95", SERVER_P95, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, serverP95: SERVER_P95 },
    summary: `Modeled field LCP p75 ${(values.lcp / 1_000).toFixed(2)}s; CLS ${values.cls.toFixed(2)}; INP ${values.inp.toFixed(0)}ms; server p95 ${SERVER_P95}ms.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "lcp-p75",
    metricId: "lcp-p75",
    warn: 2_500,
    crit: 4_000,
    title: "Modeled field LCP p75 exceeds the user-experience budget",
    cause: "The largest content element appears late for real sessions. Device speed, network round trips, bundle execution, and render-blocking resources all add to the server response time.",
    fix: "Split field LCP by device, connection, and page. Reduce the largest element's resource cost first, then the JavaScript that delays rendering. Verify with field p75, not a lab run on a fast machine.",
    checkFirst: [
      "Split LCP p75 by device class and connection type.",
      "Inspect the LCP element and its resource timing.",
      "Compare server response time with the rest of the page load.",
    ],
  },
  {
    id: "cls-p75",
    metricId: "cls-p75",
    warn: 10,
    crit: 25,
    title: "Layout shift is disturbing real sessions",
    cause: "Content moves after first render because images lack dimensions, fonts swap late, or third-party tags inject elements above existing content.",
    fix: "Reserve space for images, ads, and embeds, load fonts with an appropriate display strategy, and move late-injected content below the fold or into a stable container.",
    checkFirst: [
      "Find the elements that shift in the field session replay or layout-shift entries.",
      "Check images and embeds for reserved dimensions.",
      "Check third-party tags that insert content after load.",
    ],
  },
  {
    id: "inp-p75",
    metricId: "inp-p75",
    warn: 200,
    crit: 500,
    title: "Interaction latency is above the field budget",
    cause: "The main thread is busy with long JavaScript tasks, hydration, or third-party work, so a tap waits before the browser can paint a response.",
    fix: "Break up long tasks, defer non-critical JavaScript, and move third-party work off the interaction path. Measure field INP by interaction type, not only page load time.",
    checkFirst: [
      "Identify the interactions with the worst INP in field data.",
      "Check long tasks around those interactions.",
      "Check third-party scripts and hydration cost.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const rumModel: SimModel = {
  id: "observability-rum-web-vitals",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.008, 0.008);
    next.metrics = next.metrics.map((item) =>
      item.id === "lcp-p75" || item.id === "inp-p75"
        ? { ...item, value: Math.max(0, item.value * (1 + jitter)) }
        : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.lcp >= 2_500 && frame.flags.fieldSlowSeen !== 1) {
      pushEvent(next, {
        id: "field-lcp-degraded",
        at: frame.t,
        severity: "warn",
        title: "Field p75 crosses the LCP budget",
        detail: `Mobile sessions are ${values.mobileShare}% of traffic and see about ${(values.mobileLcp / 1_000).toFixed(1)}s LCP, while the server p95 is ${SERVER_P95}ms.`,
        nodeId: "user",
        metricId: "lcp-p75",
      });
      next.flags.fieldSlowSeen = 1;
    }
    if (values.lcp < 2_500) next.flags.fieldSlowSeen = 0;
    next.summary = `Field LCP p75 ${(values.lcp / 1_000).toFixed(2)}s; CLS ${values.cls.toFixed(2)}; INP ${values.inp.toFixed(0)}ms; server p95 ${SERVER_P95}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `Desktop LCP is about ${(values.desktopLcp / 1_000).toFixed(2)}s; mobile LCP is about ${(values.mobileLcp / 1_000).toFixed(2)}s. At ${values.mobileShare}% mobile sessions, the field p75 lands ${values.mobileBlend > 0.5 ? "in the mobile range" : "between the two profiles"}.`,
      `The server contributes ${SERVER_P95}ms to both profiles. Network, bundle, and third-party work contribute the other ${Math.round(values.lcp - SERVER_P95)}ms at p75.`,
      `Each third-party script adds about 18ms of interaction work and 12ms of mobile LCP in this model; the bundle adds 1.2ms of mobile LCP per KB.`,
      `CLS is ${values.cls.toFixed(2)} raw, shown as ${(values.cls * 100).toFixed(0)} on the ×100 panel. Layout shift is a rendering problem; no server metric will show it.`,
      `A p75 is a percentile, not an average. One quarter of sessions are worse than every number on this panel.`,
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Needs work", tone: "warn" },
    { label: "Poor", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "60% mobile, 180ms RTT, a 900KB bundle, and two third-party scripts. Field p75 is inside the budget.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Heavier mobile mix",
    description: "70% mobile, a 1.8MB bundle, and four third parties. LCP, CLS, and INP all warn.",
    tone: "warn",
    params: defaults({ mobileShare: 70, networkRtt: 240, bundleKb: 1_800, thirdPartyScripts: 4 }),
  },
  {
    id: "failure",
    label: "Mobile release",
    description: "An 85% mobile audience on a 2.6MB bundle with eight third parties. LCP and CLS are critical while the API stays at 200ms.",
    tone: "crit",
    params: defaults({ mobileShare: 85, networkRtt: 300, bundleKb: 2_600, thirdPartyScripts: 8 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Ship a 700KB bundle, remove third parties, and return the mix to 60% mobile. All field metrics recover.",
    tone: "ok",
    params: defaults({ bundleKb: 700, thirdPartyScripts: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-field-gap",
  title: "Predict where the 4s goes",
  simId: "rum-web-vitals",
  question:
    "The API's server p95 is 200ms, but mobile users report a four-second load. Which signal explains the gap?",
  prediction: {
    options: [
      { id: "field", label: "Field LCP p75 includes device, network, bundle, and rendering time that the server metric never sees" },
      { id: "server-wrong", label: "The server p95 is measured incorrectly and the API is actually slow" },
      { id: "cache", label: "The CDN is missing every asset, so the server responds for each one" },
      { id: "dns", label: "DNS resolution alone accounts for the missing seconds" },
    ],
    correctOptionId: "field",
    explanation:
      "Server p95 measures the time from request to response. A browser also resolves, connects, downloads the document and assets, parses JavaScript, and renders. Field LCP measures when the largest element actually appears on the user's device and network.",
  },
  setup: defaults({ mobileShare: 85, networkRtt: 300, bundleKb: 2_600, thirdPartyScripts: 8 }),
  runFor: 20,
  observe: [
    "Field LCP p75 reaches about 4.1s while server p95 stays at 200ms.",
    "CLS reaches 27 on the ×100 panel (0.27 raw) and INP reaches about 350ms on the same sessions.",
    "The user node is critical and the API node is healthy, which locates the gap in the browser path.",
    "Reducing the bundle and third parties recovers LCP without changing the API.",
  ],
  explain:
    "The field metric is assembled in the browser from navigation, resource, paint, and layout observations. It includes the network profile, the device's main thread, the JavaScript the page must execute, and the resources that block rendering. None of that appears in a server-side p95. A lab run on a fast laptop can miss it too, which is why field p75 by device class is the number to trust.",
  fix: defaults({ mobileShare: 60, bundleKb: 700, thirdPartyScripts: 1 }),
  debrief:
    "The smaller bundle and fewer tags bring p75 LCP back under 2.5s and CLS under 0.1, while the API is unchanged at 200ms. The fix was in the browser path, not the server. Keep the field breakdown by device and connection so the next regression is visible before it reaches every mobile user.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Real user monitoring, or RUM, collects performance and interaction data from actual browser sessions. A small agent in the page records navigation timing, resource timing, paint events, layout shifts, and interactions, then sends a beacon to a collector. The result is field data: measurements from real devices, networks, and locations, not from a controlled test machine.",
  },
  {
    type: "p",
    text: "Core Web Vitals are three field metrics. Largest Contentful Paint (LCP) measures when the largest visible element appears; good is at or below 2.5 seconds and poor is above 4 seconds. Cumulative Layout Shift (CLS) measures unexpected movement; good is at or below 0.1 and poor is above 0.25. Interaction to Next Paint (INP) measures the delay before the page responds to an interaction; good is at or below 200 milliseconds and poor is above 500. These are the thresholds used in this module. The panel shows CLS multiplied by 100 so a score of 0.25 does not round to 0.3.",
  },
  {
    type: "p",
    text: "The field p75 in this model is a blended mix of desktop and mobile sessions, not a measured percentile. Threshold comparisons are inclusive, so a value exactly at 2.5s, 10 on the CLS panel, or 200ms is shown as a warning rather than good.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "RUM lives in the browser, after the request leaves your server. The path is device, network, CDN, browser main thread, API, and rendering. Server metrics such as response time and CPU stop at the API boundary. A page can have a 200ms server response and a four-second LCP because the browser had to download and execute a large bundle before the largest element could render.",
  },
  {
    type: "table",
    headers: ["Signal", "Measured where", "What it can miss"],
    rows: [
      ["Server p95", "API or load balancer", "Network, parsing, rendering, device speed"],
      ["Lab audit", "A fixed device and network profile", "Real device mix and real network conditions"],
      ["RUM field p75", "Real sessions in the browser", "Sessions that block the agent or never report"],
      ["Synthetic browser check", "A controlled browser from a chosen location", "The long tail of real devices and networks"],
    ],
  },
  {
    type: "p",
    text: "A percentile is not an average. The p75 is the value below which 75% of sessions fall; one quarter are worse. A healthy average can hide a slow mobile cohort, and a p75 can miss while a p99 is severe. Segment by device, connection, region, and page before you decide which users are affected.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Field LCP p75 (modeled) with the Core Web Vitals warning and poor lines.",
      "Field CLS p75 (shown ×100) and INP p75 on the same session population.",
      "Server p95 as a control that stays flat while the field metrics move.",
      "A user node that carries the field health and an API node that stays healthy, which separates the two paths.",
      "A mobile and desktop LCP split in the insights, so the percentile's composition is visible.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and compare field LCP with server p95. Apply Mobile release and watch the field metrics cross while the API stays at 200ms. Then apply Recovery and confirm p75 returns. Run the experiment before reading the debrief; the explanation stays hidden until you choose.",
  },
  { type: "sim", simId: "rum-web-vitals" },
  { type: "experiment", experimentId: "predict-field-gap" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The API answered in 200ms at p95 the whole time. The browser did not. On an 85% mobile audience with a 2.6MB bundle and eight third-party scripts, the field p75 LCP reached about 4.1 seconds. Layout shift crossed 0.25 and interaction latency reached about 350ms. The server metric was correct and irrelevant to the user's experience.",
  },
  {
    type: "p",
    text: "The recovery removed most of the JavaScript and all but one third-party tag, and returned the audience mix to 60% mobile. LCP fell to about 1.3 seconds and CLS to 0.05. Nothing changed in the API. The lesson is not that server metrics are wrong; it is that they answer a different question from field data.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "RUM dashboard: LCP, CLS, and INP p75 split by device, connection, country, and page.",
      "Resource timing: the largest element's download and render time, plus render-blocking scripts and styles.",
      "Session replay or layout-shift entries: the elements that move and the tags that inject them.",
      "Long tasks: main-thread work around the worst INP interactions.",
      "Server metrics: a normal response time that confirms the gap is after the response.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split the field percentile by device and connection. Find the LCP element and its resource timing, then check how much JavaScript must execute before it can render. Compare a lab run on the same profile; if the lab is fast, the gap is in the real device or network mix.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Reduce the JavaScript that must execute before the largest element renders: split bundles, defer non-critical code, and remove unused dependencies.",
      "Optimize the LCP element itself: compress and size images, preload the critical resource, and serve it from the edge.",
      "Remove or defer third-party tags that run on the main thread; load them after the interaction path is clear.",
      "Reserve space for images, ads, and embeds to stop layout shift.",
      "Verify with field p75 on the mobile segment, not only a lab score.",
      "Add a field regression alert by device class so the next release is caught quickly.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Field data is representative but noisy and delayed; lab data is fast and repeatable but not your users.",
      "A p75 protects most sessions and still leaves the slowest quarter; a p99 is better for the tail but harder to move.",
      "Third-party tags often pay for themselves in business terms, so removal is a product decision, not only a performance one.",
      "RUM agents add page weight and must respect consent, privacy, and ad blockers, which means some sessions are never measured.",
      "Optimizing for a lab score can miss the device and network mix that produces the field percentile.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "server-vs-field",
    question:
      "Server p95 is 200ms and mobile users report four-second loads. How do you explain the gap and where do you look first?",
    difficulty: 2,
    hints: [
      "The server metric stops at the response.",
      "Field data includes the device and the main thread.",
    ],
    answer:
      "The server metric measures request to response. The browser still has to resolve, connect, download the document and assets, parse and execute JavaScript, and render. I would look at field LCP p75 by device and connection, identify the LCP element, and inspect its resource timing and the render-blocking work before it. I would also check CLS and INP, because a heavy bundle often affects all three. The server is probably fine; the browser path is not.",
    followUps: [
      "How would you confirm the server is not the cause?",
      "What if only one page is slow?",
      "How would a synthetic browser check help?",
    ],
    redFlags: [
      "Assumes the users are on bad networks and stops there.",
      "Chases the server p95.",
      "Ignores the LCP element.",
    ],
    rubric: [
      "Separates server and browser time.",
      "Segments field data.",
      "Names the LCP element.",
      "Checks the other vitals.",
    ],
  },
  {
    id: "percentile-choice",
    question:
      "Why report p75 for Core Web Vitals instead of the average, and when would you also look at p99?",
    difficulty: 2,
    hints: [
      "An average can hide a slow cohort.",
      "Different percentiles answer different questions.",
    ],
    answer:
      "The p75 says three quarters of sessions are at or below that value, so it describes the bulk of the experience and is less sensitive to a few extreme sessions than an average. The average can look acceptable while a large mobile cohort is slow. I would still look at p99 for the tail, especially for interactions or a specific device class. The percentile is a choice about which users you are protecting, not a neutral summary.",
    followUps: [
      "When would p75 hide a serious problem?",
      "How does sample size affect a p99?",
      "Would you alert on p75 or on a segment?",
    ],
    redFlags: [
      "Says the average is always wrong.",
      "Uses p75 to claim every user is healthy.",
      "Ignores segment size.",
    ],
    rubric: [
      "Explains p75.",
      "Names the hidden cohort.",
      "Adds p99 for the tail.",
      "Connects the percentile to a decision.",
    ],
  },
  {
    id: "prioritize-vitals",
    question:
      "LCP, CLS, and INP are all failing. How do you decide what to fix first?",
    difficulty: 3,
    hints: [
      "Tie each metric to a user action and a page.",
      "Look for one cause that moves several metrics.",
    ],
    answer:
      "I would split each metric by page and device class, then find the page and segment with the largest user impact. I would look for a shared cause: a large bundle and third-party tags often hurt LCP, INP, and CLS together, so fixing the bundle may move all three. If the failures are separate, I would prioritize the metric tied to the business action, such as checkout INP, and the segment with the most sessions. I would verify with field p75 after each change rather than trusting a lab score.",
    followUps: [
      "What if only desktop CLS fails?",
      "How would you measure the business impact?",
      "Which fix would you ship first if you could ship only one?",
    ],
    redFlags: [
      "Fixes the metric with the lowest number.",
      "Optimizes the lab score only.",
      "Ignores segment size and page importance.",
    ],
    rubric: [
      "Segments by page and device.",
      "Finds a shared cause.",
      "Prioritizes by user impact.",
      "Verifies with field data.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "RUM is deployed with consent and a sampling rate that keeps p75 stable per segment.",
      "Dashboards split LCP, CLS, and INP by device, connection, country, and page.",
      "The LCP element and render-blocking resources are documented for critical pages.",
      "A synthetic browser check covers the main user path on a mobile profile.",
      "Field budgets are tied to a product decision, not only a lab score.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare server p95 with field p75 before changing the backend.",
      "Split the field metric by device and connection.",
      "Identify the LCP element and its resource timing.",
      "Check long tasks and third-party scripts for INP.",
      "Check layout-shift entries for CLS.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify field p75 on the affected segment, not only the fleet average.",
      "Keep the bundle and third-party budget in the release review.",
      "Add a regression alert for the segment that failed.",
      "Re-check the lab and field results together.",
      "Remove temporary RUM sampling changes and review consent.",
    ],
  },
];

const references = [
  {
    title: "Core Web Vitals",
    url: "https://web.dev/articles/vitals",
    publisher: "web.dev",
    kind: "docs" as const,
    note: "LCP, CLS, and INP definitions, thresholds, and field measurement guidance.",
  },
  {
    title: "Largest Contentful Paint",
    url: "https://web.dev/articles/lcp",
    publisher: "web.dev",
    kind: "docs" as const,
    note: "What LCP measures, which element is chosen, and how to improve it.",
  },
  {
    title: "Real User Monitoring",
    url: "https://docs.datadoghq.com/real_user_monitoring/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Browser RUM collection, session data, and performance views.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "rum-web-vitals": {
      model: rumModel,
      presets,
      instructions:
        "Start Healthy and compare field LCP with server p95. Apply Mobile release, then use the bundle and third-party sliders to bring p75 back under budget.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The LCP composition, device blend, and 120 page loads/s are teaching values; the Core Web Vitals thresholds are the published ones.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-golden-signals",
    "observability-continuous-profiling",
    "observability-synthetic-monitoring",
    "observability-trace-critical-path",
  ],
};

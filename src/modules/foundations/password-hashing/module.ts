import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ACCOUNTS = 100_000;
const CORES = 32;
const BASE_COST = 10;
const BASE_HASH_MS = 60;
const FAST_HASH_MS = 0.001;

const params = [
  {
    id: "hashFamily",
    label: "Hash family",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Hash",
    help: "0 selects a fast general-purpose hash for comparison; 1 selects an adaptive password hash such as bcrypt or Argon2id.",
    format: "count" as const,
  },
  {
    id: "bcryptCost",
    label: "Hash cost factor",
    min: 4,
    max: 16,
    step: 1,
    value: 12,
    unit: "",
    group: "Hash",
    help: "Work factor; each increment doubles the hashing work for the server and the attacker. Ignored when hash family is 0.",
    format: "count" as const,
  },
  {
    id: "saltBits",
    label: "Salt length",
    min: 0,
    max: 128,
    step: 16,
    value: 128,
    unit: " bits",
    group: "Hash",
    help: "Random per-user salt. Zero means no salt; 16–63 bits is a weak per-user salt with collision risk at large account counts.",
    format: "count" as const,
  },
  {
    id: "passwordEntropyBits",
    label: "Password entropy",
    min: 20,
    max: 80,
    step: 1,
    value: 40,
    unit: " bits",
    group: "Attack",
    help: "Illustrative guessing entropy of the user password. This is not a property the server can reliably measure.",
    format: "count" as const,
  },
  {
    id: "attackerRateMillions",
    label: "Attacker rate",
    min: 1,
    max: 1_000,
    step: 1,
    value: 1_000,
    unit: " M/s",
    group: "Attack",
    scale: "log" as const,
    help: "Offline guesses per second against a fast hash, in millions. Adaptive hashing scales this rate down by the ratio of fast-hash time to hash time.",
    format: "count" as const,
  },
  {
    id: "loginRate",
    label: "Login rate",
    min: 10,
    max: 5_000,
    step: 10,
    value: 50,
    unit: " logins/s",
    group: "Service",
    help: "Successful and failed login attempts per second. Hash cost multiplies this into CPU demand.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  hashFamily: number;
  cost: number;
  saltBits: number;
  entropy: number;
  hashMs: number;
  effectiveGuessRate: number;
  perAccountSeconds: number;
  accountsPerDay: number;
  crackedShare: number;
  cpuUtilization: number;
  loginP99: number;
  unsalted: boolean;
  weakSalt: boolean;
  saltCollisions: number;
}

function compute(p: Params): Computed {
  const hashFamily = Math.min(1, Math.max(0, Math.round(num(p, "hashFamily", 1))));
  const cost = Math.min(16, Math.max(4, Math.round(num(p, "bcryptCost", 12))));
  const saltBits = Math.min(128, Math.max(0, num(p, "saltBits", 128)));
  const entropy = Math.min(80, Math.max(20, num(p, "passwordEntropyBits", 40)));
  const attackerRate = Math.max(1, num(p, "attackerRateMillions", 1_000)) * 1_000_000;
  const loginRate = Math.max(1, num(p, "loginRate", 50));

  const hashMs = hashFamily === 0 ? FAST_HASH_MS : Math.min(20_000, BASE_HASH_MS * 2 ** (cost - BASE_COST));
  const effectiveGuessRate = hashFamily === 0 ? attackerRate : attackerRate * (FAST_HASH_MS / hashMs);
  const guesses = 2 ** entropy;
  const perAccountSeconds = guesses / effectiveGuessRate;
  const accountsPerDay = 86_400 / perAccountSeconds;
  const unsalted = saltBits === 0;
  const weakSalt = saltBits > 0 && saltBits < 64;
  const saltCollisions = weakSalt ? (ACCOUNTS * (ACCOUNTS - 1)) / 2 ** (saltBits + 1) : 0;
  const rawShare = unsalted
    ? (86_400 / perAccountSeconds) * 100
    : (accountsPerDay / ACCOUNTS) * 100;
  const crackedShare = Math.min(100, Math.max(0, rawShare));
  const cpuUtilization = Math.min(1_000, ((loginRate * hashMs) / 1_000 / CORES) * 100);
  const rho = cpuUtilization / 100;
  const loginP99 =
    rho < 1
      ? Math.min(30_000, hashMs * (1 + (0.5 * rho ** 4) / Math.max(0.01, 1 - rho)))
      : 30_000;
  return {
    hashFamily,
    cost,
    saltBits,
    entropy,
    hashMs,
    effectiveGuessRate,
    perAccountSeconds,
    accountsPerDay,
    crackedShare,
    cpuUtilization,
    loginP99,
    unsalted,
    weakSalt,
    saltCollisions,
  };
}

function healthFor(crackedShare: number, cpu: number): "ok" | "warn" | "crit" {
  if (crackedShare >= 5 || cpu >= 90) return "crit";
  if (crackedShare >= 0.5 || cpu >= 70) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const health = healthFor(values.crackedShare, values.cpuUtilization);
  const storeHealth = values.crackedShare >= 1 ? "crit" : values.crackedShare >= 0.1 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Login clients",
        kind: "client",
        health: "ok",
        sublabel: `${Math.round(num(p, "loginRate", 50))} attempts/s`,
        meta: { view: "flow" },
      },
      {
        id: "auth",
        label: "Auth service",
        kind: "service",
        health: values.cpuUtilization >= 90 ? "crit" : values.cpuUtilization >= 70 ? "warn" : "ok",
        utilization: clamp(values.cpuUtilization / 100),
        throughput: num(p, "loginRate", 50),
        sublabel: `${values.cpuUtilization.toFixed(0)}% hash CPU`,
        detail: `Hashes each attempt with cost ${values.cost}, about ${values.hashMs.toFixed(0)}ms per hash on one core. Cost raises both login latency and the attacker's cost.`,
        meta: { view: "flow" },
      },
      {
        id: "store",
        label: "Password store",
        kind: "db",
        health: storeHealth,
        utilization: clamp(values.crackedShare / 100),
        sublabel: values.saltBits === 0 ? "no salt" : `${values.saltBits}-bit salt`,
        detail: `Stores ${ACCOUNTS.toLocaleString()} password hashes. ${values.saltBits === 0 ? "No salt means one precomputed table can be compared with every row." : values.weakSalt ? `A ${values.saltBits}-bit salt is per-user but short; about ${values.saltCollisions.toFixed(1)} expected collisions across this account count.` : "Each row has a distinct salt, so an attacker must repeat the work per account."}`,
        meta: { view: "flow" },
      },
      {
        id: "attacker",
        label: "Offline attacker",
        kind: "external",
        health: values.crackedShare >= 5 ? "crit" : "ok",
        sublabel: `${formatRate(values.effectiveGuessRate)} guesses/s`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-auth", "client", "auth", clamp(num(p, "loginRate", 50) / 5_000), health),
      edge("auth-store", "auth", "store", 0.5),
      edge("store-attacker", "store", "attacker", clamp(values.crackedShare / 100), storeHealth),
    ],
    metrics: [
      metric("cracked-share", "Accounts crackable in 24h", values.crackedShare, "%", 0.1, 1, "percent"),
      metric("login-p99", "Login p99", values.loginP99, "ms", 300, 1_000, "ms"),
      metric("login-cpu", "Login hash CPU", values.cpuUtilization, "%", 70, 90, "percent"),
      metric("hash-time", "Hash time", values.hashMs, "ms", undefined, undefined, "ms"),
      metric("salt-bits", "Salt length", values.saltBits, " bits", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.crackedShare.toFixed(2)}% of accounts crackable in 24h; ${values.cpuUtilization.toFixed(0)}% hash CPU; p99 ${values.loginP99.toFixed(0)}ms.`,
  };
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 3.3);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) =>
      item.id === "cracked-share"
        ? Math.min(100, Math.max(0, item.value * jitter(index + item.id.length)))
        : Math.max(0, item.value * jitter(index + item.id.length)),
    );
  }
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "cracked-share",
    metricId: "cracked-share",
    warn: 0.1,
    crit: 1,
    title: "Leaked hashes are cheap to crack offline",
    cause:
      "The hash is too fast, the salt is missing or too short, or the password entropy is low. A fast hash lets an attacker test many guesses per second, and no salt lets one precomputed table cover every account.",
    fix:
      "Use Argon2id or bcrypt with a unique per-user salt and a work factor tuned to the login budget. Plan a migration that rehashes on successful login and forces resets where needed.",
    checkFirst: [
      "Read the stored hash prefix to identify the algorithm and parameters.",
      "Check whether every row has a distinct salt and enough salt bits.",
      "Check the measured hash time on production hardware.",
    ],
  },
  {
    id: "login-p99",
    metricId: "login-p99",
    warn: 300,
    crit: 1_000,
    title: "Login latency is breaching the user-facing budget",
    cause:
      "The work factor is high, the login rate exceeds the CPU budget, or both. Hash cost is deliberate, so capacity must be sized for peak attempts, not average success rate.",
    fix:
      "Benchmark the cost on the real fleet and keep the hash time under one second per attempt. Add capacity or rate limiting, but do not lower the cost below the security target without a decision.",
    checkFirst: [
      "Compare hash time with end-to-end login latency.",
      "Check CPU saturation and queueing at peak login rate.",
      "Check whether credential stuffing or retries are inflating attempts.",
    ],
  },
  {
    id: "login-cpu",
    metricId: "login-cpu",
    warn: 70,
    crit: 90,
    title: "Hash work is saturating the auth service",
    cause:
      "Every login attempt performs the full work factor, including failures. At high attempt rates, the same property that protects offline cracking becomes a denial-of-service lever.",
    fix:
      "Rate-limit and queue login attempts, add capacity, and keep the cost within the measured budget. Do not make the hash fast to absorb abusive traffic.",
    checkFirst: [
      "Check attempts per second versus successful logins.",
      "Check for a credential-stuffing pattern by source and account.",
      "Check whether autoscaling reacts fast enough to login spikes.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const passwordModel: SimModel = {
  id: "foundations-password-hashing",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p) => {
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    const values = compute(p);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.unsalted && frame.flags.saltWarned !== 1) {
      pushEvent(next, {
        id: "password-weak-salt",
        at: frame.t,
        severity: "crit",
        title: "Password hashes have no salt",
        detail: `No salt means one precomputed table can be compared against every stored hash, so ${values.crackedShare.toFixed(0)}% of accounts are exposed within a day of a leak.`,
        nodeId: "store",
        metricId: "cracked-share",
      });
      next.flags.saltWarned = 1;
    }
    if (!values.unsalted) next.flags.saltWarned = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${values.crackedShare.toFixed(2)}% of accounts crackable in 24h; ${values.cpuUtilization.toFixed(0)}% hash CPU; p99 ${values.loginP99.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      values.hashFamily === 0
        ? `A fast general-purpose hash takes about ${values.hashMs}ms, so one core can verify thousands of guesses per second.`
        : `At cost ${values.cost}, one hash takes about ${values.hashMs.toFixed(0)}ms, so a single core verifies roughly ${Math.round(1_000 / values.hashMs)} logins per second.`,
    );
    items.push(
      values.unsalted
        ? "There is no salt, so one precomputed table covers every account."
        : values.weakSalt
          ? `The ${values.saltBits}-bit salt is per-user but weak: about ${values.saltCollisions.toFixed(1)} expected collisions across ${ACCOUNTS.toLocaleString()} accounts.`
          : "Each account has a distinct salt, so the attacker must repeat the work per hash.",
    );
    items.push(
      `One account takes about ${formatDuration(values.perAccountSeconds)} to crack at the modeled attacker rate; about ${values.accountsPerDay.toFixed(1)} accounts fall per day.`,
    );
    if (values.cpuUtilization >= 70) {
      items.push(
        `Login hashing uses ${values.cpuUtilization.toFixed(0)}% of the auth fleet; the work factor is also a denial-of-service surface.`,
      );
    }
    items.push(
      "Salt defeats precomputation; cost defeats speed. A fast hash with a salt is still a fast hash.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

function formatRate(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "longer than the model can show";
  if (seconds < 1) return "under a second";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(1)} hours`;
  if (seconds < 31_536_000) return `${(seconds / 86_400).toFixed(1)} days`;
  return `${(seconds / 31_536_000).toFixed(1)} years`;
}

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A per-user salt and a cost tuned to the login budget.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak login",
    description: "High login rate and weaker password entropy push CPU and crack share toward the limits.",
    tone: "warn",
    params: defaults({ loginRate: 100, passwordEntropyBits: 36 }),
  },
  {
    id: "failure",
    label: "No salt",
    description: "A fast general-purpose hash with no salt. Most of the table is exposed within a day.",
    tone: "crit",
    params: defaults({ hashFamily: 0, bcryptCost: 10, saltBits: 0, passwordEntropyBits: 32, attackerRateMillions: 1_000, loginRate: 50 }),
  },
  {
    id: "weak-salt",
    label: "Weak salt",
    description: "A 32-bit per-user salt avoids shared-table exposure but has collision risk at scale.",
    tone: "warn",
    params: defaults({ bcryptCost: 12, saltBits: 32, passwordEntropyBits: 40, loginRate: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Per-user salt, higher entropy, and a cost that still fits the login budget.",
    tone: "ok",
    params: defaults({ bcryptCost: 12, saltBits: 128, passwordEntropyBits: 48, loginRate: 60 }),
  },
];

const experiment: Experiment = {
  id: "predict-salt-effect",
  title: "What does a unique salt actually change?",
  simId: "password",
  question:
    "A leaked table contains fast hashes with no salt. Adding a unique random salt at the same hash cost changes what?",
  prediction: {
    options: [
      { id: "slower", label: "Each guess becomes slower" },
      { id: "per-account", label: "The attacker must repeat work per account, but a fast hash still falls" },
      { id: "encrypt", label: "The hash becomes reversible with the salt" },
      { id: "latency", label: "Login latency drops" },
    ],
    correctOptionId: "per-account",
    explanation:
      "A salt is not secret and does not slow the hash function. Its job is uniqueness: the same password with different salts produces different hashes, so one precomputed table cannot cover the database and the attacker must attack each account separately. With a fast hash, each account is still cheap to attack, so the salted share can remain near 100%. Cost supplies the part that makes each guess expensive.",
  },
  setup: defaults({
    hashFamily: 0,
    bcryptCost: 10,
    saltBits: 0,
    passwordEntropyBits: 28,
    attackerRateMillions: 1_000,
    loginRate: 50,
  }),
  runFor: 20,
  observe: [
    "Without a unique salt, one precomputation covers every account and the whole table is exposed.",
    "With a per-user salt at the same cost, the attacker must repeat the work, but the share stays near 100% because each account is still cheap.",
    "Moving to an adaptive hash with a cost factor drops the exposed share sharply.",
    "Raising password entropy reduces guesses, but the server cannot enforce it reliably.",
  ],
  explain:
    "The attacker's cost is guesses multiplied by work per guess. A salt forces the guess work to restart for every account, removing the economy of a shared table. But if work per guess is nearly zero, restarting is still cheap. The cost factor multiplies work per guess for both sides, so it must be tuned against the login CPU budget. Salt and cost solve different halves of the problem.",
  fix: defaults({
    hashFamily: 1,
    bcryptCost: 12,
    saltBits: 128,
    passwordEntropyBits: 40,
    attackerRateMillions: 1_000,
    loginRate: 50,
  }),
  debrief:
    "The recovered run uses an adaptive hash with a per-account salt, so each account needs its own expensive cracking run and login CPU stays under 40%. The tradeoff is real: higher cost also makes credential-stuffing attempts expensive for the defender, so rate limiting and capacity planning must ship with the hash change.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Password hashing turns a password into a one-way verifier that is stored instead of the password. A salt is a unique random value stored with each hash; it ensures two users with the same password get different hashes and defeats precomputed lookup tables. A work factor, called cost in bcrypt and a combination of memory, iterations, and parallelism in Argon2, makes each guess deliberately expensive. Those three ideas are the whole design: unique salt, adaptive cost, and a one-way function that is slow by construction.",
  },
  {
    type: "p",
    text: "General-purpose hashes such as SHA-256 are built to be fast. A GPU can test enormous numbers of candidates per second, so a leaked SHA-256 table falls quickly even with a salt. bcrypt is an adaptive hash from 1999 designed to stay expensive as hardware improves; Argon2id is the newer memory-hard option and the current Open Worldwide Application Security Project (OWASP) first choice. Both store their parameters alongside the hash, which is what makes a future cost increase possible without invalidating old verifiers.",
  },
  {
    type: "p",
    text: "Verification is also a timing interface. If an unknown account returns before hashing while a known account performs the full hash, response time reveals whether the account exists. Hash a dummy value for unknown users, compare verifiers in constant time, and return the same error for both outcomes.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Registration hashes the password before storing it. Login looks up the verifier, hashes the submitted password with the stored salt and parameters, and compares the result in constant time. The auth service sits between the client and the password store; the salt and cost parameters live in the stored hash string, not in a separate column that can drift. A pepper, if used, is a secret key applied in addition and stored outside the database, for example in a key management service (KMS) or secrets manager.",
  },
  {
    type: "table",
    headers: ["Algorithm", "Main cost", "Strength", "Limit"],
    rows: [
      ["SHA-256 (unsalted or salted)", "Almost none", "Fast, simple", "Unsuitable: offline guessing is too cheap"],
      ["bcrypt", "2^cost rounds", "Mature, widely available, adaptive", "Legacy per OWASP; 72-byte input limit in most implementations"],
      ["Argon2id", "Memory, iterations, parallelism", "Memory-hard, current OWASP first choice", "Memory cost must fit the auth fleet"],
      ["PBKDF2-HMAC-SHA256", "Iterations", "FIPS-validated implementations", "Less memory-hard; use where compliance requires"],
    ],
  },
  {
    type: "p",
    text: "The simulation models a login service at 10–5,000 attempts per second with a 100,000-account leaked database. Hash times, attacker rates, and crack shares are illustrative teaching values, not a benchmark. The shape is the lesson: a fast hash makes the attacker fast, no salt makes one table cover everyone, a short salt risks collisions, and a high cost can become a login outage if the fleet is not sized for it.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Accounts crackable in 24h: the share of a leaked database exposed within a day, warning at 0.1% and critical at 1%.",
      "Login p99: the user-facing cost of the work factor, warning at 300ms and critical at one second.",
      "Login hash CPU: the auth fleet's utilization, which turns a security control into a denial-of-service surface.",
      "Hash time: milliseconds per hash on one core, the number to benchmark on real hardware.",
      "Salt length: zero means no salt; 16–63 bits is per-user but weak, and 64 bits or more is treated as a stable unique salt.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply No salt. Watch the crack share jump while login latency stays comfortable. Apply Weak salt to isolate salt length from cost, then Recovery. Run the experiment before reading its explanation.",
  },
  {
    type: "compare",
    leftTitle: "Salt",
    rightTitle: "Cost factor",
    rows: [
      { label: "Defeats", left: "Precomputed tables and identical hashes", right: "Fast offline guessing and fast hardware" },
      { label: "Cost to defender", left: "Almost none; store it with the hash", right: "Login CPU and latency" },
      { label: "Secret?", left: "No, it is stored with the hash", right: "No, parameters are stored with the hash" },
      { label: "Failure if missing", left: "One table covers every account", right: "Each guess is cheap" },
    ],
  },
  { type: "sim", simId: "password" },
  { type: "experiment", experimentId: "predict-salt-effect" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Without a salt, one precomputation covered the whole table, so a leak exposed most accounts within a day even though the login path looked healthy. The hash was fast enough that guessing was cheap. When salt and cost were raised, the attacker had to repeat work per account and each guess became more expensive, while the login path paid a measurable CPU cost.",
  },
  {
    type: "p",
    text: "The recovered configuration is a balance, not a maximum. Cost 12 with a per-user salt kept login CPU under 40% and made a single account expensive to crack. Raising the cost further would slow the attacker but also shrink login capacity, which is why the work factor must be benchmarked on production hardware and protected by rate limiting.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Stored hashes: a standard password-hash string such as `$argon2id$v=19$m=19456,t=2,p=1$...` or `$2b$12$...` identifies the algorithm and parameters. A bare hex digest with no parameters is a red flag.",
      "Database: one salt per row, not a constant column; equal passwords must not produce equal hashes.",
      "Auth service: hash duration, login p99, CPU per attempt, and failed-attempt rate split by source and account.",
      "Security: credential-stuffing alerts, password reset volume after a breach, and a list of accounts still on legacy hashes.",
      "Capacity: peak login attempts versus hashes per second per core; the work factor is a load multiplier.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Identify the stored algorithm and cost from the hash prefix, then check that every row has a distinct salt. Benchmark the hash on production hardware before changing the cost; a security upgrade that saturates login is an outage.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Inventory the stored hash formats and count accounts on each algorithm and cost.",
      "Move new passwords to Argon2id or bcrypt with a unique per-user salt and a cost benchmarked under one second.",
      "Rehash on successful login for accounts that still verify against the legacy format; force a reset only when the old hash cannot be upgraded safely.",
      "Compare verifiers in constant time and run a dummy hash for unknown users so response time and errors do not reveal account existence.",
      "Rate-limit and queue login attempts so the work factor cannot be turned into a denial-of-service lever.",
      "Track legacy-hash count to zero and test the migration path before the next cost increase.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Higher cost slows offline cracking and legitimate logins equally; capacity must be sized for peak attempts.",
      "Argon2id's memory cost is a strong defense but can exhaust a small auth fleet under a login spike.",
      "bcrypt is mature and simple but has a 72-byte input limit and is now a legacy choice per OWASP.",
      "A pepper adds defense if the database leaks alone, but key rotation can force password resets.",
      "Rehashing on login avoids mass resets but leaves legacy hashes for inactive accounts, sometimes for years.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-not-sha",
    question:
      "Why is salted SHA-256 still the wrong choice for password storage, and what would you use instead?",
    difficulty: 2,
    hints: [
      "Salt solves precomputation, not speed.",
      "Think about guesses per second on a GPU.",
    ],
    answer:
      "A salt makes each hash unique, so an attacker cannot reuse one precomputed table, but it does not make each guess expensive. SHA-256 is designed for speed, so a GPU or cluster can test a huge number of candidates per second, and a leaked table falls quickly. I would use a password-specific adaptive algorithm: Argon2id first, or bcrypt where Argon2 is unavailable, with a unique per-user salt and a work factor benchmarked to the login budget. If FIPS compliance is required, PBKDF2 with a high iteration count is the usual choice.",
    followUps: [
      "What does the salt actually prevent?",
      "How does bcrypt's cost differ from an iteration count?",
      "When would you choose PBKDF2?",
    ],
    redFlags: [
      "Says salt makes SHA-256 secure.",
      "Confuses encryption with hashing.",
      "Picks a cost without benchmarking.",
    ],
    rubric: [
      "Separates salt from work factor.",
      "Names an adaptive algorithm.",
      "Mentions benchmarking and compliance.",
    ],
  },
  {
    id: "choose-cost",
    question:
      "How do you choose a bcrypt cost or Argon2 parameters, and how do you roll out an increase without breaking login?",
    difficulty: 3,
    hints: [
      "Benchmark on the real auth fleet.",
      "Store parameters with the hash and rehash on login.",
    ],
    answer:
      "I benchmark on the production auth hardware at peak concurrency and choose the highest cost that keeps a hash comfortably under one second and leaves capacity for login spikes. For bcrypt that means a cost of at least 10 with the real fleet measured; for Argon2id I would tune memory and iterations with the same budget. I roll out by writing the new format for new passwords and rehashing on successful login for old ones, while tracking the legacy count. A cost increase is a capacity change, so I would also verify CPU headroom and rate limiting before shipping it.",
    followUps: [
      "What if the auth service autoscales slowly?",
      "How do you test the migration without real passwords?",
      "What do you do about inactive accounts?",
    ],
    redFlags: [
      "Picks the maximum cost.",
      "Changes the algorithm without a migration plan.",
      "Ignores peak login rate.",
    ],
    rubric: [
      "Benchmarks on real hardware.",
      "Keeps a latency budget.",
      "Uses rehash-on-login.",
      "Plans capacity and rate limits.",
    ],
  },
  {
    id: "timing-attack",
    question:
      "What timing leaks can a login endpoint have, and how do you close them?",
    difficulty: 3,
    hints: [
      "Unknown user versus wrong password.",
      "Comparison and error messages both leak.",
    ],
    answer:
      "The endpoint can leak whether an account exists if it returns immediately for an unknown user but performs a slow hash for a known one, or if it returns different errors. It can also leak through a non-constant-time hash comparison that exits at the first differing byte. I would run a dummy hash with a fixed cost for unknown users, use a constant-time comparison for the verifier, return the same generic error and status for both cases, and rate-limit attempts. I would measure the distributions, not just the averages, because the leak may be small compared with network noise.",
    followUps: [
      "Does a constant-time compare fix user enumeration?",
      "How would you test the timing distribution?",
      "What does rate limiting add that constant time does not?",
    ],
    redFlags: [
      "Returns user not found immediately.",
      "Uses short-circuit string comparison.",
      "Relies on network jitter as a defense.",
    ],
    rubric: [
      "Names user enumeration and compare timing.",
      "Uses dummy hash and constant-time compare.",
      "Uniform errors and rate limits.",
      "Measures distributions.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every stored password has a unique salt and an identified algorithm and cost.",
      "Hash time is benchmarked on production hardware under peak login load.",
      "Login attempts are rate-limited and queued so hashing cannot be used as a denial-of-service lever.",
      "A migration path exists for legacy hashes, with a count of accounts still on them.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "If a database leak is suspected, identify hash formats and rotate secrets before announcing.",
      "Check login CPU and p99 before raising the work factor.",
      "Force resets only for accounts whose hashes cannot be migrated safely.",
      "Preserve evidence and follow the breach process; do not delete the affected data.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the legacy-hash count reaches zero or an accepted residual.",
      "Re-benchmark cost after fleet or traffic changes.",
      "Test constant-time comparison and unknown-user timing.",
      "Document the chosen algorithm, parameters, and rotation plan.",
    ],
  },
];

const references = [
  {
    title: "OWASP Password Storage Cheat Sheet",
    url: "https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html",
    publisher: "OWASP",
    kind: "docs" as const,
    note: "Argon2id, bcrypt, salting, work factors, and migration guidance.",
  },
  {
    title: "A Future-Adaptable Password Scheme",
    url: "https://www.usenix.org/conference/1999-usenix-annual-technical-conference/future-adaptable-password-scheme",
    publisher: "USENIX",
    kind: "docs" as const,
    note: "The original bcrypt paper by Provos and Mazières.",
  },
  {
    title: "RFC 9106: Argon2 Memory-Hard Function",
    url: "https://www.rfc-editor.org/rfc/rfc9106",
    publisher: "IETF",
    kind: "standard" as const,
    note: "Argon2id parameters and memory-hard design.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    password: {
      model: passwordModel,
      presets,
      instructions:
        "Start healthy, then remove the salt and lower the cost. Watch the crack share, then compare the login CPU cost of the recovery settings.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Attacker rates and hash times are teaching values, not a hardware benchmark.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-rate-limiting",
    "traffic-waf-rate-limits",
    "reliability-dependency-failure",
  ],
};

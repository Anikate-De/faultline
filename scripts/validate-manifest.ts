import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, string>;

const ROOT = process.cwd();
const MANIFEST = join(ROOT, "docs/MODULE_MANIFEST.md");
const OUT = join(ROOT, "src/generated/module-manifest.json");

const EXPECTED: Record<string, number> = {
  foundations: 32,
  observability: 34,
  traffic: 34,
  caching: 28,
  databases: 32,
  mongodb: 22,
  streaming: 32,
  containers: 26,
  mesh: 22,
  deployment: 28,
  reliability: 32,
  "cloud-networking": 32,
  compliance: 20,
  capacity: 22,
  "case-files": 64,
  kubernetes: 16,
};

const TRACK_TITLES: Record<string, string> = {
  foundations: "Foundations",
  observability: "Observability",
  traffic: "Traffic & Edge",
  caching: "Caching",
  databases: "Relational Data",
  mongodb: "Document Data",
  streaming: "Streaming & Messaging",
  containers: "Containers & ECS",
  mesh: "Service Mesh",
  deployment: "Release Engineering",
  reliability: "Reliability & Incidents",
  "cloud-networking": "Cloud Networking",
  compliance: "Compliance & GRC",
  capacity: "Capacity & Cost",
  "case-files": "Case Files",
  kubernetes: "Kubernetes",
};

const PLACEHOLDER = /\b(TODO|TBD|Lorem ipsum|Coming soon)\b|example\.com|localhost/i;
const errors: string[] = [];
const warnings: string[] = [];

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(
  "a an the and or of to in on for with by from is are was were be been it its this that as at into not no you your we our they their than then so if but can may must should would could do does did".split(
    " ",
  ),
);

function tokens(s: string): Set<string> {
  return new Set(
    norm(s)
      .split(" ")
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

function jaccard(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  const union = x.size + y.size - inter;
  return union === 0 ? 1 : inter / union;
}

function parse(): { rows: Row[]; tracks: Record<string, Row[]> } {
  const text = readFileSync(MANIFEST, "utf8");
  const lines = text.split("\n");
  const tracks: Record<string, Row[]> = {};
  let current: string | null = null;
  let headers: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      const title = h[1].trim();
      current = Object.keys(TRACK_TITLES).find((id) => TRACK_TITLES[id] === title) ?? null;
      if (current) tracks[current] = [];
      headers = null;
      continue;
    }
    if (!current || !line.startsWith("| ")) continue;
    const cells = line
      .slice(2, line.endsWith(" |") ? -2 : undefined)
      .split(" | ")
      .map((c) => c.trim());
    if (cells[0] === "ID") {
      headers = cells;
      continue;
    }
    if (!headers) continue;
    if (line.startsWith("|---")) continue;
    if (cells.length !== headers.length) {
      errors.push(`${current}: row has ${cells.length} cells, expected ${headers.length}: ${line.slice(0, 80)}`);
      continue;
    }
    const row: Row = {};
    headers.forEach((key, idx) => (row[key] = cells[idx] ?? ""));
    tracks[current].push(row);
  }
  return { rows: Object.values(tracks).flat(), tracks };
}

function slugFor(id: string, track: string): string {
  if (track === "case-files") return id.replace(/^case-/, "");
  return id.startsWith(`${track}-`) ? id.slice(track.length + 1) : id;
}

const { rows, tracks } = parse();

// Counts
for (const [track, expected] of Object.entries(EXPECTED)) {
  const got = tracks[track]?.length ?? 0;
  if (got !== expected) errors.push(`${track}: ${got} rows, expected ${expected}`);
}
if (rows.length !== 476) errors.push(`total: ${rows.length} rows, expected 476`);

// Rows
const ids = new Set<string>();
const deltas: { id: string; value: string }[] = [];
const questions: { id: string; value: string }[] = [];
const purposes: { id: string; value: string }[] = [];

for (const [track, list] of Object.entries(tracks)) {
  list.forEach((row, index) => {
    const id = row.ID;
    const label = `${id || `row ${index + 1}`}`;
    if (!id) {
      errors.push(`${track} row ${index + 1}: missing ID`);
      return;
    }
    if (ids.has(id)) errors.push(`${label}: duplicate ID`);
    ids.add(id);
    if (row.Track !== track) errors.push(`${label}: Track column ${row.Track} does not match section ${track}`);
    if (track !== "case-files" && !id.startsWith(`${track}-`)) errors.push(`${label}: ID does not start with ${track}-`);
    if (track === "case-files" && !id.startsWith("case-")) errors.push(`${label}: case file ID must start with case-`);
    if (Number(row["#"]) !== index + 1) errors.push(`${label}: order ${row["#"]} does not match position ${index + 1}`);
    for (const field of [
      "Title",
      "Purpose",
      "Production question",
      "Learning delta",
      "Concepts",
      "Sim mechanic",
      "Interactivity",
      "Break condition",
      "Prereqs",
      "Case file",
      "Interview angle",
      "Sources",
      "D",
      "Min",
      "Status",
    ]) {
      if (!row[field]) errors.push(`${label}: missing ${field}`);
    }
    if (PLACEHOLDER.test(JSON.stringify(row))) errors.push(`${label}: placeholder or disallowed URL`);
    if (!row["Production question"].endsWith("?")) errors.push(`${label}: production question must end with ?`);
    if (row["Learning delta"].length < 30) errors.push(`${label}: learning delta too short`);
    if (row.Purpose.length < 20) errors.push(`${label}: purpose too short`);
    const concepts = row.Concepts.split(",").map((c) => c.trim()).filter(Boolean);
    if (concepts.length < 3 || concepts.length > 8) errors.push(`${label}: ${concepts.length} concepts, expected 3-8`);
    const prereqs = row.Prereqs === "—" ? [] : row.Prereqs.split(",").map((p) => p.trim()).filter(Boolean);
    for (const p of prereqs) if (!ids.has(p) && !rows.some((r) => r.ID === p)) warnings.push(`${label}: prerequisite ${p} defined later or missing`);
    const d = Number(row.D);
    const m = Number(row.Min);
    if (!Number.isInteger(d) || d < 1 || d > 4) errors.push(`${label}: difficulty ${row.D}`);
    if (!Number.isFinite(m) || m < 10 || m > 35) errors.push(`${label}: minutes ${row.Min}`);
    if (!["planned", "approved", "authored", "reviewed", "cut"].includes(row.Status)) errors.push(`${label}: bad status ${row.Status}`);
    if (track === "case-files") {
      if (!row["Case file"].startsWith("Yes —")) errors.push(`${label}: case file must name the incident or Composite`);
    } else if (row["Case file"] !== "No") {
      errors.push(`${label}: standard module must have Case file = No`);
    }
    deltas.push({ id, value: row["Learning delta"] });
    questions.push({ id, value: row["Production question"] });
    purposes.push({ id, value: row.Purpose });
  });
}

// Prerequisite existence and cycles
const byId = new Map(rows.map((r) => [r.ID, r]));
for (const row of rows) {
  const prereqs = row.Prereqs === "—" ? [] : row.Prereqs.split(",").map((p) => p.trim()).filter(Boolean);
  for (const p of prereqs) if (!byId.has(p)) errors.push(`${row.ID}: unknown prerequisite ${p}`);
}
const state = new Map<string, 0 | 1 | 2>();
function visit(id: string, stack: string[]): void {
  const s = state.get(id) ?? 0;
  if (s === 1) {
    errors.push(`prerequisite cycle: ${[...stack, id].join(" -> ")}`);
    return;
  }
  if (s === 2) return;
  state.set(id, 1);
  const row = byId.get(id);
  const prereqs = row && row.Prereqs !== "—" ? row.Prereqs.split(",").map((p) => p.trim()).filter(Boolean) : [];
  for (const p of prereqs) if (byId.has(p)) visit(p, [...stack, id]);
  state.set(id, 2);
}
for (const id of byId.keys()) visit(id, []);

// Duplicate and near-duplicate checks
function duplicates(label: string, items: { id: string; value: string }[], threshold: number) {
  const seen = new Map<string, string>();
  for (const item of items) {
    const n = norm(item.value);
    if (seen.has(n)) errors.push(`${item.id}: duplicate ${label} of ${seen.get(n)}`);
    else seen.set(n, item.id);
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const score = jaccard(items[i].value, items[j].value);
      if (score >= threshold) errors.push(`${items[i].id} / ${items[j].id}: ${label} similarity ${score.toFixed(2)}`);
    }
  }
}
duplicates("learning delta", deltas, 0.82);
duplicates("production question", questions, 0.86);
duplicates("purpose", purposes, 0.86);

// Slugs
const shortSlugs = new Map<string, string[]>();
for (const row of rows) {
  const s = slugFor(row.ID, row.Track);
  shortSlugs.set(s, [...(shortSlugs.get(s) ?? []), row.ID]);
}
const slugById = new Map<string, string>();
for (const row of rows) {
  const s = slugFor(row.ID, row.Track);
  const collision = (shortSlugs.get(s) ?? []).length > 1;
  slugById.set(row.ID, collision ? row.ID : s);
}
const slugCounts = new Map<string, number>();
for (const s of slugById.values()) slugCounts.set(s, (slugCounts.get(s) ?? 0) + 1);
for (const [s, n] of slugCounts) if (n > 1) errors.push(`slug collision: ${s} (${n})`);

if (errors.length) {
  console.error(`Manifest validation failed with ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  if (warnings.length) {
    console.error(`\n${warnings.length} warning(s):`);
    for (const w of warnings.slice(0, 20)) console.error(`  - ${w}`);
  }
  process.exit(1);
}

const manifest = rows.map((row) => {
  const prereqs = row.Prereqs === "—" ? [] : row.Prereqs.split(",").map((p) => p.trim()).filter(Boolean);
  const caseFile = row["Case file"] === "No" ? null : row["Case file"].replace(/^Yes —\s*/, "");
  return {
    id: row.ID,
    slug: slugById.get(row.ID),
    track: row.Track,
    order: Number(row["#"]),
    title: row.Title,
    purpose: row.Purpose,
    productionQuestion: row["Production question"],
    learningDelta: row["Learning delta"],
    concepts: row.Concepts.split(",").map((c) => c.trim()).filter(Boolean),
    simMechanic: row["Sim mechanic"],
    interactivity: row.Interactivity,
    breakCondition: row["Break condition"],
    prerequisites: prereqs,
    caseFile,
    interviewAngle: row["Interview angle"],
    sources: row.Sources,
    difficulty: Number(row.D),
    minutes: Number(row.Min),
    status: row.Status,
  };
});

mkdirSync(join(ROOT, "src/generated"), { recursive: true });
writeFileSync(OUT, JSON.stringify({ version: 1, modules: manifest }, null, 2) + "\n");

const runtime = manifest.map((row) => ({
  id: row.id,
  slug: row.slug,
  track: row.track,
  order: row.order,
  title: row.title,
  purpose: row.purpose,
  productionQuestion: row.productionQuestion,
  learningDelta: row.learningDelta,
  concepts: row.concepts,
  prerequisites: row.prerequisites,
  caseFile: row.caseFile,
  difficulty: row.difficulty,
  minutes: row.minutes,
  status: row.status,
}));
writeFileSync(
  join(ROOT, "src/generated/module-index.json"),
  JSON.stringify({ version: 1, modules: runtime }, null, 2) + "\n",
);

if (!existsSync(join(ROOT, "src/generated/search-index.json"))) {
  writeFileSync(join(ROOT, "src/generated/search-index.json"), JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n");
}

console.log(`Manifest valid: ${manifest.length} modules`);
for (const [track, expected] of Object.entries(EXPECTED)) {
  console.log(`  ${track.padEnd(18)} ${String(tracks[track]?.length ?? 0).padStart(3)} / ${expected}`);
}
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s) (forward prerequisites are allowed):`);
  for (const w of warnings.slice(0, 10)) console.log(`  - ${w}`);
}
console.log(`\nWrote ${OUT} and src/generated/module-index.json`);

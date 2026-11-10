import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Block, CaseStudy, Module } from "../src/content/types";
import type { ManifestModule } from "../src/content/manifest";

interface MetaFile {
  meta: Module["meta"];
}
interface ModuleFile {
  module: Module;
}
interface CaseFile {
  caseStudy: CaseStudy;
}
interface ManifestFile {
  modules: ManifestModule[];
}

const root = process.cwd();
const modulesRoot = join(root, "src/modules");
const caseFilesRoot = join(root, "src/case-files");
const manifest = JSON.parse(
  readFileSync(join(root, "src/generated/module-manifest.json"), "utf8"),
) as ManifestFile;
const manifestById = new Map(manifest.modules.map((item) => [item.id, item]));
const errors: string[] = [];
const warnings: string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith("_") || name === "registry.ts") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
  }
  const meta = join(dir, "meta.ts");
  if (existsSync(meta)) out.push(dir);
  return out;
}

const dirs = walk(modulesRoot);

function walkCaseFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith("_") || name === "registry.ts") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walkCaseFiles(path));
  }
  if (existsSync(join(dir, "meta.ts"))) out.push(dir);
  return out;
}

const caseDirs = walkCaseFiles(caseFilesRoot);

function textOfBlock(block: Block): string {
  switch (block.type) {
    case "p":
    case "h2":
    case "h3":
      return block.text;
    case "list":
      return block.items.join(" ");
    case "callout":
      return `${block.title} ${block.body}`;
    case "compare":
      return [block.leftTitle, block.rightTitle, ...block.rows.flatMap((row) => [row.label, row.left, row.right])].join(" ");
    case "code":
      return `${block.title ?? ""} ${block.code} ${block.caption ?? ""}`;
    case "diagram":
      return block.caption ?? "";
    case "metrics":
      return block.items.map((item) => `${item.label} ${item.value}`).join(" ");
    case "timeline":
      return block.events.map((event) => `${event.at} ${event.title} ${event.body}`).join(" ");
    case "checklist":
      return `${block.title ?? ""} ${block.items.join(" ")}`;
    case "glossary":
      return block.termIds.join(" ");
    case "quote":
      return `${block.text} ${block.attribution ?? ""}`;
    case "table":
      return `${block.headers.join(" ")} ${block.rows.flat().join(" ")}`;
    case "sim":
    case "experiment":
    case "custom":
      return "";
    default:
      return "";
  }
}

function wordCount(module: Module): number {
  const texts: string[] = [];
  for (const block of [...module.primer, ...module.debrief]) texts.push(textOfBlock(block));
  for (const experiment of module.experiments) {
    texts.push(
      experiment.title,
      experiment.question,
      experiment.prediction.explanation,
      experiment.observe.join(" "),
      experiment.explain,
      experiment.debrief,
      experiment.prediction.options.map((option) => option.label).join(" "),
    );
  }
  // Word budget covers lesson prose and experiments; interview drills and checklists are separate practice.
  return texts.join(" ").trim().split(/\s+/).filter(Boolean).length;
}

function hasHeading(blocks: Block[], heading: string): boolean {
  return blocks.some(
    (block) => block.type === "h2" && block.text.trim().toLowerCase().startsWith(heading.toLowerCase()),
  );
}

function containsPlaceholder(value: string): boolean {
  return /\b(TODO|TBD|Lorem ipsum|Coming soon)\b|example\.com|localhost|http:\/\//i.test(value);
}

for (const dir of dirs) {
  const rel = dir.replace(root + "/", "");
  const metaPath = join(dir, "meta.ts");
  const modulePath = join(dir, "module.ts");
  const index = join(dir, "index.ts");
  if (!existsSync(index)) errors.push(`${rel}: missing index.ts`);
  if (!existsSync(modulePath)) {
    errors.push(`${rel}: missing module.ts`);
    continue;
  }
  let metaMod: MetaFile;
  let moduleMod: ModuleFile;
  try {
    metaMod = (await import(pathToFileURL(metaPath).href)) as MetaFile;
    moduleMod = (await import(pathToFileURL(modulePath).href)) as ModuleFile;
  } catch (error) {
    errors.push(`${rel}: import failed: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const meta = metaMod.meta;
  const module = moduleMod.module;
  const label = meta?.id ?? rel;
  if (!meta || !module) {
    errors.push(`${rel}: meta or module export missing`);
    continue;
  }
  const manifestRow = manifestById.get(meta.id);
  if (!manifestRow) {
    errors.push(`${label}: not present in src/generated/module-manifest.json`);
    continue;
  }
  for (const [field, expected] of [
    ["slug", manifestRow.slug],
    ["track", manifestRow.track],
    ["order", manifestRow.order],
    ["title", manifestRow.title],
    ["minute count", manifestRow.minutes],
    ["difficulty", manifestRow.difficulty],
    ["production question", manifestRow.productionQuestion],
    ["learning delta", manifestRow.learningDelta],
  ] as const) {
    const actual = meta[field === "minute count" ? "minutes" : field === "production question" ? "productionQuestion" : field === "learning delta" ? "learningDelta" : field];
    if (actual !== expected) errors.push(`${label}: ${field} differs from manifest`);
  }
  if (meta.status === "draft") errors.push(`${label}: authored module is still draft`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.lastReviewed) || Number.isNaN(new Date(meta.lastReviewed).getTime())) {
    errors.push(`${label}: lastReviewed must be an ISO date`);
  }
  if (meta.objectives.length < 2 || meta.objectives.length > 5) errors.push(`${label}: objectives must be 2–5`);
  if (module.interview.length < 3 || module.interview.length > 5) errors.push(`${label}: interview must be 3–5 questions`);
  if (meta.interviewQuestions !== module.interview.length) errors.push(`${label}: meta.interviewQuestions does not match content`);
  if (module.references.length < 2) errors.push(`${label}: at least 2 references required`);
  if (Object.keys(module.sims).length === 0) errors.push(`${label}: no simulation`);
  if (meta.hasSim !== (Object.keys(module.sims).length > 0)) errors.push(`${label}: meta.hasSim mismatch`);
  if (!hasHeading(module.primer, "What it is")) errors.push(`${label}: primer missing "What it is"`);
  if (!hasHeading(module.primer, "Where it sits")) errors.push(`${label}: primer missing "Where it sits"`);
  if (!hasHeading(module.primer, "What you'll see")) errors.push(`${label}: primer missing "What you'll see"`);
  if (!module.primer.some((block) => block.type === "diagram" || block.type === "table" || block.type === "compare")) {
    errors.push(`${label}: primer needs a diagram, table, or compare block`);
  }
  if (!module.primer.some((block) => block.type === "callout")) errors.push(`${label}: primer needs a callout`);
  for (const heading of ["What just happened", "What you'd see in production", "How to fix it", "Tradeoffs"]) {
    if (!hasHeading(module.debrief, heading)) errors.push(`${label}: debrief missing "${heading}"`);
  }
  if (module.experiments.length === 0) errors.push(`${label}: at least one guided experiment required`);
  for (const experiment of module.experiments) {
    if (!experiment.prediction.options.some((option) => option.id === experiment.prediction.correctOptionId)) {
      errors.push(`${label}/${experiment.id}: correct prediction option not found`);
    }
    if (experiment.prediction.options.length < 3) errors.push(`${label}/${experiment.id}: prediction needs 3+ options`);
    if (!experiment.runFor || experiment.runFor <= 0) errors.push(`${label}/${experiment.id}: runFor must be positive`);
    if (!module.sims[experiment.simId]) errors.push(`${label}/${experiment.id}: simId does not exist`);
  }
  for (const [simId, sim] of Object.entries(module.sims)) {
    if (sim.model.params.length < 3 || sim.model.params.length > 6) errors.push(`${label}/${simId}: 3–6 params required`);
    for (const required of ["healthy", "failure", "recovery"]) {
      if (!sim.presets.some((preset) => preset.id === required)) errors.push(`${label}/${simId}: missing ${required} preset`);
    }
    if (!sim.model.thresholds.length) errors.push(`${label}/${simId}: no thresholds`);
    for (const threshold of sim.model.thresholds) {
      if (!threshold.cause || !threshold.fix) errors.push(`${label}/${simId}: threshold ${threshold.id} missing cause/fix`);
    }
    if (!sim.instructions) errors.push(`${label}/${simId}: missing instructions`);
  }
  for (const question of module.interview) {
    if (!question.answer || question.answer.length < 40) errors.push(`${label}/${question.id}: answer missing or too short`);
    if (question.hints.length < 1) errors.push(`${label}/${question.id}: at least one hint required`);
    if (question.rubric.length < 1) errors.push(`${label}/${question.id}: rubric required`);
  }
  if (!module.checklist.length) errors.push(`${label}: production checklist required`);
  const allContent = JSON.stringify({
    primer: module.primer,
    debrief: module.debrief,
    experiments: module.experiments,
    interview: module.interview,
    checklist: module.checklist,
  });
  if (containsPlaceholder(allContent)) errors.push(`${label}: placeholder or disallowed URL in content`);
  if (/<[a-z][^>]*>/i.test(allContent)) errors.push(`${label}: raw HTML is not allowed in typed blocks`);
  const count = wordCount(module);
  if (meta.track === "case-files") {
    if (count < 1_200 || count > 2_500) errors.push(`${label}: word count ${count} outside 1,200–2,500 for case files`);
  } else if (count < 700 || count > 1_800) {
    errors.push(`${label}: word count ${count} outside 700–1,800`);
  }
  for (const file of readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = readFileSync(join(dir, file), "utf8");
    if (/Math\.random\s*\(/.test(source)) errors.push(`${label}/${file}: Math.random is forbidden in model code`);
    if (/Date\.now\s*\(/.test(source)) errors.push(`${label}/${file}: Date.now is forbidden in model code`);
  }
  if (wordCount(module) < 700) warnings.push(`${label}: short module (${wordCount(module)} words)`);
}

for (const dir of caseDirs) {
  const rel = dir.replace(root + "/", "");
  const metaPath = join(dir, "meta.ts");
  const casePath = join(dir, "case.ts");
  if (!existsSync(join(dir, "index.ts"))) errors.push(`${rel}: missing index.ts`);
  if (!existsSync(casePath)) {
    errors.push(`${rel}: missing case.ts`);
    continue;
  }
  let metaMod: MetaFile;
  let caseMod: CaseFile;
  try {
    metaMod = (await import(pathToFileURL(metaPath).href)) as MetaFile;
    caseMod = (await import(pathToFileURL(casePath).href)) as CaseFile;
  } catch (error) {
    errors.push(`${rel}: import failed: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const meta = metaMod.meta;
  const study = caseMod.caseStudy;
  const label = meta?.id ?? rel;
  if (!meta || !study) {
    errors.push(`${rel}: meta or caseStudy export missing`);
    continue;
  }
  const manifestRow = manifestById.get(meta.id);
  if (!manifestRow) {
    errors.push(`${label}: not present in src/generated/module-manifest.json`);
    continue;
  }
  if (manifestRow.track !== "case-files") errors.push(`${label}: manifest row is not a case file`);
  for (const [field, expected, actual] of [
    ["slug", manifestRow.slug, meta.slug],
    ["track", manifestRow.track, meta.track],
    ["order", manifestRow.order, meta.order],
    ["title", manifestRow.title, meta.title],
    ["difficulty", manifestRow.difficulty, meta.difficulty],
    ["minute count", manifestRow.minutes, meta.minutes],
    ["production question", manifestRow.productionQuestion, meta.productionQuestion],
    ["learning delta", manifestRow.learningDelta, meta.learningDelta],
    ["prerequisites", manifestRow.prerequisites, meta.prerequisites],
    ["tags", manifestRow.concepts, meta.tags],
  ] as const) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${label}: ${field} differs from manifest`);
  }
  if (meta.caseStudy !== true) errors.push(`${label}: meta.caseStudy must be true`);
  if (meta.status === "draft") errors.push(`${label}: authored case file is still draft`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.lastReviewed) || Number.isNaN(new Date(meta.lastReviewed).getTime())) {
    errors.push(`${label}: lastReviewed must be an ISO date`);
  }

  const composite = Boolean(manifestRow.caseFile?.startsWith("Composite"));
  const expectedKind = composite ? "composite" : "public";
  if (study.kind !== expectedKind) errors.push(`${label}: kind must be "${expectedKind}"`);
  if (!study.company?.trim()) errors.push(`${label}: company is required`);
  if (!study.date?.trim()) errors.push(`${label}: date is required`);
  if (!study.incidentClass?.trim()) errors.push(`${label}: incident class is required`);
  if (!study.accuracyNote?.trim()) errors.push(`${label}: accuracy note is required`);
  if (!Array.isArray(study.timeline) || study.timeline.length < 4) {
    errors.push(`${label}: at least 4 timeline events required`);
  }
  for (const event of study.timeline ?? []) {
    if (!event.at?.trim() || !event.title?.trim() || !event.body?.trim()) {
      errors.push(`${label}: timeline event is missing at, title, or body`);
    }
  }
  if (!Array.isArray(study.decisions) || study.decisions.length < 2) {
    errors.push(`${label}: at least 2 decisions required`);
  }
  const decisionIds = new Set<string>();
  for (const decision of study.decisions ?? []) {
    if (!decision.id?.trim()) errors.push(`${label}: decision id is required`);
    if (decisionIds.has(decision.id)) errors.push(`${label}/${decision.id}: duplicate decision id`);
    decisionIds.add(decision.id);
    if (!decision.prompt?.trim()) errors.push(`${label}/${decision.id}: prompt is required`);
    if (!decision.debrief?.trim()) errors.push(`${label}/${decision.id}: debrief is required`);
    if (!Array.isArray(decision.options) || decision.options.length < 2) {
      errors.push(`${label}/${decision.id}: at least 2 options required`);
    }
    const optionIds = new Set<string>();
    for (const option of decision.options ?? []) {
      if (!option.id?.trim() || !option.label?.trim() || !option.consequence?.trim()) {
        errors.push(`${label}/${decision.id}: option is missing id, label, or consequence`);
      }
      if (optionIds.has(option.id)) errors.push(`${label}/${decision.id}: duplicate option ${option.id}`);
      optionIds.add(option.id);
      if (!["good", "mixed", "poor"].includes(option.quality)) {
        errors.push(`${label}/${decision.id}: option ${option.id} has invalid quality`);
      }
    }
  }
  if (!Array.isArray(study.sources) || study.sources.length < 2) {
    errors.push(`${label}: at least 2 sources required`);
  }
  for (const source of study.sources ?? []) {
    if (!source.title?.trim() || !source.publisher?.trim()) errors.push(`${label}: source is missing title or publisher`);
    if (!/^https:\/\/\S+$/.test(source.url ?? "")) errors.push(`${label}: source "${source.title ?? "unknown"}" must use an https URL`);
    if (!["docs", "postmortem", "book", "talk", "standard"].includes(source.kind)) {
      errors.push(`${label}: source "${source.title ?? "unknown"}" has invalid kind`);
    }
  }
  if (!Array.isArray(study.postmortem) || study.postmortem.length === 0) {
    errors.push(`${label}: postmortem blocks are required`);
  } else if (!study.postmortem.some((block) => ["p", "list", "callout"].includes(block.type))) {
    errors.push(`${label}: postmortem needs prose, a list, or a callout`);
  }
  if (composite) {
    if (!/composite/i.test(study.accuracyNote) || !/not a real incident/i.test(study.accuracyNote)) {
      errors.push(`${label}: composite accuracy note must state it is a composite and not a real incident`);
    }
  } else {
    if (!study.accuracyNote.trim()) errors.push(`${label}: public-incident case file needs an accuracy note`);
    if (!study.sources.some((source) => source.kind === "postmortem")) {
      errors.push(`${label}: public-incident case file needs at least one postmortem reference`);
    }
  }
  const caseContent = JSON.stringify(study);
  if (containsPlaceholder(caseContent)) errors.push(`${label}: placeholder or disallowed URL in case content`);
  if (/<[a-z][^>]*>/i.test(caseContent)) errors.push(`${label}: raw HTML is not allowed in typed blocks`);
  for (const file of readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = readFileSync(join(dir, file), "utf8");
    if (/Math\.random\s*\(/.test(source)) errors.push(`${label}/${file}: Math.random is forbidden in model code`);
    if (/Date\.now\s*\(/.test(source)) errors.push(`${label}/${file}: Date.now is forbidden in model code`);
  }
}

if (errors.length) {
  console.error(`Content validation failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Content valid: ${dirs.length} authored module(s), ${caseDirs.length} authored case file(s)`);
if (warnings.length) console.warn(`${warnings.length} warning(s)`);

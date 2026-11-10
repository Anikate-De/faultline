import type { ManifestModule } from "./manifest";

export interface LearningPathItem {
  module: ManifestModule;
  level: number;
  milestone: boolean;
}

const LEVELS = [1, 2, 3, 4] as const;

export function levelLabel(level: number): string {
  return level === 1 ? "Intro" : level === 2 ? "Core" : level === 3 ? "Advanced" : "Expert";
}

export function buildLearningPath(modules: ManifestModule[]): LearningPathItem[] {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const effective = new Map<string, number>();

  function effectiveLevel(id: string, stack = new Set<string>()): number {
    const cached = effective.get(id);
    if (cached !== undefined) return cached;
    const module = byId.get(id);
    if (!module) return 1;
    if (stack.has(id)) return 4;
    stack.add(id);
    const own = Math.min(4, Math.max(1, module.difficulty));
    const viaPrereqs = module.prerequisites.map((prereq) => effectiveLevel(prereq, stack));
    const level = Math.min(4, Math.max(own, ...viaPrereqs, 1));
    stack.delete(id);
    effective.set(id, level);
    return level;
  }

  const groups = new Map<number, ManifestModule[]>();
  for (const module of modules) {
    const level = effectiveLevel(module.id);
    const group = groups.get(level) ?? [];
    group.push(module);
    groups.set(level, group);
  }

  const ordered: LearningPathItem[] = [];

  for (const level of LEVELS) {
    const group = groups.get(level) ?? [];
    const core = group.filter((module) => module.track !== "case-files");
    const caseFiles = group.filter((module) => module.track === "case-files");
    if (core.length === 0 && caseFiles.length === 0) continue;

    const inBand = new Set(core.map((module) => module.id));
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const module of core) {
      const prereqs = module.prerequisites.filter((prereq) => inBand.has(prereq));
      indegree.set(module.id, prereqs.length);
      for (const prereq of prereqs) {
        dependents.set(prereq, [...(dependents.get(prereq) ?? []), module.id]);
      }
    }

    const tracks = [...new Set(core.map((module) => module.track))].sort();
    const ready = core.filter((module) => (indegree.get(module.id) ?? 0) === 0);
    const orderedCore: ManifestModule[] = [];
    let rotation = 0;

    const rank = (module: ManifestModule) => {
      const index = tracks.indexOf(module.track);
      return (index - rotation + tracks.length) % tracks.length;
    };

    while (ready.length > 0) {
      ready.sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.id.localeCompare(b.id));
      const next = ready.shift();
      if (!next) break;
      orderedCore.push(next);
      rotation = (tracks.indexOf(next.track) + 1) % Math.max(1, tracks.length);
      for (const dependentId of dependents.get(next.id) ?? []) {
        const remaining = (indegree.get(dependentId) ?? 1) - 1;
        indegree.set(dependentId, remaining);
        if (remaining === 0) {
          const dependent = byId.get(dependentId);
          if (dependent) ready.push(dependent);
        }
      }
    }

    if (orderedCore.length < core.length) {
      const placed = new Set(orderedCore.map((module) => module.id));
      orderedCore.push(
        ...core
          .filter((module) => !placed.has(module.id))
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
      );
    }

    const coreIndex = new Map(orderedCore.map((module, index) => [module.id, index]));
    const pending = caseFiles
      .map((module) => {
        const readiness = module.prerequisites.reduce((max, prereq) => {
          const index = coreIndex.get(prereq);
          return index === undefined ? max : Math.max(max, index + 1);
        }, 0);
        return { module, readiness };
      })
      .sort((a, b) => a.readiness - b.readiness || a.module.difficulty - b.module.difficulty || a.module.title.localeCompare(b.module.title));

    const slots = new Set<number>();
    for (let index = 6; index < Math.max(6, orderedCore.length); index += 6) slots.add(index);
    const usedSlots = new Set<number>();
    const atSlot = new Map<number, ManifestModule[]>();
    const tail: ManifestModule[] = [];

    for (const item of pending) {
      const eligible = [...slots]
        .filter((slot) => slot >= Math.max(6, item.readiness) && !usedSlots.has(slot))
        .sort((a, b) => a - b);
      const slot = eligible[0];
      if (slot === undefined) {
        tail.push(item.module);
      } else {
        usedSlots.add(slot);
        atSlot.set(slot, [...(atSlot.get(slot) ?? []), item.module]);
      }
    }

    for (let index = 0; index <= orderedCore.length; index++) {
      for (const module of atSlot.get(index) ?? []) {
        ordered.push({ module, level, milestone: true });
      }
      const module = orderedCore[index];
      if (module) ordered.push({ module, level, milestone: false });
    }
    for (const module of tail) {
      ordered.push({ module, level, milestone: true });
    }
  }

  return ordered;
}

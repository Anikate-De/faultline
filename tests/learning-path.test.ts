import { describe, expect, it } from "vitest";
import { MANIFEST } from "@/content/manifest";
import { buildLearningPath } from "@/content/learningPath";

const path = buildLearningPath(MANIFEST);
const indexById = new Map(path.map((item, index) => [item.module.id, index]));

describe("learning path", () => {
  it("contains every module exactly once", () => {
    expect(path).toHaveLength(MANIFEST.length);
    expect(new Set(path.map((item) => item.module.id)).size).toBe(MANIFEST.length);
  });

  it("increases level monotonically", () => {
    let previous = 0;
    for (const item of path) {
      expect(item.level).toBeGreaterThanOrEqual(previous);
      previous = item.level;
    }
  });

  it("places every prerequisite before its dependent", () => {
    for (const item of path) {
      const at = indexById.get(item.module.id);
      expect(at).toBeDefined();
      for (const prereq of item.module.prerequisites) {
        const prereqAt = indexById.get(prereq);
        expect(prereqAt, `${item.module.id} -> ${prereq}`).toBeDefined();
        expect(prereqAt ?? -1, `${prereq} must precede ${item.module.id}`).toBeLessThan(at ?? -1);
      }
    }
  });

  it("places all case files as milestones after their prerequisites", () => {
    const caseFiles = path.filter((item) => item.milestone);
    expect(caseFiles).toHaveLength(60);
    for (const item of caseFiles) {
      expect(item.module.track).toBe("case-files");
      const at = indexById.get(item.module.id) ?? -1;
      for (const prereq of item.module.prerequisites) {
        expect(indexById.get(prereq) ?? Infinity).toBeLessThan(at);
      }
    }
  });
});

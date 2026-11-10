import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Irreversible schema change during a rolling application deploy",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common schema-migration and rollback failure modes into one representative case. It does not describe any company's architecture, dates, traffic, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "Schema first, application second",
      body: "The pipeline applies a migration before the new application version becomes healthy. The change adds a required settlement state column, backfills it, and drops the legacy state column in one step. Old instances are still serving traffic.",
      tone: "warn",
    },
    {
      at: "T+00:20",
      title: "Old writers fail",
      body: "The previous version still inserts into the dropped legacy column. Writes return a column-does-not-exist error while reads keep working, so readiness probes stay green and the rollout continues.",
      tone: "danger",
    },
    {
      at: "T+03:00",
      title: "The rollout stops",
      body: "Write errors cross the release gate and the rollout is halted. Old and new versions now disagree about the shape of a write, and the queue of failed mutations is growing.",
      tone: "danger",
    },
    {
      at: "T+06:00",
      title: "Rollback is not available",
      body: "The previous binary also writes the legacy column, so redeploying it does not restore service. The migration has no down script, and restoring the pre-change backup would discard recent writes. Two versions now exist, but only one schema.",
      tone: "danger",
    },
    {
      at: "T+14:00",
      title: "Forward repair begins",
      body: "The team re-adds the legacy column as nullable, installs a temporary dual-write path, and backfills both directions. A version that can read and write either shape is deployed while the contract step is suspended.",
      tone: "warn",
    },
    {
      at: "T+38:00",
      title: "Writes recover",
      body: "Both application versions can complete writes again, and the failed-mutation backlog drains. The release is abandoned, but the schema remains in its expanded state.",
      tone: "success",
    },
    {
      at: "T+21 days",
      title: "The contract step runs separately",
      body: "After every reader uses the new field and the old version is out of rotation, the legacy column is dropped in a separate change with its own verification and rollback plan.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "rollback-blocked",
      prompt:
        "Application rollback fails because the previous binary cannot run against the new schema. What is the first move?",
      options: [
        {
          id: "restore-compatibility",
          label:
            "Re-expand the schema, add a nullable compatibility column, dual-write, and roll forward.",
          consequence:
            "Writes become possible for both versions again. The fix is slower than a binary rollback, but it preserves recent data and removes the incompatibility instead of hiding it.",
          quality: "good",
        },
        {
          id: "restore-backup",
          label: "Restore the pre-migration backup and redeploy the previous version.",
          consequence:
            "The schema returns to a shape the old binary understands, but every write since the migration is lost. Recovery also takes longer than the incident because the restore must complete before traffic resumes.",
          quality: "poor",
        },
        {
          id: "force-old-binary",
          label: "Force the previous binary into service and retry the rollout later.",
          consequence:
            "The old binary still writes the dropped column, so writes continue to fail. The team adds deployment churn without changing the condition that broke the write path.",
          quality: "poor",
        },
      ],
      debrief:
        "Rollback is a property of the application and schema pair, not of the binary alone. Once the schema step is destructive, restoring the old binary cannot restore service. The fastest safe path is to rebuild a compatibility surface, accept that the release will not be rolled back, and sequence the contract step for later.",
    },
    {
      id: "change-sequence",
      prompt: "How should a change of this shape have been sequenced?",
      options: [
        {
          id: "expand-contract",
          label:
            "Expand with nullable fields, backfill, switch reads, stop old writes, then contract in a later release.",
          consequence:
            "Each step is independently reversible and both application versions remain valid for the whole window. The cost is more releases and a period where two representations must be kept consistent.",
          quality: "good",
        },
        {
          id: "single-migration",
          label: "Apply the complete schema change and deploy the new version together.",
          consequence:
            "The system is consistent when it works, but there is no moment when both versions are valid. Any partial rollout or rollback becomes an outage rather than a slower release.",
          quality: "poor",
        },
        {
          id: "permanent-dual-write",
          label: "Keep both columns and dual-write indefinitely to avoid a contract step.",
          consequence:
            "Compatibility is preserved, but every write pays twice and the two representations can drift. The temporary complexity becomes permanent and no one can say which field is authoritative.",
          quality: "mixed",
        },
      ],
      debrief:
        "Expand and contract separates the risky part of a schema change into small, reversible steps. The expand step adds a representation that old and new code can both tolerate. The contract step removes the old representation only after it is unused. Combining them saves a release but removes the ability to stop safely in the middle.",
    },
    {
      id: "compatibility-gate",
      prompt: "Which gate would have caught this before production?",
      options: [
        {
          id: "version-matrix",
          label:
            "Run the current and previous application versions against the migrated schema, including writes.",
          consequence:
            "The gate exercises the actual compatibility matrix rather than one version in isolation. It fails on the dropped column before the migration reaches production.",
          quality: "good",
        },
        {
          id: "staging-new-only",
          label: "Run the full integration suite in staging with the new version only.",
          consequence:
            "The new version passes because it matches the new schema. The previous version, which is still serving traffic during the rollout, is never tested against the change.",
          quality: "mixed",
        },
        {
          id: "migration-linter",
          label: "Rely on a migration linter to reject destructive statements.",
          consequence:
            "The linter may flag the dropped column, but it cannot see how the previous application version uses it. A destructive change can also be legitimate when it is sequenced correctly.",
          quality: "mixed",
        },
      ],
      debrief:
        "Schema compatibility is a matrix of application versions and schema states. Testing only the new version proves that the destination works, not that the transition is safe. A useful gate runs the previous version's writes against the migrated schema and keeps a canary serving both versions until the contract step.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A migration added a required column and removed its predecessor while old application instances were still running. Old writes failed against the new schema, and the rollout could not be completed or rolled back. The team restored compatibility, dual-wrote during a repair window, and deferred the destructive step.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "The schema change and the application change shipped as one unit, with no state in which both versions were valid.",
        "Readiness probes checked reads only, so failing writes did not stop the rollout.",
        "The migration had no down path, and the rollback runbook covered binaries but not data.",
        "The release gate tested the new version in staging and never tested the previous version against the migrated schema.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Destructive schema changes require an expand and contract plan with a named contract release.",
        "Migration review includes a previous-version compatibility test that performs writes.",
        "Canary analysis checks a write path, not only read success and latency.",
        "The rollback runbook states the data-loss tradeoff when a schema step cannot be reversed.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A migration is not complete when the new code works. It is complete when the old code still works, or when the old code can no longer receive traffic. Deployments that mix schema and application changes need a compatibility window by design, not a rollback plan that assumes the database can follow the binary backwards.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, versions, and error observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Parallel Change",
      url: "https://martinfowler.com/bliki/ParallelChange.html",
      publisher: "Martin Fowler",
      kind: "docs",
      note: "Expand, migrate, and contract sequencing for backward-compatible changes.",
    },
    {
      title: "ALTER TABLE",
      url: "https://www.postgresql.org/docs/current/sql-altertable.html",
      publisher: "PostgreSQL Documentation",
      kind: "docs",
      note: "Locking and validation behavior of schema changes.",
    },
    {
      title: "Canarying Releases",
      url: "https://sre.google/workbook/canarying-releases/",
      publisher: "Google SRE Workbook",
      kind: "book",
      note: "Canary selection, evaluation, and rollback criteria.",
    },
  ],
};

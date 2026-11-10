import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Erasure completed in the primary store but not in derived or retained copies",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common data-mapping, backup, and deletion-propagation failures into one representative privacy-engineering event. It is not a real company incident and does not describe any organization's systems, data, or legal obligations. All periods and volumes are illustrative. This is engineering education, not legal advice.",
  timeline: [
    {
      at: "Day 0",
      title: "An erasure request is verified",
      body: "A customer requests deletion of their account data. Identity verification succeeds, and the request is assigned a deadline based on the organization's published policy and applicable obligations.",
      tone: "info",
    },
    {
      at: "Day 1",
      title: "The primary record is deleted",
      body: "The account service deletes the profile row and queues a search-index update. The runbook defines the primary database as the source of truth, so the request is marked complete once that delete commits.",
      tone: "success",
    },
    {
      at: "Day 3",
      title: "The request is closed",
      body: "The index update succeeds. No one checks the analytics warehouse, the recommendation feature store, or the log pipeline. The request is closed as fulfilled inside the internal target.",
      tone: "warn",
    },
    {
      at: "Day 12",
      title: "The customer reappears in recommendations",
      body: "The customer reports that a new account still shows recommendations derived from the deleted profile. The recommendation model reads a feature table built from an earlier warehouse snapshot.",
      tone: "danger",
    },
    {
      at: "Day 13",
      title: "The data map is incomplete",
      body: "Investigation finds the deleted identifier in three places: the derived feature table, a search replica that had not rebuilt, and daily backups retained for thirty-five days. Logs also contain the identifier in request traces.",
      tone: "danger",
    },
    {
      at: "Day 20",
      title: "Deletion becomes an event",
      body: "The team deletes the derived rows, rebuilds the affected index, and starts publishing deletion events that downstream systems must acknowledge. Restores consult a suppression list before serving deleted identifiers.",
      tone: "success",
    },
    {
      at: "Day 30",
      title: "Residual copies are documented",
      body: "All reachable copies are gone. The immutable backups expire on their normal schedule, and the deletion key for future requests allows the encrypted payload to be rendered unreadable. The customer receives a precise response.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "is-it-complete",
      prompt: "The primary database delete succeeded. Is the erasure request complete?",
      options: [
        {
          id: "map-every-copy",
          label: "No. Trace the identifier through derived stores, logs, caches, and backups before closing.",
          consequence:
            "The team finds residual copies while the request is still open and can remediate them within the committed window. Completion is based on a data map rather than a single successful delete.",
          quality: "good",
        },
        {
          id: "primary-only",
          label: "Yes. The primary database is the system of record, so downstream copies will age out.",
          consequence:
            "The request looks complete, but personal data remains in a feature table and an index that may serve it again. The eventual complaint arrives after the deadline and damages trust.",
          quality: "poor",
        },
        {
          id: "delete-all-backups",
          label: "Restore every backup now and delete the identifier from each one.",
          consequence:
            "The intent is thorough, but restoring immutable backups is slow, risks the recovery chain, and may not be technically possible within the deadline. A documented expiry and suppression path is more reliable.",
          quality: "mixed",
        },
      ],
      debrief:
        "Erasure is a property of the data map, not of one database. Primary stores, derived tables, search indexes, caches, logs, and backups all hold copies with different lifecycles. A request is complete only when each copy is deleted, anonymized, or covered by a documented retention and suppression policy.",
    },
    {
      id: "backup-policy",
      prompt: "How should the backup tier handle erasure?",
      options: [
        {
          id: "crypto-shred",
          label:
            "Encrypt per-subject data with managed keys and destroy the key, while suppressing deleted identities on restore.",
          consequence:
            "The backup remains immutable and recoverable for everyone else, but the deleted subject's payload is unreadable. A suppression list prevents a restore from reintroducing the identifier.",
          quality: "good",
        },
        {
          id: "expiry-only",
          label: "Rely on the backup expiry window and document that copies remain until then.",
          consequence:
            "This can be defensible when the retention is short, documented, and consistently applied. It still requires a restore-suppression control, or a recovery can resurrect deleted data.",
          quality: "mixed",
        },
        {
          id: "immediate-everywhere",
          label: "Promise immediate deletion from every backup, including immutable copies.",
          consequence:
            "The promise is technically impossible without breaking immutability or the recovery chain. The team either misses the commitment or weakens backup integrity to keep it.",
          quality: "poor",
        },
      ],
      debrief:
        "Backups exist to survive deletion, so erasure cannot mean rewriting every immutable copy on demand. The practical controls are per-subject encryption with key destruction, a bounded expiry that is documented to the requester, and a suppression mechanism that filters deleted identities during restore. The policy must describe which control applies to which tier.",
    },
    {
      id: "derived-data",
      prompt: "How do you stop derived systems from recreating deleted data?",
      options: [
        {
          id: "deletion-events",
          label: "Publish deletion events with acknowledgements, and reconcile each derived store against them.",
          consequence:
            "Every consumer has a defined obligation and a way to prove it applied the deletion. Reconciliation catches systems that were offline or missed the event.",
          quality: "good",
        },
        {
          id: "periodic-rebuild",
          label: "Rebuild every derived store from the primary database once a quarter.",
          consequence:
            "The deleted row eventually disappears, but the window can exceed the erasure deadline and the rebuild is expensive. Systems that cache beyond the rebuild still retain copies.",
          quality: "mixed",
        },
        {
          id: "manual-tickets",
          label: "Have the privacy team open a ticket for each downstream system on every request.",
          consequence:
            "The process depends on a human remembering every consumer. As the number of stores grows, a missed ticket becomes a residual copy and an unreported breach of the commitment.",
          quality: "poor",
        },
      ],
      debrief:
        "Derived data is where erasure most often fails because the primary delete looks complete. Deletion needs to be an event with consumers, acknowledgements, and reconciliation, not a side effect of one service. The control should also cover model features, caches, and indexes that can outlive the source row.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "An erasure request deleted the primary profile and updated the search index, but the identifier remained in a feature table, a stale replica, and daily backups. A recommendation derived from the old profile surfaced on a new account. The team expanded the data map, propagated deletion events, added restore suppression, and documented the backup expiry path.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "The runbook defined completion as a successful delete in the primary database.",
        "No one owned the inventory of derived stores and their retention.",
        "Backups were immutable but had no per-subject key or restore-suppression control.",
        "The search replica could serve stale data after the primary delete.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "A maintained data map lists every store, copy type, retention period, and deletion mechanism.",
        "Deletion events require acknowledgement, with a reconciliation job for missed consumers.",
        "Backups use per-subject encryption for sensitive payloads and suppress deleted identities on restore.",
        "The customer response states what was deleted, what remains until expiry, and when it will disappear.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Erasure is a distributed-systems problem with a legal deadline. The primary database is only one replica of the truth. A credible program maps every copy, makes deletion an event with acknowledgements, handles immutable backups through crypto-shredding or documented expiry, and verifies that a restore cannot resurrect a deleted identity.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Engineering education, not legal advice",
      body: "Erasure obligations, exceptions, and response deadlines depend on applicable law and the organization's commitments. This scenario teaches engineering controls; consult qualified privacy counsel for a real request.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All days, retention periods, and data volumes in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Regulation (EU) 2016/679 (GDPR), Article 17",
      url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
      publisher: "European Union",
      kind: "standard",
      note: "Right to erasure and the conditions under which it applies.",
    },
    {
      title: "Data protection in the EU",
      url: "https://commission.europa.eu/law/law-topic/data-protection_en",
      publisher: "European Commission",
      kind: "standard",
      note: "The EU framework and individual rights, including erasure and its exceptions.",
    },
    {
      title: "Guidelines for Media Sanitization",
      url: "https://csrc.nist.gov/pubs/sp/800/88/r1/final",
      publisher: "NIST",
      kind: "standard",
      note: "Sanitization and cryptographic erase concepts for stored data.",
    },
    {
      title: "Data deletion on Google Cloud",
      url: "https://cloud.google.com/security/deletion",
      publisher: "Google Cloud",
      kind: "docs",
      note: "Deletion lifecycle, backups, and cryptographic erasure.",
    },
  ],
};

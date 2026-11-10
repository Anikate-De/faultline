export type TrackId =
  | "foundations"
  | "observability"
  | "traffic"
  | "caching"
  | "databases"
  | "mongodb"
  | "streaming"
  | "containers"
  | "mesh"
  | "deployment"
  | "reliability"
  | "cloud-networking"
  | "compliance"
  | "capacity"
  | "case-files"
  | "kubernetes";

export type Difficulty = 1 | 2 | 3 | 4;

export interface ModuleMeta {
  id: string;
  slug: string;
  title: string;
  track: TrackId;
  order: number;
  difficulty: Difficulty;
  minutes: number;
  prerequisites: string[];
  tags: string[];
  productionQuestion: string;
  learningDelta: string;
  objectives: string[];
  interviewQuestions: number;
  hasSim: boolean;
  caseStudy?: boolean;
  appliesTo?: TrackId[];
  featured?: boolean;
  status: "published" | "draft" | "planned";
  lastReviewed: string;
}

export type Tone = "info" | "warn" | "danger" | "success" | "interview";

export type Block =
  | { type: "p"; text: string }
  | { type: "h2"; text: string; id?: string }
  | { type: "h3"; text: string }
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "callout"; tone: Tone; title: string; body: string }
  | {
      type: "compare";
      leftTitle: string;
      rightTitle: string;
      rows: { label: string; left: string; right: string }[];
    }
  | { type: "code"; language: string; title?: string; code: string; caption?: string }
  | { type: "diagram"; id: string; props?: Record<string, unknown>; caption?: string }
  | { type: "sim"; simId: string }
  | { type: "experiment"; experimentId: string }
  | { type: "metrics"; items: { label: string; value: string; tone?: Tone }[] }
  | { type: "timeline"; events: { at: string; title: string; body: string; tone?: Tone }[] }
  | { type: "checklist"; title?: string; items: string[] }
  | { type: "glossary"; termIds: string[] }
  | { type: "quote"; text: string; attribution?: string; source?: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "custom"; id: string };

export interface InterviewQuestion {
  id: string;
  question: string;
  difficulty: 1 | 2 | 3 | 4;
  hints: string[];
  answer: string;
  followUps: string[];
  redFlags: string[];
  rubric: string[];
}

export interface Experiment {
  id: string;
  title: string;
  simId: string;
  question: string;
  prediction: {
    options: { id: string; label: string }[];
    correctOptionId: string;
    explanation: string;
  };
  setup: Record<string, number | string | boolean>;
  runFor: number;
  observe: string[];
  explain: string;
  fix?: Record<string, number | string | boolean>;
  debrief: string;
}

export interface Reference {
  title: string;
  url: string;
  publisher: string;
  kind: "docs" | "postmortem" | "book" | "talk" | "standard";
  note?: string;
}

export interface ChecklistGroup {
  title: string;
  items: string[];
}

export interface Module {
  meta: ModuleMeta;
  primer: Block[];
  sims: Record<string, SimSpec>;
  experiments: Experiment[];
  debrief: Block[];
  interview: InterviewQuestion[];
  checklist: ChecklistGroup[];
  references: Reference[];
  related: string[];
  caseStudy?: CaseStudy;
}

export type CaseStudyKind = "public" | "composite";

export interface CaseStudy {
  kind: CaseStudyKind;
  company: string;
  date: string;
  incidentClass: string;
  sources: Reference[];
  accuracyNote: string;
  architecture?: { id: string; props?: Record<string, unknown> };
  timeline: { at: string; title: string; body: string; tone?: Tone }[];
  decisions: {
    id: string;
    prompt: string;
    options: { id: string; label: string; consequence: string; quality: "good" | "mixed" | "poor" }[];
    debrief: string;
  }[];
  postmortem: Block[];
}

export type SimSpec = import("@/simulation/engine/types").SimSpec;

export interface TrackDef {
  id: TrackId;
  title: string;
  short: string;
  purpose: string;
  description: string;
  planned: number;
  reserved?: boolean;
}

export interface GlossaryTerm {
  id: string;
  term: string;
  short: string;
  body: string;
  track: TrackId;
  aliases?: string[];
  related?: string[];
}

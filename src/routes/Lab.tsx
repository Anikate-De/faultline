import { useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { AlertTriangle, Bell, Boxes, CheckCircle2, FlaskConical, Gauge as GaugeIcon, LayoutGrid, Sparkles } from "lucide-react";
import type { InterviewQuestion as InterviewQuestionType } from "@/content/types";
import type { SimulationController } from "@/simulation/engine/useSimulation";
import { labModel, labPresets } from "@/simulation/labModel";
import { makeLabFrame, type LabState } from "@/simulation/labFrames";
import { SimShell } from "@/simulation/kit/SimShell";
import { SimVisual } from "@/simulation/kit/visuals";
import { CausalPanel, EventFeed, IncidentBanner, MetricLegend, SimSummary } from "@/simulation/kit/events";
import { AreaChart, Gauge, Heatmap, MetricCard, Sparkline } from "@/simulation/kit/metrics";
import { ParamSlider, PresetBar } from "@/simulation/kit/controls";
import { Badge, DifficultyBadge, StatusBadge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout, CodeBlock, Tip } from "@/components/ui/Callout";
import {
  Accordion,
  Dialog,
  Input,
  NumberInput,
  SegmentedControl,
  Sheet,
  Tabs,
  useToast,
} from "@/components/ui/Controls";
import { EmptyState, ErrorBoundary, Skeleton, Spinner } from "@/components/ui/Feedback";
import { BookmarkButton, CompletionButton, ProgressRing } from "@/components/ui/Progress";
import { ConfidencePicker } from "@/components/interview/InterviewQuestion";
import { PredictionPicker, Quiz, RevealPanel } from "@/components/ui/Reveal";
import { InterviewModeToggle, ThemeToggle } from "@/components/ui/ThemeToggle";
import { DiagramFrame } from "@/components/content/DiagramFrame";
import { CaseFileCard, ModuleCard, TrackCard } from "@/components/layout/Cards";
import { CASE_FILES, MODULE_BY_ID } from "@/content/manifest";
import { GlossaryTooltip } from "@/components/content/GlossaryLink";
import { ReadingProgress } from "@/components/ui/Progress";
import { Annotation } from "@/simulation/kit/events";
import { DeploymentTrack, EmptyStage, SimLegend, TimelineScrubber } from "@/simulation/kit/visuals";

const labInterview: InterviewQuestionType = {
  id: "lab-question",
  question: "A service is at 60% CPU and p99 is rising. What do you check before adding capacity?",
  difficulty: 2,
  hints: ["Utilization is not the only queueing input.", "Look at the dependency and the work per request."],
  answer:
    "Start with the queue and the work: p99 versus utilization, queue depth, dependency latency, and retries. A service at 60% CPU can still queue if requests wait on a downstream call or if traffic is bursty. Adding capacity may help, but if the time is spent waiting on a dependency, it only adds cost. Check whether a release changed work per request or whether retries are amplifying load.",
  followUps: ["Which signal would make you add capacity immediately?", "What would make you reduce work instead?"],
  redFlags: ["Add replicas before checking the dependency.", "Use average latency as evidence."],
  rubric: ["Names queueing and utilization.", "Checks dependency and retries.", "States a tradeoff for scaling."],
};

function CrashDemo() {
  const [crash, setCrash] = useState(false);
  if (crash) throw new Error("Lab demo error");
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">A route-level boundary catches render failures and keeps the rest of the app usable.</p>
      <Button variant="danger" onClick={() => setCrash(true)}>Trigger render error</Button>
    </div>
  );
}

export default function Lab() {
  const reducedMotion = useReducedMotion() ?? false;
  const [state, setState] = useState<LabState>("crit");
  const [visual, setVisual] = useState("shards");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [prediction, setPrediction] = useState("");
  const [predictionRevealed, setPredictionRevealed] = useState(false);
  const [load, setLoad] = useState(3800);
  const controllerRef = useRef<SimulationController | null>(null);
  const { toast } = useToast();
  const frame = makeLabFrame(visual as never, state);
  const simSpec = { model: labModel, presets: labPresets, instructions: "Lab model for component QA." };

  return (
    <div className="space-y-8">
      <ReadingProgress />
      <header className="max-w-3xl">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="interview">Hidden route</Badge>
          <Badge>Author and QA reference</Badge>
        </div>
        <h1 className="mt-2">Component and simulation lab</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Every primitive, state, and standard visual. Module authors compose these; they do not rebuild the
          control panel, charts, or incident banner. Check mobile, dark/light, and reduced motion here before
          authoring.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">UI primitives</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-[16px] border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold text-text">Buttons and icon buttons</h3>
            <div className="flex flex-wrap gap-2">
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="interview">Interview</Button>
              <IconButton label="Notification demo" variant="secondary"><Bell aria-hidden="true" className="size-4" /></IconButton>
            </div>
          </div>
          <div className="space-y-3 rounded-[16px] border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold text-text">Badges and states</h3>
            <div className="flex flex-wrap gap-2">
              <Badge tone="info">Info</Badge>
              <Badge tone="success">Healthy</Badge>
              <Badge tone="warn">Saturated</Badge>
              <Badge tone="danger">Failing</Badge>
              <Badge tone="interview">Interview</Badge>
              <DifficultyBadge value={3} />
            </div>
            <div className="flex flex-wrap gap-2">
              <StatusBadge state="ok" />
              <StatusBadge state="warn" />
              <StatusBadge state="crit" />
              <StatusBadge state="down" />
            </div>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Callout tone="info" title="Info callout">A concrete, short explanation.</Callout>
          <Callout tone="warn" title="Warning callout">A threshold is close.</Callout>
          <Callout tone="danger" title="Danger callout">A failure is active.</Callout>
          <Callout tone="success" title="Success callout">The fix is verified.</Callout>
        </div>
        <Tip title="Tip / author note">Explain the tradeoff before the learner asks for it.</Tip>
        <CodeBlock title="run.sh" language="bash" code={'npm run typecheck\nnpm run validate:content\nnpm run test -- src/modules/caching/hot-key-sharding'} caption="Validation is part of the authoring contract." />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Controls</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-[16px] border border-border bg-surface p-4">
            <Input label="Module slug" defaultValue="hot-key-sharding" hint="Kebab case, unique across the manifest." />
            <Input label="Broken input" defaultValue="not-a-slug" error="Use lowercase letters, numbers, and hyphens only." />
            <NumberInput label="Concurrent users" value={load} min={100} max={10_000} step={100} unit="rps" onChange={setLoad} help="Numeric input with steppers and a unit." />
            <SegmentedControl label="Difficulty" value="3" onChange={() => undefined} options={[{ value: "1", label: "Intro" }, { value: "2", label: "Core" }, { value: "3", label: "Advanced" }, { value: "4", label: "Expert" }]} />
            <ParamSlider spec={labModel.params[0]} value={load} onChange={setLoad} />
          </div>
          <div className="space-y-3">
            <Tabs
              label="Lab tabs"
              items={[
                { id: "one", label: "Primer", content: <p className="text-sm text-muted">Tabs are keyboard operable with arrow keys.</p> },
                { id: "two", label: "Simulator", content: <p className="text-sm text-muted">The sim panel is the reusable core of every module.</p> },
                { id: "three", label: "Debrief", content: <p className="text-sm text-muted">Signals, fix, tradeoff.</p> },
              ]}
            />
            <Accordion
              label="Lab accordions"
              items={[
                { id: "a", title: "What each simulation must include", content: "Healthy, failure, and recovery presets; 3–6 parameters; at least one threshold with cause and fix.", defaultOpen: true },
                { id: "b", title: "What stays hidden", content: "Prediction keys, experiment explanations, and interview model answers." },
              ]}
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
              <Button variant="secondary" onClick={() => setSheetOpen(true)}>Open sheet</Button>
              <Button variant="ghost" onClick={() => toast("Saved locally.", "success")}>Show toast</Button>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Feedback and reveal states</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-3 rounded-[16px] border border-border bg-surface p-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-20" />
            <Spinner label="Loading a module" />
            <EmptyState title="Empty review queue" body="Rate confidence on a module to add it. This is the empty pattern used by every route." />
          </div>
          <div className="space-y-3 rounded-[16px] border border-border bg-surface p-4">
            <RevealPanel label="Reveal answer" tone="interview" hint="Content is not rendered until the learner asks.">
              <p>Model answer: check the hot shard first, because the aggregate is hiding the partition.</p>
            </RevealPanel>
            <PredictionPicker
              question="Which shard saturates?"
              options={[{ id: "hot", label: "The shard with the hot key" }, { id: "random", label: "A random shard" }, { id: "db", label: "The database" }, { id: "all", label: "All shards equally" }]}
              value={prediction}
              onChange={setPrediction}
              correctId="hot"
              revealed={predictionRevealed}
              explanation="The hot key is hashed to one shard; the rest have spare capacity."
            />
            <Button size="sm" disabled={!prediction} onClick={() => setPredictionRevealed(true)}>Reveal prediction</Button>
            <Quiz
              question="Which signal proves the ALB, not the target, is the bottleneck?"
              options={[{ id: "conn", label: "Per-ALB active connections and LCU" }, { id: "cpu", label: "Target CPU only" }, { id: "db", label: "Database latency" }]}
              correctId="conn"
              explanation="Per-ALB connection and LCU limits are visible at the load balancer. Healthy targets with ALB rejections point away from target capacity."
            />
            <div className="flex items-center gap-2">
              <ProgressRing value={64} size={44} />
              <ConfidencePicker moduleId="lab-demo" />
            </div>
            <div className="flex flex-wrap gap-2">
              <BookmarkButton moduleId="lab-demo" />
              <CompletionButton moduleId="lab-demo" />
              <ThemeToggle />
              <div className="hidden sm:block"><InterviewModeToggle /></div>
            </div>
          </div>
        </div>
        <div className="rounded-[16px] border border-border bg-surface p-4">
          <ErrorBoundary fallback={<div className="rounded-[10px] border border-[var(--tone-danger-border)] bg-[var(--tone-danger-bg)] p-3 text-sm text-danger">Caught by the lab boundary. The rest of the page still renders.</div>}>
            <CrashDemo />
          </ErrorBoundary>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Cards</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <TrackCard trackId="caching" />
          <ModuleCard module={MODULE_BY_ID.get("caching-hot-key-sharding")!} authored />
          <CaseFileCard module={CASE_FILES[0]} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Content primitives</h2>
        <DiagramFrame id="hot-key-shards" caption="A hot key saturates one shard while seven remain idle." title="Hot key topology" />
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          Inline glossary: <GlossaryTooltip termId="hot-key">hot key</GlossaryTooltip> and <GlossaryTooltip termId="p99">p99</GlossaryTooltip>.
        </div>
        <div className="flex flex-wrap gap-2">
          <Annotation title="Author note">Use annotations for a short, non-answer hint on a diagram or control.</Annotation>
          <Annotation title="Check first" tone="warn">Confirm the metric before changing capacity.</Annotation>
        </div>
        <div className="rounded-[16px] border border-border bg-surface p-4">
          <h3 className="mb-2 text-sm font-semibold">Interview question</h3>
          <InterviewSample />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Metrics and charts</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard metric={frame.metrics[0]} />
          <Gauge value={62} max={100} label="Utilization" unit="%" />
          <AreaChart values={frame.series.p99 ?? []} label="p99 latency" unit="ms" warn={300} crit={800} />
          <div className="rounded-[12px] border border-border bg-surface p-3">
            <p className="mb-2 text-xs font-medium">Sparkline</p>
            <Sparkline values={frame.series.p99 ?? []} label="p99 sparkline" width={220} height={56} />
          </div>
        </div>
        <Heatmap rows={Object.entries(frame.series).filter(([key]) => key.startsWith("cpu.")).map(([key, values]) => ({ label: key.replace("cpu.", ""), values }))} label="Shard CPU heat" />
        <div className="flex flex-wrap items-center gap-4">
          <SimLegend items={[{ label: "Healthy", tone: "ok" }, { label: "Saturated", tone: "warn" }, { label: "Failing", tone: "crit" }, { label: "Unavailable", tone: "down" }]} />
          <MetricLegend metric={frame.metrics[2]} />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Standard visuals</h2>
            <p className="text-sm text-muted">All visuals use the same frame and the same incident language.</p>
          </div>
          <div className="w-full sm:w-64">
            <SegmentedControl
              label="Visual state"
              value={state}
              onChange={setState}
              options={[{ value: "ok", label: "OK" }, { value: "warn", label: "Warn" }, { value: "crit", label: "Crit" }, { value: "down", label: "Down" }]}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {["flow", "shards", "queue", "replication", "deployment", "topology", "heatmap", "timeline"].map((item) => (
            <button key={item} type="button" aria-pressed={visual === item} onClick={() => setVisual(item)} className={visual === item ? "min-h-10 rounded-md border border-accent bg-accent/10 px-3 text-xs text-accent" : "min-h-10 rounded-md border border-border px-3 text-xs text-muted hover:text-text"}>
              {item}
            </button>
          ))}
        </div>
        <div className="rounded-[16px] border border-border bg-surface p-3">
          <IncidentBanner frame={frame} thresholds={labModel.thresholds} />
          <div className="mt-3">
            <SimVisual visual={visual as never} frame={frame} reducedMotion={reducedMotion} />
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <EventFeed events={frame.events} />
            <CausalPanel frame={frame} insights={labModel.insights(frame, labModel.params.reduce((acc, p) => ({ ...acc, [p.id]: p.value }), {}))} thresholds={labModel.thresholds} />
          </div>
          <div className="mt-2">
            <SimSummary summary={frame.summary} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-[16px] border border-border bg-surface p-4">
            <h3 className="mb-2 text-sm font-semibold">Deployment track</h3>
            <DeploymentTrack frame={makeLabFrame("deployment", state)} />
          </div>
          <div className="rounded-[16px] border border-border bg-surface p-4">
            <h3 className="mb-2 text-sm font-semibold">Timeline scrubber</h3>
            <TimelineScrubber frame={makeLabFrame("timeline", state)} />
          </div>
        </div>
        <EmptyStage label="Empty stage pattern, used when a custom visual has no data." />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Interactive shell</h2>
          <Badge tone="info">Engine demo</Badge>
          <span className="ml-auto text-xs text-muted">Play, step, reset, change speed, open focus mode, apply a preset.</span>
        </div>
        <SimShell spec={simSpec} title="Lab flow model" controllerRef={controllerRef} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Presets and parameters</h2>
        <PresetBar presets={labPresets} activeId="healthy" onApply={() => undefined} />
        <div className="grid gap-3 sm:grid-cols-2">
          {labModel.params.map((param) => (
            <ParamSlider key={param.id} spec={param} value={Number(param.value)} onChange={() => undefined} />
          ))}
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-3 rounded-[16px] border border-border bg-surface p-4">
        <GaugeIcon aria-hidden="true" className="size-5 text-accent" />
        <p className="text-sm text-muted">
          Check the lab at 360px and 390px with dark, light, and reduced motion. No horizontal page scroll; controls stay at least 44px.
        </p>
        <span className="font-mono text-[10px] text-faint">{reducedMotion ? "Reduced motion is active" : "Motion is enabled"}</span>
      </section>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title="Dialog pattern" description="Focus is trapped while open; Escape closes it." footer={<div className="flex justify-end"><Button onClick={() => setDialogOpen(false)}>Close</Button></div>}>
        <p className="text-sm text-muted">Use dialogs for confirmations and short forms, not for long lesson content.</p>
      </Dialog>
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Bottom sheet pattern" description="Node details and mobile controls use sheets.">
        <p className="text-sm text-muted">Sheet content scrolls inside the panel; the page behind it is locked.</p>
      </Sheet>
    </div>
  );
}

function InterviewSample() {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text">{labInterview.question}</p>
      <RevealPanel label="Model answer and rubric" tone="interview" hint="This is the same component used on module pages.">
        <p>{labInterview.answer}</p>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {labInterview.rubric.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </RevealPanel>
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Sparkles aria-hidden="true" className="size-4" />
        {open ? "Hide" : "Show"} explain-it-back prompt
      </Button>
      {open ? <p className="rounded-md border border-border bg-raised p-2 text-xs text-muted">Explain the system, signal, first check, fix, and one tradeoff in 60 seconds.</p> : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <CheckCircle2 aria-hidden="true" className="size-4 text-success" /> Answer hiding verified
        <AlertTriangle aria-hidden="true" className="size-4 text-warn" /> Incident uses text, not color alone
        <FlaskConical aria-hidden="true" className="size-4 text-info" /> Experiment prediction hidden until run
        <Boxes aria-hidden="true" className="size-4 text-accent" /> Components are semantic tokens
        <LayoutGrid aria-hidden="true" className="size-4 text-faint" /> 360px first
      </div>
    </div>
  );
}

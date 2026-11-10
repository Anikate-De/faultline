import { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes,
  ChevronRight,
  CircleDot,
  Cloud,
  Database,
  Gauge,
  Globe2,
  Inbox,
  Layers,
  Monitor,
  Network,
  Radio,
  Server,
  Shield,
  Timer,
  TriangleAlert,
  Zap,
} from "lucide-react";
import type { Health, MetricValue, SimEdge, SimFrame, SimNode, VisualKind } from "@/simulation/engine/types";
import { formatClock, formatMetric, cn } from "@/lib/format";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Sheet } from "@/components/ui/Controls";
import { Heatmap, Sparkline } from "./metrics";

const iconFor: Record<SimNode["kind"], typeof Server> = {
  client: Monitor,
  dns: Globe2,
  cdn: Cloud,
  lb: Network,
  service: Server,
  cache: Zap,
  db: Database,
  queue: Inbox,
  stream: Radio,
  worker: Boxes,
  storage: Layers,
  mesh: Shield,
  external: Globe2,
};

const healthRing: Record<Health, string> = {
  ok: "border-[var(--tone-success-border)]",
  warn: "border-[var(--tone-warn-border)]",
  crit: "border-[var(--tone-danger-border)]",
  down: "border-[var(--tone-danger-border)] opacity-80",
};

const healthBar: Record<Health, string> = {
  ok: "bg-success",
  warn: "bg-warn",
  crit: "bg-danger",
  down: "bg-critical",
};

export function NodeCard({
  node,
  onSelect,
  compact = false,
}: {
  node: SimNode;
  onSelect: (node: SimNode) => void;
  compact?: boolean;
}) {
  const Icon = iconFor[node.kind] ?? Server;
  const utilization = node.utilization ?? 0;
  return (
    <button
      type="button"
      data-node-id={node.id}
      onClick={() => onSelect(node)}
      className={cn(
        "relative z-10 w-full rounded-[12px] border bg-surface p-3 text-left transition-colors hover:border-faint sm:w-[152px]",
        healthRing[node.health],
        compact && "p-2.5",
        node.health === "down" && "bg-[repeating-linear-gradient(135deg,var(--surface),var(--surface)_6px,var(--raised)_6px,var(--raised)_12px)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-raised text-accent">
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <span className="text-[10px] font-medium text-muted">
          {node.health === "ok" ? "Healthy" : node.health === "warn" ? "Saturated" : node.health === "crit" ? "Failing" : "Unavailable"}
        </span>
      </div>
      <p className="mt-2 truncate text-sm font-semibold text-text">{node.label}</p>
      {node.sublabel ? <p className="truncate text-[11px] text-muted">{node.sublabel}</p> : null}
      {node.utilization !== undefined ? (
        <div className="mt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-raised">
            <div className={cn("h-full rounded-full", healthBar[node.health])} style={{ width: `${Math.min(100, utilization * 100)}%` }} />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[10px] text-faint">
            <span>{Math.round(utilization * 100)}%</span>
            {node.throughput !== undefined ? <span>{formatMetric(node.throughput, " rps", "rps")}</span> : null}
          </div>
        </div>
      ) : null}
      <span className="sr-only">Open node details.</span>
    </button>
  );
}

export function NodeDetailSheet({
  node,
  metrics,
  onClose,
}: {
  node: SimNode | null;
  metrics: MetricValue[];
  onClose: () => void;
}) {
  return (
    <Sheet open={Boolean(node)} onClose={onClose} title={node?.label ?? "Node"}>
      {node ? (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge state={node.health} />
            {node.role ? <Badge>{node.role}</Badge> : null}
            <Badge>{node.kind}</Badge>
          </div>
          {node.detail ? <p className="text-muted">{node.detail}</p> : null}
          <dl className="grid grid-cols-2 gap-2">
            {node.utilization !== undefined ? (
              <div className="rounded-md border border-border bg-raised p-2">
                <dt className="text-[10px] uppercase tracking-[0.06em] text-faint">Utilization</dt>
                <dd className="font-mono text-lg text-text">{Math.round(node.utilization * 100)}%</dd>
              </div>
            ) : null}
            {node.throughput !== undefined ? (
              <div className="rounded-md border border-border bg-raised p-2">
                <dt className="text-[10px] uppercase tracking-[0.06em] text-faint">Throughput</dt>
                <dd className="font-mono text-lg text-text">{formatMetric(node.throughput, " rps", "rps")}</dd>
              </div>
            ) : null}
            {node.meta
              ? Object.entries(node.meta)
                  .filter(([key]) => key !== "view" && key !== "stage" && key !== "hot")
                  .map(([key, value]) => (
                    <div key={key} className="rounded-md border border-border bg-raised p-2">
                      <dt className="text-[10px] uppercase tracking-[0.06em] text-faint">{key}</dt>
                      <dd className="font-mono text-sm text-text">{typeof value === "number" ? value.toFixed(1) : String(value)}</dd>
                    </div>
                  ))
              : null}
          </dl>
          {metrics.length ? (
            <div>
              <h3 className="mb-1 font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Related metrics</h3>
              <ul className="space-y-1">
                {metrics.slice(0, 5).map((metric) => (
                  <li key={metric.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1">
                    <span className="text-xs text-muted">{metric.label}</span>
                    <span className="font-mono text-xs text-text">{formatMetric(metric.value, metric.unit, metric.format)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

function useStagePositions(nodes: SimNode[]) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const next: Record<string, { x: number; y: number }> = {};
    stage.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
      const id = element.dataset.nodeId;
      if (!id) return;
      const nodeRect = element.getBoundingClientRect();
      next[id] = {
        x: nodeRect.left - rect.left + nodeRect.width / 2,
        y: nodeRect.top - rect.top + nodeRect.height / 2,
      };
    });
    setPositions(next);
  }, []);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const frame = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, nodes.length]);
  return { stageRef, positions, measure };
}

export function ParticleLayer({
  positions,
  edges,
  reducedMotion,
  active = true,
}: {
  positions: Record<string, { x: number; y: number }>;
  edges: SimEdge[];
  reducedMotion: boolean;
  active?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dataRef = useRef({ positions, edges });
  const reducedRef = useRef(reducedMotion);
  useEffect(() => {
    dataRef.current = { positions, edges };
    reducedRef.current = reducedMotion;
  }, [positions, edges, reducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let frame = 0;
    let visible = true;
    let width = 0;
    let height = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const mobile = window.innerWidth < 640;
    const maxParticles = mobile ? 150 : 300;

    const resize = () => {
      const parent = canvas.parentElement;
      width = parent?.clientWidth ?? 0;
      height = parent?.clientHeight ?? 0;
      canvas.width = Math.max(1, width * dpr);
      canvas.height = Math.max(1, height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    if (canvas.parentElement) observer?.observe(canvas.parentElement);

    const color = (health: Health) =>
      health === "crit" || health === "down"
        ? "rgba(244,63,94,0.55)"
        : health === "warn"
          ? "rgba(251,191,36,0.5)"
          : "rgba(79,209,197,0.38)";

    const draw = (time: number) => {
      const { positions: pos, edges: list } = dataRef.current;
      ctx.clearRect(0, 0, width, height);
      const usable = list.filter((edge) => pos[edge.from] && pos[edge.to]);
      const counts = usable.map((edge) => Math.max(1, Math.min(12, Math.round(edge.rate * 10))));
      const total = counts.reduce((sum, count) => sum + count, 0);
      const scale = total > maxParticles ? maxParticles / total : 1;
      usable.forEach((edge, edgeIndex) => {
        const from = pos[edge.from];
        const to = pos[edge.to];
        const stroke = color(edge.health);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = edge.health === "ok" ? 1 : 1.5;
        ctx.setLineDash(edge.health === "ok" ? [] : [4, 4]);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const count = Math.max(1, Math.round(counts[edgeIndex] * scale));
        for (let i = 0; i < count; i++) {
          const offset = i / count + edgeIndex * 0.13;
          const t = reducedRef.current ? (i + 0.5) / count : (time / 2200 + offset) % 1;
          const x = from.x + (to.x - from.x) * t;
          const y = from.y + (to.y - from.y) * t;
          ctx.fillStyle = stroke;
          ctx.beginPath();
          ctx.arc(x, y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    };

    const loop = (time: number) => {
      if (!active || !visible || reducedRef.current) return;
      draw(time);
      frame = requestAnimationFrame(loop);
    };

    draw(performance.now());
    if (active && !reducedRef.current) frame = requestAnimationFrame(loop);
    const visibilityObserver = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(
      (entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
        if (visible && active && !reducedRef.current) {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(loop);
        } else {
          cancelAnimationFrame(frame);
        }
      },
      { threshold: 0.01 },
    );
    if (canvas.parentElement) visibilityObserver?.observe(canvas.parentElement);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      visibilityObserver?.disconnect();
    };
  }, [active, reducedMotion]);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 h-full w-full" />;
}

export function FlowVisual({
  frame,
  reducedMotion,
  active = true,
  topology = false,
}: {
  frame: SimFrame;
  reducedMotion: boolean;
  active?: boolean;
  topology?: boolean;
}) {
  const [selected, setSelected] = useState<SimNode | null>(null);
  const flowNodes = frame.nodes
    .filter((node) => node.meta?.view === "flow" || (!node.meta?.view && node.kind !== "cache"))
    .slice(0, topology ? 8 : 6);
  const { stageRef, positions } = useStagePositions(flowNodes);
  const edges = frame.edges.filter(
    (edge) => flowNodes.some((node) => node.id === edge.from) && flowNodes.some((node) => node.id === edge.to),
  );
  const fallbackEdges: SimEdge[] =
    edges.length > 0
      ? edges
      : flowNodes.slice(1).map((node, index) => ({
          id: `fallback-${node.id}`,
          from: flowNodes[index].id,
          to: node.id,
          rate: 0.5,
          health: node.health === "ok" ? "ok" : node.health,
        }));
  return (
    <div className="space-y-2">
      <div ref={stageRef} className="dotted-grid relative overflow-hidden rounded-[12px] border border-border bg-bg/40 p-3 sm:p-4">
        <ParticleLayer positions={positions} edges={fallbackEdges} reducedMotion={reducedMotion} active={active} />
        <div className="relative z-10 flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
          {flowNodes.map((node, index) => (
            <div key={node.id} className="flex w-full items-center gap-2 sm:w-auto">
              <NodeCard node={node} onSelect={setSelected} />
              {index < flowNodes.length - 1 ? (
                <ChevronRight aria-hidden="true" className="hidden size-4 shrink-0 text-faint sm:block" />
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {frame.summary} Tap a node for its current utilization and health.
      </p>
      <NodeDetailSheet node={selected} metrics={frame.metrics.filter((m) => m.id.includes("Cpu") || m.id.includes("p99"))} onClose={() => setSelected(null)} />
    </div>
  );
}

function ShardCard({ node, onSelect }: { node: SimNode; onSelect: (node: SimNode) => void }) {
  const cpu = Number(node.meta?.cpu ?? (node.utilization ?? 0) * 100);
  const memory = Number(node.meta?.memory ?? 0);
  const hot = node.meta?.hot === 1 || node.meta?.hot === "1";
  const Icon = iconFor.cache;
  return (
    <button
      type="button"
      data-node-id={node.id}
      onClick={() => onSelect(node)}
      className={cn(
        "relative z-10 rounded-[12px] border bg-surface p-3 text-left transition-colors hover:border-faint",
        healthRing[node.health],
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-text">
          <Icon aria-hidden="true" className="size-3.5 text-accent" />
          {node.label}
        </span>
        {hot ? <Badge tone="danger">Hot</Badge> : null}
      </div>
      {node.sublabel ? <p className="mt-0.5 truncate text-[10px] text-muted">{node.sublabel}</p> : null}
      <div className="mt-2 space-y-1.5">
        <div>
          <div className="flex justify-between font-mono text-[10px] text-muted">
            <span>CPU</span>
            <span className={cpu >= 85 ? "text-danger" : cpu >= 70 ? "text-warn" : "text-text"}>{Math.round(cpu)}%</span>
          </div>
          <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-raised">
            <div className={cn("h-full rounded-full", healthBar[node.health])} style={{ width: `${Math.min(100, cpu)}%` }} />
          </div>
        </div>
        <div className="flex justify-between font-mono text-[10px] text-faint">
          <span>mem {memory.toFixed(1)}G</span>
          <span>{node.health === "ok" ? "healthy" : node.health === "warn" ? "saturated" : "failing"}</span>
        </div>
      </div>
      <span className="sr-only">Open node details.</span>
    </button>
  );
}

export function ShardsVisual({
  frame,
  reducedMotion,
}: {
  frame: SimFrame;
  reducedMotion: boolean;
}) {
  const [selected, setSelected] = useState<SimNode | null>(null);
  const shards = frame.nodes.filter((node) => node.meta?.view === "shards" || (node.kind === "cache" && node.role === "shard"));
  const rows = shards
    .map((node) => ({
      label: node.label,
      values: frame.series[`cpu.${node.id}`] ?? [],
    }))
    .filter((row) => row.values.length > 0);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {shards.map((node) => (
          <ShardCard key={node.id} node={node} onSelect={setSelected} />
        ))}
      </div>
      {rows.length ? (
        <Heatmap rows={rows} label="Per-shard CPU over time" />
      ) : null}
      <p className="text-xs leading-relaxed text-muted">
        {shards.length ? `${shards.length} shards. Capacity is set by the hottest shard, not the average.` : "No shards reported."}
        {reducedMotion ? " Reduced motion is on; state changes remain visible." : ""}
      </p>
      <NodeDetailSheet
        node={selected}
        metrics={frame.metrics.filter((m) => m.id.toLowerCase().includes("cpu") || m.id.toLowerCase().includes("p99"))}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

export function HeatmapVisual({ frame }: { frame: SimFrame }) {
  const rows = Object.entries(frame.series)
    .filter(([key]) => key.startsWith("cpu."))
    .map(([key, values]) => ({ label: key.replace("cpu.", ""), values }));
  return <Heatmap rows={rows.length ? rows : [{ label: "load", values: frame.series.load ?? [] }]} label="CPU / load heat" />;
}

export function QueueVisual({ frame }: { frame: SimFrame }) {
  const [selected, setSelected] = useState<SimNode | null>(null);
  const queue = frame.nodes.find((node) => node.kind === "queue" || node.kind === "stream");
  const workers = frame.nodes.filter((node) => node.kind === "worker");
  const producers = frame.nodes.filter((node) => node.kind === "service");
  const depth = frame.metrics.find((m) => m.id === "queueDepth")?.value ?? 0;
  return (
    <div className="space-y-2">
      <div className="grid gap-2 rounded-[12px] border border-border bg-bg/40 p-3">
        <div className="space-y-2">
          {producers.map((node) => <NodeCard key={node.id} node={node} onSelect={setSelected} compact />)}
        </div>
        <div className="flex flex-col justify-center gap-2 rounded-md border border-border bg-surface p-3 text-center">
          <Inbox aria-hidden="true" className="mx-auto size-5 text-accent" />
          <p className="text-xs font-semibold text-text">{queue?.label ?? "Queue"}</p>
          <p className="font-mono text-2xl tabular-nums text-text">{Math.round(depth).toLocaleString()}</p>
          <p className="text-[10px] text-muted">messages waiting</p>
        </div>
        <div className="space-y-2">
          {workers.map((node) => <NodeCard key={node.id} node={node} onSelect={setSelected} compact />)}
        </div>
      </div>
      <p className="text-xs text-muted">{frame.summary} Depth alone is ambiguous; age and arrival rate set the risk.</p>
      <NodeDetailSheet node={selected} metrics={frame.metrics} onClose={() => setSelected(null)} />
    </div>
  );
}

export function ReplicationVisual({ frame }: { frame: SimFrame }) {
  const [selected, setSelected] = useState<SimNode | null>(null);
  const primary = frame.nodes.find((node) => node.role === "primary");
  const replicas = frame.nodes.filter((node) => node.role === "replica");
  return (
    <div className="space-y-2">
      <div className="flex flex-col items-stretch gap-2 rounded-[12px] border border-border bg-bg/40 p-3">
        {primary ? <NodeCard node={primary} onSelect={setSelected} /> : null}
        <ChevronRight aria-hidden="true" className="mx-auto size-4 rotate-90 text-faint" />
        <div className="grid flex-1 gap-2">
          {replicas.map((node) => (
            <div key={node.id} className="space-y-1">
              <NodeCard node={node} onSelect={setSelected} compact />
              <p className="text-center font-mono text-[10px] text-faint">
                lag {formatMetric(Number(node.meta?.lag ?? 0), "s")}
              </p>
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted">{frame.summary} Replica lag is a freshness budget, not just a replica problem.</p>
      <NodeDetailSheet node={selected} metrics={frame.metrics} onClose={() => setSelected(null)} />
    </div>
  );
}

export function DeploymentVisual({ frame }: { frame: SimFrame }) {
  const stages = ["stable", "canary", "full"];
  return (
    <div className="space-y-2">
      <div className="grid gap-2 rounded-[12px] border border-border bg-bg/40 p-3">
        {stages.map((stage) => {
          const nodes = frame.nodes.filter((node) => node.meta?.stage === stage);
          return (
            <div key={stage} className="space-y-2 rounded-md border border-border bg-surface p-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">{stage}</p>
              {nodes.length ? nodes.map((node) => <NodeCard key={node.id} node={node} onSelect={() => undefined} compact />) : <p className="text-xs text-muted">No instances</p>}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted">{frame.summary} A canary gate must cover capacity at the final scale.</p>
    </div>
  );
}

export function TimelineVisual({ frame }: { frame: SimFrame }) {
  const [index, setIndex] = useState(0);
  const events = frame.events;
  const selected = events[Math.max(0, Math.min(events.length - 1, index))];
  return (
    <div className="space-y-2 rounded-[12px] border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Incident replay</p>
        <span className="font-mono text-[10px] text-muted">{events.length} events</span>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(0, events.length - 1)}
        value={Math.min(index, Math.max(0, events.length - 1))}
        onChange={(event) => setIndex(Number(event.target.value))}
        aria-label="Timeline scrubber"
        aria-valuetext={selected ? `${formatClock(selected.at)}: ${selected.title}` : "No events"}
        className="h-11 w-full accent-[var(--accent)]"
      />
      {selected ? (
        <div className="rounded-md border border-border bg-raised p-2">
          <p className="font-mono text-[10px] text-faint">{formatClock(selected.at)}</p>
          <p className="text-sm font-medium text-text">{selected.title}</p>
          <p className="text-xs text-muted">{selected.detail}</p>
        </div>
      ) : (
        <p className="text-xs text-muted">No events to replay.</p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {frame.metrics.slice(0, 2).map((metric) => (
          <div key={metric.id} className="rounded-md border border-border p-2">
            <p className="text-[10px] uppercase tracking-[0.06em] text-faint">{metric.label}</p>
            <Sparkline values={frame.series[metric.id] ?? []} label={`${metric.label} trend`} width={240} height={36} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function TopologyVisual({ frame, reducedMotion, active = true }: { frame: SimFrame; reducedMotion: boolean; active?: boolean }) {
  return <FlowVisual frame={frame} reducedMotion={reducedMotion} active={active} topology />;
}

export function EmptyStage({ label = "No visual data" }: { label?: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-[12px] border border-dashed border-border bg-bg/40 p-6 text-center">
      <Gauge aria-hidden="true" className="size-6 text-faint" />
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}


export function TraceVisual({ frame }: { frame: SimFrame }) {
  const spans = frame.nodes.filter((node) => node.span);
  if (spans.length === 0) return <EmptyStage label="No spans in this trace." />;
  const total = Math.max(...spans.map((node) => (node.span?.start ?? 0) + (node.span?.duration ?? 0)), 1);
  const ordered = [...spans].sort(
    (a, b) => (a.span?.start ?? 0) - (b.span?.start ?? 0) || (a.span?.depth ?? 0) - (b.span?.depth ?? 0),
  );
  return (
    <div
      className="space-y-2"
      role="img"
      aria-label={`Trace waterfall with ${spans.length} spans over ${Math.round(total)} milliseconds`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">Trace waterfall</span>
        <span className="font-mono text-[10px] text-faint">{Math.round(total)}ms total</span>
      </div>
      <div className="space-y-1.5">
        {ordered.map((node) => {
          const span = node.span;
          if (!span) return null;
          const left = Math.min(100, Math.max(0, (span.start / total) * 100));
          const width = Math.min(100 - left, Math.max(1.5, (span.duration / total) * 100));
          const selfWidth = span.self && span.duration > 0 ? Math.min(width, (span.self / total) * 100) : 0;
          const tone =
            span.missing || node.health === "down"
              ? "border border-dashed border-faint bg-raised"
              : node.health === "ok"
                ? "bg-success/75"
                : node.health === "warn"
                  ? "bg-warn/75"
                  : "bg-danger/75";
          return (
            <div key={node.id} className="grid grid-cols-[minmax(0,1fr)_66px] items-start gap-2">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${Math.min(48, span.depth * 10)}px` }}>
                  {span.critical ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
                  <span className="truncate text-xs font-medium text-text">{node.label}</span>
                  <span className="shrink-0 rounded bg-raised px-1 py-0.5 font-mono text-[9px] uppercase tracking-[0.04em] text-faint">
                    {span.kind}
                  </span>
                  {span.missing ? <span className="shrink-0 font-mono text-[9px] text-faint">missing</span> : null}
                </div>
                <div className="relative mt-1 h-2.5 overflow-hidden rounded-full bg-raised">
                  <span
                    className={`absolute top-0 h-full rounded-full ${tone}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                  {selfWidth > 0 && !span.missing ? (
                    <span
                      className="absolute top-0 h-full rounded-full bg-text/25"
                      style={{ left: `${left}%`, width: `${selfWidth}%` }}
                      aria-hidden="true"
                    />
                  ) : null}
                </div>
              </div>
              <span className="pt-0.5 text-right font-mono text-[10px] tabular-nums text-muted">
                {span.missing ? "gap" : `${Math.round(span.duration)}ms`}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-2 font-mono text-[10px] text-faint">
        <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-full bg-accent" /> critical path</span>
        <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-full bg-text/25" /> self time</span>
        <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-full border border-dashed border-faint" /> missing span</span>
      </div>
    </div>
  );
}


export function HistogramVisual({ frame }: { frame: SimFrame }) {
  const [active, setActive] = useState<string | null>(null);
  const data = frame.histogram;
  if (!data || data.buckets.length === 0) return <EmptyStage label="No histogram buckets." />;
  const max = Math.max(...data.buckets.map((bucket) => bucket.count), 1);
  const total = data.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const selected = data.buckets.flatMap((bucket) => (bucket.exemplar ? [bucket.exemplar] : [])).find((item) => item.traceId === active);
  return (
    <div className="space-y-2" role="group" aria-label={`Latency histogram with ${data.buckets.length} buckets`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">Latency histogram</span>
        <span className="font-mono text-[10px] text-faint">{formatMetric(total, data.unit ?? " requests", "count")}</span>
      </div>
      <div className="space-y-1.5">
        {data.buckets.map((bucket, index) => (
          <div key={bucket.label} className="grid grid-cols-[70px_minmax(0,1fr)_56px] items-center gap-2">
            <span className="truncate font-mono text-[10px] text-muted">{bucket.label}</span>
            <div className="relative h-5 rounded bg-raised">
              <span
                className="absolute inset-y-0 left-0 rounded bg-accent/60"
                style={{ width: `${Math.max(1, (bucket.count / max) * 100)}%` }}
              />
              {bucket.exemplar ? (
                <button
                  type="button"
                  aria-label={`Inspect exemplar trace ${bucket.exemplar.traceId} at ${bucket.exemplar.durationMs}ms`}
                  onClick={() => setActive(active === bucket.exemplar?.traceId ? null : bucket.exemplar!.traceId)}
                  className="absolute top-1/2 z-10 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  style={{ left: `${Math.max(2, (bucket.count / max) * 100)}%` }}
                >
                  <span aria-hidden="true" className="size-3 rounded-full border-2 border-bg bg-warn shadow-sm" />
                </button>
              ) : null}
            </div>
            <span className="text-right font-mono text-[10px] tabular-nums text-muted">{formatMetric(bucket.count, "", "count")}</span>
            <span className="sr-only">Bucket {index + 1}</span>
          </div>
        ))}
      </div>
      {selected ? (
        <div className="rounded-md border border-border bg-raised p-2" role="status">
          <p className="font-mono text-[10px] text-faint">{selected.traceId}</p>
          <p className="text-xs text-text">
            {selected.service} · {selected.durationMs}ms
          </p>
          <p className="mt-0.5 text-[11px] text-muted">The exemplar links this slow bucket to a real trace. Open the trace to see where the time went.</p>
        </div>
      ) : (
        <p className="font-mono text-[10px] text-faint">Select a dot to inspect the linked trace.</p>
      )}
    </div>
  );
}

export function SimVisual({
  visual,
  frame,
  reducedMotion,
  active = true,
}: {
  visual: VisualKind;
  frame: SimFrame;
  reducedMotion: boolean;
  active?: boolean;
}) {
  switch (visual) {
    case "flow":
      return <FlowVisual frame={frame} reducedMotion={reducedMotion} active={active} />;
    case "shards":
      return <ShardsVisual frame={frame} reducedMotion={reducedMotion} />;
    case "heatmap":
      return <HeatmapVisual frame={frame} />;
    case "queue":
      return <QueueVisual frame={frame} />;
    case "replication":
      return <ReplicationVisual frame={frame} />;
    case "deployment":
      return <DeploymentVisual frame={frame} />;
    case "topology":
      return <TopologyVisual frame={frame} reducedMotion={reducedMotion} active={active} />;
    case "timeline":
      return <TimelineVisual frame={frame} />;
    case "trace":
      return <TraceVisual frame={frame} />;
    case "histogram":
      return <HistogramVisual frame={frame} />;
    default:
      return <EmptyStage label="This module uses a custom visual." />;
  }
}

export function NodeHealthLabel({ health }: { health: Health }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      {health === "ok" ? <CircleDot aria-hidden="true" className="size-3 text-success" /> : <TriangleAlert aria-hidden="true" className="size-3 text-danger" />}
      {health === "ok" ? "Healthy" : health === "warn" ? "Saturated" : health === "crit" ? "Failing" : "Unavailable"}
    </span>
  );
}

export function DeploymentTrack({ frame }: { frame: SimFrame }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {frame.nodes.slice(0, 8).map((node) => (
        <span key={node.id} className={cn("rounded-full border px-2 py-1 font-mono text-[10px]", healthRing[node.health])}>
          {node.label} · {node.health}
        </span>
      ))}
    </div>
  );
}

export function TimelineScrubber({ frame }: { frame: SimFrame }) {
  return <TimelineVisual frame={frame} />;
}

export function LegendDot({ tone }: { tone: "ok" | "warn" | "crit" | "down" | "info" }) {
  const color = tone === "ok" ? "bg-success" : tone === "warn" ? "bg-warn" : tone === "crit" ? "bg-danger" : tone === "down" ? "bg-critical" : "bg-info";
  return <span aria-hidden="true" className={cn("size-2 rounded-full", color)} />;
}

export function SimLegend({ items }: { items: { label: string; tone: "ok" | "warn" | "crit" | "down" | "info" }[] }) {
  return (
    <div className="flex flex-wrap gap-3">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5 text-[10px] text-muted">
          <LegendDot tone={item.tone} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function HealthIcon({ health }: { health: Health }) {
  return health === "ok" ? <CircleDot aria-hidden="true" className="size-4 text-success" /> : <TriangleAlert aria-hidden="true" className="size-4 text-danger" />;
}

export function TimerIcon() {
  return <Timer aria-hidden="true" className="size-4" />;
}

export function MetricMini({ metric }: { metric: MetricValue }) {
  return (
    <span className="font-mono text-xs text-muted">
      {metric.label} {formatMetric(metric.value, metric.unit, metric.format)}
    </span>
  );
}

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import { orgSummary, type Contact, type Org } from "../api";

type PersonNode = SimulationNodeDatum & { kind: "person"; id: string; contact: Contact; degree: number; r: number };
type OrgNode = SimulationNodeDatum & { kind: "org"; id: string; org: Org };
type Node = PersonNode | OrgNode;
type Link = SimulationLinkDatum<Node> & { kind: "rel" | "member" | "parent"; note: string; share: number };
type View = { x: number; y: number; k: number };
type Selection = { type: "person" | "org"; id: number } | null;
type Pt = [number, number];

type Props = {
  contacts: Contact[];
  orgs: Org[];
  query: string;
  focusId?: number;
  onOpen: (id: number) => void;
  onOpenOrg: (id: number) => void;
};

/** Fixed-order categorical hues (validated palette); organizations past the eighth fall back to neutral gray. */
const ORG_COLORS = 8;
const EMPTY_R = 20;
const BASE_PAD = 24;
const LEVEL_PAD = 16;

/** Every person is drawn the same size. */
const NODE_R = 7;
const personMatches = (c: Contact, q: string) =>
  [c.name, c.role, c.department, c.research, ...c.orgs.map((o) => o.name)].some((v) => v.toLowerCase().includes(q));

/** Org hierarchy facts the layout and drawing need. */
function orgStructure(orgs: Org[]) {
  const byId = new Map(orgs.map((o) => [o.id, o]));
  const children = new Map<number, Org[]>();
  for (const o of orgs) if (o.parent_id != null && byId.has(o.parent_id)) children.set(o.parent_id, [...(children.get(o.parent_id) ?? []), o]);
  const height = new Map<number, number>();
  const heightOf = (o: Org, seen = new Set<number>()): number => {
    if (height.has(o.id)) return height.get(o.id)!;
    if (seen.has(o.id)) return 0;
    seen.add(o.id);
    const h = Math.max(-1, ...(children.get(o.id) ?? []).map((c) => heightOf(c, seen))) + 1;
    height.set(o.id, h);
    return h;
  };
  orgs.forEach((o) => heightOf(o));
  const descendants = (id: number): Org[] => (children.get(id) ?? []).flatMap((c) => [c, ...descendants(c.id)]);
  const ancestors = (id: number): number[] => {
    const out: number[] = [];
    for (let p = byId.get(id)?.parent_id; p != null && byId.has(p) && !out.includes(p); p = byId.get(p)!.parent_id) out.push(p);
    return out;
  };
  // Everyone in an organization or anything inside it.
  const members = new Map<number, Set<number>>();
  for (const o of orgs) members.set(o.id, new Set([o, ...descendants(o.id)].flatMap((d) => d.members.map((m) => m.id))));
  const pad = (id: number) => BASE_PAD + LEVEL_PAD * (height.get(id) ?? 0);
  return { byId, children, height, descendants, ancestors, members, pad };
}

/** Convex hull (monotone chain). */
function hull(points: Pt[]): Pt[] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Ray-casting point-in-polygon test. */
function inside(pt: Pt, poly: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const shorten = (text: string, max = 26) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const circlePoints = (x: number, y: number, r: number, n = 20): Pt[] =>
  Array.from({ length: n }, (_, i) => [x + r * Math.cos((2 * Math.PI * i) / n), y + r * Math.sin((2 * Math.PI * i) / n)] as Pt);

/** Force-directed web of people, their connections, and organization bubbles they sit inside (Venn-style). */
export function NetworkView({ contacts, orgs, query, focusId, onOpen, onOpenOrg }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<Node, Link> | null>(null);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const [, setFrame] = useState(0);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [selected, setSelected] = useState<Selection>(focusId ? { type: "person", id: focusId } : null);
  const [hover, setHover] = useState<{ node: PersonNode; x: number; y: number } | null>(null);
  const [showIsolated, setShowIsolated] = useState(false);
  const [showOrgs, setShowOrgs] = useState(true);
  const fitted = useRef(false);

  useEffect(() => {
    if (focusId) setSelected({ type: "person", id: focusId });
  }, [focusId]);

  const structure = useMemo(() => orgStructure(orgs), [orgs]);
  const colorIndex = useMemo(() => new Map([...orgs].sort((a, b) => a.id - b.id).map((o, i) => [o.id, i < ORG_COLORS ? i + 1 : 0])), [orgs]);

  const { nodes, links, orgNodes, people } = useMemo(() => {
    const placed = (id: string) => positions.current.get(id);
    const visible = contacts.filter((c) => showIsolated || c.related.length > 0 || (showOrgs && c.orgs.length > 0));
    const ids = new Set(visible.map((c) => c.id));
    const people: PersonNode[] = visible.map((c) => ({
      kind: "person",
      id: `p${c.id}`,
      contact: c,
      degree: c.related.length,
      r: NODE_R,
      ...placed(`p${c.id}`),
    }));
    const orgNodes: OrgNode[] = showOrgs ? orgs.map((o) => ({ kind: "org", id: `o${o.id}`, org: o, ...placed(`o${o.id}`) })) : [];
    const links: Link[] = [];
    for (const c of visible) {
      for (const r of c.related) if (c.id < r.id && ids.has(r.id)) links.push({ kind: "rel", source: `p${c.id}`, target: `p${r.id}`, note: r.note, share: 1 });
      if (showOrgs) for (const m of c.orgs) links.push({ kind: "member", source: `p${c.id}`, target: `o${m.id}`, note: "", share: c.orgs.length });
    }
    if (showOrgs)
      for (const o of orgs) if (o.parent_id != null && structure.byId.has(o.parent_id)) links.push({ kind: "parent", source: `o${o.id}`, target: `o${o.parent_id}`, note: "", share: 1 });
    return { nodes: [...people, ...orgNodes] as Node[], links, orgNodes, people };
  }, [contacts, orgs, showIsolated, showOrgs, structure]);

  const personById = useMemo(() => new Map(people.map((p) => [p.contact.id, p])), [people]);
  const orgNodeById = useMemo(() => new Map(orgNodes.map((n) => [n.org.id, n])), [orgNodes]);

  /** Seed circles each bubble is drawn around: its (indirect) members, plus empty sub-organizations inside it. */
  const bubbleSeeds = (o: Org): { x: number; y: number; r: number }[] => {
    const pad = structure.pad(o.id);
    const seeds: { x: number; y: number; r: number }[] = [];
    for (const id of structure.members.get(o.id) ?? []) {
      const p = personById.get(id);
      if (p?.x != null) seeds.push({ x: p.x, y: p.y!, r: pad });
    }
    for (const d of [o, ...structure.descendants(o.id)]) {
      const hasPeople = [...(structure.members.get(d.id) ?? [])].some((id) => personById.has(id));
      const n = orgNodeById.get(d.id);
      if (!hasPeople && n?.x != null) seeds.push({ x: n.x, y: n.y!, r: EMPTY_R + pad - structure.pad(d.id) });
    }
    return seeds;
  };

  // Physics. Restarts gently when the data changes; nodes keep their previous positions.
  useEffect(() => {
    const radius = new Map<number, number>();
    const shapes = new Map<number, { poly: Pt[]; cx: number; cy: number }>();
    const estimateRadii = () => {
      for (const n of orgNodes) {
        const seeds = bubbleSeeds(n.org);
        let r = EMPTY_R;
        for (const s of seeds) r = Math.max(r, Math.hypot(s.x - n.x!, s.y - n.y!) + s.r);
        radius.set(n.org.id, r);
        const poly = hull(seeds.length ? seeds.flatMap((s) => circlePoints(s.x, s.y, s.r, 10)) : circlePoints(n.x!, n.y!, EMPTY_R, 10));
        const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
        const cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
        shapes.set(n.org.id, { poly, cx, cy });
      }
    };
    const related = (a: number, b: number) => structure.ancestors(a).includes(b) || structure.ancestors(b).includes(a);
    const shares = (a: number, b: number) => {
      const ma = structure.members.get(a)!;
      for (const id of structure.members.get(b)!) if (ma.has(id)) return true;
      return false;
    };

    // Unrelated organizations that share nobody keep their bubbles apart.
    const separateOrgs = (alpha: number) => {
      for (let i = 0; i < orgNodes.length; i++)
        for (let j = i + 1; j < orgNodes.length; j++) {
          const a = orgNodes[i];
          const b = orgNodes[j];
          if (related(a.org.id, b.org.id) || shares(a.org.id, b.org.id)) continue;
          const dx = b.x! - a.x! || 0.01;
          const dy = b.y! - a.y! || 0.01;
          const d = Math.hypot(dx, dy);
          const want = (radius.get(a.org.id) ?? EMPTY_R) + (radius.get(b.org.id) ?? EMPTY_R) + 16;
          if (d >= want) continue;
          const push = ((want - d) / d) * alpha * 0.25;
          a.vx! -= dx * push;
          a.vy! -= dy * push;
          b.vx! += dx * push;
          b.vy! += dy * push;
        }
    };
    // People are pushed out of bubbles they don't belong to (tested against the bubble's actual outline).
    const excludeNonMembers = (alpha: number) => {
      for (const n of orgNodes) {
        const shape = shapes.get(n.org.id);
        if (!shape) continue;
        const members = structure.members.get(n.org.id)!;
        for (const p of people) {
          if (members.has(p.contact.id) || !inside([p.x!, p.y!], shape.poly)) continue;
          const dx = p.x! - shape.cx || 0.01;
          const dy = p.y! - shape.cy || 0.01;
          const d = Math.hypot(dx, dy);
          const push = (alpha * 30) / d;
          p.vx! += dx * push;
          p.vy! += dy * push;
        }
      }
    };

    const sim = forceSimulation<Node, Link>(nodes)
      .force(
        "link",
        forceLink<Node, Link>(links)
          .id((n) => n.id)
          .distance((l) => (l.kind === "rel" ? 80 : l.kind === "member" ? 10 : 20))
          .strength((l) => (l.kind === "rel" ? (orgNodes.length ? 0.12 : 0.6) : l.kind === "member" ? 0.5 / l.share : 0.2)),
      )
      .force("charge", forceManyBody<Node>().strength((n) => (n.kind === "person" ? -160 : 0)).distanceMax(260))
      // Room for each name label, which is wider than the dot.
      .force("collide", forceCollide<Node>().radius((n) => (n.kind === "person" ? n.r + 24 : 0)).strength(0.9))
      .force("x", forceX<Node>().strength((n) => (n.kind === "org" ? 0.06 : 0.04)))
      .force("y", forceY<Node>().strength((n) => (n.kind === "org" ? 0.06 : 0.04)))
      .force("orgs", (alpha: number) => {
        estimateRadii();
        separateOrgs(alpha);
        excludeNonMembers(alpha);
      })
      .alpha(positions.current.size ? 0.4 : 1)
      .alphaDecay(0.02)
      .on("tick", () => {
        for (const n of nodes) positions.current.set(n.id, { x: n.x!, y: n.y! });
        setFrame((f) => f + 1);
        // Zoom to fit while the first layout settles, until the user pans or zooms themselves.
        if (!fitted.current && sim.alpha() < 0.3 && Math.round(sim.alpha() * 1000) % 25 === 0) fit();
      })
      .on("end", () => {
        if (!fitted.current) fit();
        fitted.current = true;
      });
    simRef.current = sim;
    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links]);

  // Bubbles, parents first so sub-organizations draw on top of them.
  const bubbles = orgNodes
    .filter((n) => n.x != null)
    .sort((a, b) => (structure.height.get(b.org.id) ?? 0) - (structure.height.get(a.org.id) ?? 0))
    .map((n) => {
      const seeds = bubbleSeeds(n.org);
      const pts = hull(seeds.length ? seeds.flatMap((s) => circlePoints(s.x, s.y, s.r)) : circlePoints(n.x!, n.y!, EMPTY_R));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return {
        org: n.org,
        d: `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L")}Z`,
        cx: (Math.min(...xs) + Math.max(...xs)) / 2,
        bounds: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)],
        label: shorten(n.org.name),
        labelY: 0,
      };
    });

  // Bubble labels: just inside the top edge, or below the bubble if that spot is taken. Larger bubbles claim first.
  {
    const placed: [number, number, number, number][] = [];
    const lineH = 15 * (Math.min(view.k, 1.1) / view.k);
    const boxAt = (b: (typeof bubbles)[number], y: number): [number, number, number, number] => {
      const w = b.label.length * 7 * (Math.min(view.k, 1.1) / view.k);
      return [b.cx - w / 2, b.cx + w / 2, y - lineH, y + 2];
    };
    const overlaps = (a: number[], c: number[]) => a[0] < c[1] && c[0] < a[1] && a[2] < c[3] && c[2] < a[3];
    for (const b of [...bubbles].sort((a, c) => (c.bounds[1] - c.bounds[0]) * (c.bounds[3] - c.bounds[2]) - (a.bounds[1] - a.bounds[0]) * (a.bounds[3] - a.bounds[2]))) {
      const candidates = [b.bounds[2] + lineH, b.bounds[3] + lineH, b.bounds[2] - 4];
      b.labelY = candidates.find((y) => !placed.some((p) => overlaps(p, boxAt(b, y)))) ?? candidates[0];
      placed.push(boxAt(b, b.labelY));
    }
  }

  const fit = () => {
    const svg = svgRef.current;
    if (!svg || nodes.length === 0) return;
    const { width, height } = svg.getBoundingClientRect();
    const xs = [...people.map((n) => n.x ?? 0), ...bubbles.flatMap((b) => b.bounds.slice(0, 2))];
    const ys = [...people.map((n) => n.y ?? 0), ...bubbles.flatMap((b) => b.bounds.slice(2))];
    const [minX, maxX, minY, maxY] = [Math.min(...xs) - 50, Math.max(...xs) + 50, Math.min(...ys) - 30, Math.max(...ys) + 40];
    const k = Math.min(1.6, width / (maxX - minX), height / (maxY - minY));
    setView({ k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k });
  };

  // Center the view on first render, before the layout settles.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const { width, height } = svg.getBoundingClientRect();
    setView({ x: width / 2, y: height / 2, k: 1 });
  }, []);

  const selectedContact = selected?.type === "person" ? contacts.find((c) => c.id === selected.id) : undefined;
  const selectedOrg = selected?.type === "org" ? orgs.find((o) => o.id === selected.id) : undefined;

  /** People to emphasise (selection or search), and organizations to emphasise. */
  const focus = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (selectedContact) {
      const effectiveOrgs = selectedContact.orgs.flatMap((o) => [o.id, ...structure.ancestors(o.id)]);
      return { people: new Set([selectedContact.id, ...selectedContact.related.map((r) => r.id)]), orgs: new Set(effectiveOrgs), dimLinks: true };
    }
    if (selectedOrg) {
      return { people: structure.members.get(selectedOrg.id) ?? new Set<number>(), orgs: new Set([selectedOrg.id, ...structure.descendants(selectedOrg.id).map((d) => d.id)]), dimLinks: true };
    }
    if (q) {
      return {
        people: new Set(contacts.filter((c) => personMatches(c, q)).map((c) => c.id)),
        orgs: new Set(orgs.filter((o) => o.name.toLowerCase().includes(q)).map((o) => o.id)),
        dimLinks: true,
      };
    }
    return null;
  }, [selectedContact, selectedOrg, query, contacts, orgs, structure]);

  // --- pointer handling: drag people, pan background (or a bubble), wheel/pinch zoom ---
  const toGraph = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  };
  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    fitted.current = true;
    const rect = svgRef.current!.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    setView((v) => {
      const k = Math.min(4, Math.max(0.15, v.k * factor));
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    });
  };

  const gesture = useRef<{ node?: PersonNode; orgId?: number; startX: number; startY: number; moved: boolean; view: View } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent, target?: { node?: PersonNode; orgId?: number }) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
      gesture.current = null;
      return;
    }
    gesture.current = { ...target, startX: e.clientX, startY: e.clientY, moved: false, view };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinch.current.dist);
      pinch.current.dist = dist;
      return;
    }
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    setHover(null);
    if (g.node) {
      const p = toGraph(e.clientX, e.clientY);
      g.node.fx = p.x;
      g.node.fy = p.y;
      simRef.current?.alphaTarget(0.3).restart();
    } else {
      fitted.current = true;
      setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.node && g.moved) {
      g.node.fx = null;
      g.node.fy = null;
      simRef.current?.alphaTarget(0);
      return;
    }
    if (g.moved) return;
    const id = g.node?.contact.id ?? g.orgId;
    const type = g.node ? "person" : "org";
    if (id == null) setSelected(null);
    else setSelected(selected?.type === type && selected.id === id ? null : { type, id });
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  });

  // Labels stay roughly the same size on screen instead of growing with the zoom.
  const labelScale = Math.min(view.k, 1.1) / view.k;
  const hiddenCount = contacts.length - people.length;

  const personState = (p: PersonNode) => {
    if (!focus) return "";
    if (selected?.type === "person" && p.contact.id === selected.id) return "selected";
    return focus.people.has(p.contact.id) ? (selected ? "neighbor" : "match") : "dim";
  };
  const orgState = (o: Org) => (!focus ? "" : selected?.type === "org" && o.id === selected.id ? "selected" : focus.orgs.has(o.id) ? "focus" : "dim");

  return (
    <div className="network">
      <svg
        ref={svgRef}
        className="network-svg"
        role="img"
        aria-label="Network of people, their connections and organizations"
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          <g className="bubbles">
            {bubbles.map((b) => (
              <path
                key={b.org.id}
                d={b.d}
                className={`bubble c${colorIndex.get(b.org.id) ?? 0} ${orgState(b.org)}`}
                strokeWidth={1.5 / Math.max(view.k, 0.6)}
                onPointerDown={(e) => onPointerDown(e, { orgId: b.org.id })}
              />
            ))}
          </g>
          <g className="links">
            {links.map((l, i) => {
              if (l.kind !== "rel") return null;
              const s = l.source as PersonNode;
              const t = l.target as PersonNode;
              if (s.x == null || t.x == null) return null;
              const active = selected?.type === "person" && (s.contact.id === selected.id || t.contact.id === selected.id);
              return (
                <line
                  key={i}
                  x1={s.x}
                  y1={s.y}
                  x2={t.x}
                  y2={t.y}
                  className={active ? "link active" : focus ? "link dim" : "link"}
                  strokeWidth={(active ? 2.5 : 1.5) / Math.max(view.k, 0.6)}
                />
              );
            })}
          </g>
          <g className="bubble-labels">
            {bubbles.map((b) => (
              <text
                key={b.org.id}
                x={b.cx}
                y={b.labelY}
                className={`bubble-label c${colorIndex.get(b.org.id) ?? 0} ${orgState(b.org)}`}
                style={{ fontSize: 12 * labelScale, strokeWidth: 3 * labelScale }}
              >
                <title>{b.org.name}</title>
                {b.label}
              </text>
            ))}
          </g>
          <g className="nodes">
            {people.map((n) => {
              if (n.x == null) return null;
              return (
                <g
                  key={n.id}
                  className={`node ${n.contact.in_network ? "in" : "out"} ${personState(n)}`}
                  transform={`translate(${n.x},${n.y})`}
                  onPointerDown={(e) => onPointerDown(e, { node: n })}
                  onPointerEnter={(e) => !gesture.current && setHover({ node: n, x: e.clientX, y: e.clientY })}
                  onPointerLeave={() => setHover(null)}
                >
                  {/* Larger invisible hit target than the visible mark. */}
                  <circle r={n.r + 8} className="hit" />
                  <circle r={n.r} className="dot" />
                  <text y={n.r + 12 * labelScale} className="label" style={{ fontSize: 11 * labelScale, strokeWidth: 3 * labelScale }}>
                    {n.contact.name}
                  </text>
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      <div className="network-tools">
        <button className="icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => zoomCenter(1.3)}>
          +
        </button>
        <button className="icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => zoomCenter(1 / 1.3)}>
          −
        </button>
        <button className="icon-btn small" title="Fit everyone in view" onClick={fit}>
          Fit
        </button>
      </div>

      <div className="network-legend">
        <span>
          <svg width="14" height="14" aria-hidden>
            <circle cx="7" cy="7" r="5.5" className="legend-in" />
          </svg>
          In your contacts
        </span>
        <span>
          <svg width="14" height="14" aria-hidden>
            <circle cx="7" cy="7" r="5.5" className="legend-out" />
          </svg>
          Outside your network
        </span>
        {orgs.length > 0 && (
          <label className="menu-check">
            <input type="checkbox" checked={showOrgs} onChange={(e) => setShowOrgs(e.target.checked)} />
            Organizations
          </label>
        )}
        {(hiddenCount > 0 || showIsolated) && (
          <label className="menu-check">
            <input type="checkbox" checked={showIsolated} onChange={(e) => setShowIsolated(e.target.checked)} />
            {showIsolated ? "Showing everyone" : `Show ${hiddenCount} more with no connections${showOrgs ? " or organizations" : ""}`}
          </label>
        )}
        {!selected && <span className="muted">Click a person or an organization to highlight. Drag to move, scroll to zoom.</span>}
      </div>

      {selectedContact && (
        <div className="network-card">
          <div className="card-top">
            <strong>{selectedContact.name}</strong>
            <button className="icon-btn" aria-label="Clear selection" onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
          <div className="muted small">
            {[selectedContact.role, orgSummary(selectedContact)].filter(Boolean).join(" · ") || "No details yet"}
            {!selectedContact.in_network && <span className="outside-badge">outside network</span>}
          </div>
          {selectedContact.related.length > 0 ? (
            <div className="chips network-connections">
              {selectedContact.related.map((r) => (
                <button
                  key={r.id}
                  className={`tag person ${r.in_network ? "" : "outside"}`}
                  title={r.note || undefined}
                  onClick={() => setSelected({ type: "person", id: r.id })}
                >
                  {r.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted small">No connections yet.</p>
          )}
          <button className="small-btn" onClick={() => onOpen(selectedContact.id)}>
            Open details
          </button>
        </div>
      )}

      {selectedOrg && (
        <div className="network-card">
          <div className="card-top">
            <strong>{selectedOrg.name}</strong>
            <button className="icon-btn" aria-label="Clear selection" onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
          <div className="muted small">
            {[selectedOrg.type, selectedOrg.parent_id ? `part of ${structure.byId.get(selectedOrg.parent_id)?.name ?? ""}` : ""].filter(Boolean).join(" · ") ||
              "Organization"}
          </div>
          {(() => {
            const ids = [...(structure.members.get(selectedOrg.id) ?? [])];
            const list = contacts.filter((c) => ids.includes(c.id));
            return list.length ? (
              <div className="chips network-connections">
                {list.map((c) => (
                  <button key={c.id} className={`tag person ${c.in_network ? "" : "outside"}`} onClick={() => setSelected({ type: "person", id: c.id })}>
                    {c.name}
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted small">Nobody here yet.</p>
            );
          })()}
          <button className="small-btn" onClick={() => onOpenOrg(selectedOrg.id)}>
            Open organization
          </button>
        </div>
      )}

      {hover && (
        <div className="network-tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <strong>{hover.node.contact.name}</strong>
          <div>{[hover.node.contact.role, orgSummary(hover.node.contact)].filter(Boolean).join(" · ")}</div>
          <div className="muted">
            {hover.node.degree} connection{hover.node.degree === 1 ? "" : "s"}
            {hover.node.contact.in_network ? "" : " · outside your network"}
          </div>
        </div>
      )}

      {nodes.length === 0 && <p className="empty network-empty">Nothing to show yet. Link people under “Related to” or add their organizations.</p>}
    </div>
  );

  function zoomCenter(factor: number) {
    const rect = svgRef.current!.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }
}

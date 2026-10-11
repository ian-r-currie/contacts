import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import { currentSchool, type Contact } from "../api";

type Node = SimulationNodeDatum & { id: number; contact: Contact; degree: number; r: number };
type Link = SimulationLinkDatum<Node> & { source: Node | number; target: Node | number; note: string };
type View = { x: number; y: number; k: number };

type Props = {
  contacts: Contact[];
  query: string;
  focusId?: number;
  onOpen: (id: number) => void;
};

const nodeRadius = (degree: number) => 6 + Math.sqrt(degree) * 2.5;
const matches = (c: Contact, q: string) =>
  [c.name, c.role, c.department, c.schools, c.research].some((v) => v.toLowerCase().includes(q));

/** Force-directed web of everyone and their connections. Click a person to highlight who they're connected to. */
export function NetworkView({ contacts, query, focusId, onOpen }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<Node, Link> | null>(null);
  const positions = useRef(new Map<number, { x: number; y: number }>());
  const [, setFrame] = useState(0);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [selected, setSelected] = useState<number | null>(focusId ?? null);
  const [hover, setHover] = useState<{ node: Node; x: number; y: number } | null>(null);
  const [showIsolated, setShowIsolated] = useState(false);
  const fitted = useRef(false);

  useEffect(() => {
    if (focusId) setSelected(focusId);
  }, [focusId]);

  const { nodes, links } = useMemo(() => {
    const visible = contacts.filter((c) => showIsolated || c.related.length > 0);
    const ids = new Set(visible.map((c) => c.id));
    const nodes: Node[] = visible.map((c) => {
      const prev = positions.current.get(c.id);
      return { id: c.id, contact: c, degree: c.related.length, r: nodeRadius(c.related.length), x: prev?.x, y: prev?.y };
    });
    const links: Link[] = [];
    for (const c of visible)
      for (const r of c.related) if (c.id < r.id && ids.has(r.id)) links.push({ source: c.id, target: r.id, note: r.note });
    return { nodes, links };
  }, [contacts, showIsolated]);

  // Physics. Restarts gently when the data changes; nodes keep their previous positions.
  useEffect(() => {
    const sim = forceSimulation<Node, Link>(nodes)
      .force("link", forceLink<Node, Link>(links).id((n) => n.id).distance(80).strength(0.6))
      .force("charge", forceManyBody().strength(-260))
      .force("collide", forceCollide<Node>().radius((n) => n.r + 14))
      .force("x", forceX().strength(0.05))
      .force("y", forceY().strength(0.05))
      .force("center", forceCenter(0, 0))
      .alpha(positions.current.size ? 0.3 : 1)
      .on("tick", () => {
        for (const n of nodes) positions.current.set(n.id, { x: n.x!, y: n.y! });
        setFrame((f) => f + 1);
        // Zoom to fit once the first layout has mostly settled.
        if (!fitted.current && sim.alpha() < 0.12) {
          fitted.current = true;
          fit();
        }
      });
    simRef.current = sim;
    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links]);

  const fit = () => {
    const svg = svgRef.current;
    if (!svg || nodes.length === 0) return;
    const { width, height } = svg.getBoundingClientRect();
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const [minX, maxX, minY, maxY] = [Math.min(...xs) - 60, Math.max(...xs) + 60, Math.min(...ys) - 40, Math.max(...ys) + 40];
    const k = Math.min(1.8, width / (maxX - minX), height / (maxY - minY));
    setView({ k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k });
  };

  // Center the view on first render, before the layout settles.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const { width, height } = svg.getBoundingClientRect();
    setView({ x: width / 2, y: height / 2, k: 1 });
  }, []);

  const neighbors = useMemo(() => {
    if (selected == null) return null;
    const c = contacts.find((x) => x.id === selected);
    return c ? new Set([c.id, ...c.related.map((r) => r.id)]) : null;
  }, [selected, contacts]);
  const q = query.trim().toLowerCase();

  // --- pointer handling: drag nodes, pan background, wheel/pinch zoom ---
  const toGraph = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  };
  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    setView((v) => {
      const k = Math.min(4, Math.max(0.2, v.k * factor));
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    });
  };

  const gesture = useRef<{
    kind: "node" | "pan";
    node?: Node;
    startX: number;
    startY: number;
    moved: boolean;
    view: View;
  } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent, node?: Node) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
      gesture.current = null;
      return;
    }
    gesture.current = { kind: node ? "node" : "pan", node, startX: e.clientX, startY: e.clientY, moved: false, view };
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
    if (g.kind === "pan") setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
    else if (g.node) {
      const p = toGraph(e.clientX, e.clientY);
      g.node.fx = p.x;
      g.node.fy = p.y;
      simRef.current?.alphaTarget(0.3).restart();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "node" && g.node) {
      if (g.moved) {
        g.node.fx = null;
        g.node.fy = null;
        simRef.current?.alphaTarget(0);
      } else setSelected(selected === g.node.id ? null : g.node.id);
    } else if (!g.moved) setSelected(null);
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
  const selectedContact = contacts.find((c) => c.id === selected);
  const isolatedCount = contacts.filter((c) => c.related.length === 0).length;

  const nodeState = (n: Node) => {
    if (neighbors) return n.id === selected ? "selected" : neighbors.has(n.id) ? "neighbor" : "dim";
    if (q) return matches(n.contact, q) ? "match" : "dim";
    return "";
  };

  return (
    <div className="network">
      <svg
        ref={svgRef}
        className="network-svg"
        role="img"
        aria-label="Network of contacts and their connections"
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          <g className="links">
            {links.map((l, i) => {
              const s = l.source as Node;
              const t = l.target as Node;
              if (s.x == null || t.x == null) return null;
              const active = neighbors && (s.id === selected || t.id === selected);
              return (
                <line
                  key={i}
                  x1={s.x}
                  y1={s.y}
                  x2={t.x}
                  y2={t.y}
                  className={active ? "link active" : neighbors || q ? "link dim" : "link"}
                  strokeWidth={(active ? 2.5 : 1.5) / Math.max(view.k, 0.6)}
                />
              );
            })}
          </g>
          <g className="nodes">
            {nodes.map((n) => {
              if (n.x == null) return null;
              const state = nodeState(n);
              return (
                <g
                  key={n.id}
                  className={`node ${n.contact.in_network ? "in" : "out"} ${state}`}
                  transform={`translate(${n.x},${n.y})`}
                  onPointerDown={(e) => onPointerDown(e, n)}
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
        {isolatedCount > 0 && (
          <label className="menu-check">
            <input type="checkbox" checked={showIsolated} onChange={(e) => setShowIsolated(e.target.checked)} />
            Show {isolatedCount} people with no connections
          </label>
        )}
        {!selectedContact && <span className="muted">Click a person to highlight their connections. Drag to move, scroll to zoom.</span>}
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
            {[selectedContact.role, currentSchool(selectedContact)].filter(Boolean).join(" · ") || "No details yet"}
            {!selectedContact.in_network && <span className="outside-badge">outside network</span>}
          </div>
          {selectedContact.related.length > 0 ? (
            <div className="chips network-connections">
              {selectedContact.related.map((r) => (
                <button key={r.id} className={`tag person ${r.in_network ? "" : "outside"}`} title={r.note || undefined} onClick={() => setSelected(r.id)}>
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

      {hover && (
        <div className="network-tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <strong>{hover.node.contact.name}</strong>
          <div>{[hover.node.contact.role, currentSchool(hover.node.contact)].filter(Boolean).join(" · ")}</div>
          <div className="muted">
            {hover.node.degree} connection{hover.node.degree === 1 ? "" : "s"}
            {hover.node.contact.in_network ? "" : " · outside your network"}
          </div>
        </div>
      )}

      {nodes.length === 0 && <p className="empty network-empty">No connections yet. Link people from a contact's “Related to” field.</p>}
    </div>
  );

  function zoomCenter(factor: number) {
    const rect = svgRef.current!.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }
}

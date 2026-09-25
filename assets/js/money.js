import { D } from "./data.js";

// "Who pays whom": each diagram in data/money/flows.json drawn as a flow (Sankey) diagram.
// Band widths are proportional to money; routes whose size is not published are dashed lines.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NODE_W = 12, TOP = 34, MIN_SLOT = 16, GAP = 5, BODY_H = 560;
let onSelect = () => {};
let current = null;   // { diagram, view, selected }

export function initMoney(opts) { onSelect = opts.onSelect; }

// Nodes and links of a diagram, with the chosen spending view merged in
export function build(diagramId, viewKey) {
  const d = D.money.diagrams[diagramId];
  const view = d.views ? d.views[viewKey] || Object.values(d.views)[0] : null;
  const nodes = new Map();
  for (const n of [...d.nodes, ...(view?.nodes || [])]) if (!nodes.has(n.id)) nodes.set(n.id, { ...n, ins: [], outs: [] });
  const links = [...d.links, ...(view?.links || [])].filter((l) => nodes.has(l.from) && nodes.has(l.to));
  for (const l of links) { nodes.get(l.from).outs.push(l); nodes.get(l.to).ins.push(l); }
  const sum = (ls) => ls.reduce((a, l) => a + (l.value || 0), 0);
  for (const n of nodes.values()) n.value = Math.max(sum(n.ins), sum(n.outs));
  // everything flowing into the government column (the middle one)
  const total = sum(links.filter((l) => nodes.get(l.to).col === 2 && nodes.get(l.to).group === "gov"));
  return { d, view, nodes, links, total };
}

export function fmt(v, unit, short = false) {
  if (v == null) return "size not published";
  if (unit === "₹ crore") {
    const cr = short ? "cr" : "crore";
    return v >= 100000 ? `₹${(v / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} lakh ${cr}`
      : `₹${Math.round(v).toLocaleString("en-IN")} ${cr}`;
  }
  if (unit === "% of revenue receipts") return `${v}%`;
  return String(v);
}

const colour = (group) => D.money.groups[group]?.color || "#777";

export function renderMoney(state) {
  current = state;
  const svg = document.getElementById("money");
  const { d, nodes, links } = build(state.diagram, state.view);
  const cols = Math.max(...[...nodes.values()].map((n) => n.col)) + 1;
  const W = Math.max(svg.parentElement.clientWidth - 24, 1180);
  // the last gap holds two columns of labels (spending and recipients), so it gets more room
  const weights = Array.from({ length: cols - 1 }, (_, i) => (i === cols - 2 ? 1.6 : 1));
  const unit = (W - 16 - NODE_W) / weights.reduce((a, b) => a + b, 0);
  const colX = (c) => 8 + weights.slice(0, c).reduce((a, b) => a + b, 0) * unit;
  const gapAfter = (c) => (weights[Math.min(c, cols - 2)] || 1) * unit;

  // vertical scale: the fullest column fills BODY_H
  const byCol = Array.from({ length: cols }, () => []);
  for (const n of nodes.values()) byCol[n.col].push(n);
  const maxCol = Math.max(...byCol.map((c) => c.reduce((a, n) => a + n.value, 0)), 1);
  const k = BODY_H / maxCol;
  let H = 0;
  for (const col of byCol) {
    let y = TOP;
    for (const n of col) {
      n.h = n.value ? Math.max(n.value * k, 2) : 8;
      n.x = colX(n.col); n.y = y;
      y += Math.max(n.h, MIN_SLOT) + GAP;
    }
    H = Math.max(H, y);
  }
  H += 16;

  // stack bands on each node, ordered by the other end's position to reduce crossings
  for (const n of nodes.values()) {
    let o = 0;
    for (const l of [...n.outs].sort((a, b) => nodes.get(a.to).y - nodes.get(b.to).y)) { l.w = l.value ? Math.max(l.value * k, 1) : 0; l.sy = n.y + o + l.w / 2; o += l.w; }
    let i = 0;
    for (const l of [...n.ins].sort((a, b) => nodes.get(a.from).y - nodes.get(b.from).y)) { l.ty = n.y + i + (l.value ? Math.max(l.value * k, 1) : 0) / 2; i += l.value ? Math.max(l.value * k, 1) : 0; }
  }

  const sel = state.selected && nodes.has(state.selected) ? state.selected : null;
  const near = new Set(sel ? [sel, ...nodes.get(sel).ins.map((l) => l.from), ...nodes.get(sel).outs.map((l) => l.to)] : []);
  let out = d.columns.map((c, i) => `<text class="col-label" x="${colX(i) + (i === cols - 1 ? NODE_W : 0)}" y="16" text-anchor="${i === cols - 1 ? "end" : "start"}">${esc(c)}</text>`).join("");

  let bands = "", dashed = "";
  for (const l of links) {
    const a = nodes.get(l.from), b = nodes.get(l.to);
    const hot = sel && (l.from === sel || l.to === sel);
    const cls = `${sel ? (hot ? " hot" : " cold") : ""}`;
    const tip = `${a.label} → ${b.label}: ${fmt(l.value, d.unit)}${l.note ? `. ${l.note}` : ""}`;
    const x0 = a.x + NODE_W, x1 = b.x, m = (x0 + x1) / 2;
    if (l.value) {
      const c = colour(a.group === "gov" || a.group === "payer" ? b.group : a.group);
      bands += `<path class="band${cls}" d="M${x0},${l.sy} C${m},${l.sy} ${m},${l.ty} ${x1},${l.ty}" stroke="${c}" stroke-width="${l.w}"><title>${esc(tip)}</title></path>`;
    } else {
      const y0 = a.y + a.h / 2, y1 = b.y + b.h / 2;
      dashed += `<path class="band dashed${cls}" d="M${x0},${y0} C${m},${y0} ${m},${y1} ${x1},${y1}"><title>${esc(tip)}</title></path>`;
    }
  }
  out += bands + dashed;

  for (const n of nodes.values()) {
    const last = n.col === cols - 1;
    const cls = `mnode${n.value ? "" : " unsized"}${sel ? (n.id === sel ? " sel" : near.has(n.id) ? "" : " dim") : ""}`;
    const val = n.value ? fmt(n.value, d.unit, true) : "";
    out += `<g class="${cls}" data-id="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(n.label)}${val ? `, ${esc(val)}` : ""}">
      <title>${esc(n.label)}${val ? ` · ${esc(val)}` : ""}</title>
      <rect x="${n.x}" y="${n.y}" width="${NODE_W}" height="${n.h}" fill="${n.value ? colour(n.group) : "none"}" stroke="${colour(n.group)}"/>
      <text x="${last ? n.x - 6 : n.x + NODE_W + 6}" y="${n.y + Math.max(n.h, 9) / 2 + 4}" text-anchor="${last ? "end" : "start"}"><tspan class="l">${esc(n.label)}</tspan>${val ? `<tspan class="v"> ${esc(val)}</tspan>` : ""}</text></g>`;
  }
  svg.setAttribute("width", W); svg.setAttribute("height", H); svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = out;
  // Labels share the space between columns with the next column's labels (the last column's
  // labels run leftwards into the same gap), so shorten any label that would run into them.
  svg.querySelectorAll(".mnode").forEach((g) => {
    const t = g.querySelector("text");
    const shared = nodes.get(g.dataset.id).col >= cols - 2;
    const room = (gapAfter(Math.min(nodes.get(g.dataset.id).col, cols - 2)) - NODE_W) * (shared ? 0.5 : 1) - 10;
    const l = t.querySelector(".l");
    let s = l.textContent;
    while (t.getComputedTextLength() > room && s.length > 8) { s = s.slice(0, -2); l.textContent = `${s.trimEnd()}…`; }
  });
  svg.querySelectorAll(".mnode").forEach((g) => {
    const go = () => onSelect(g.dataset.id === sel ? null : g.dataset.id);
    g.addEventListener("click", go);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

// ---------------------------------------------------------------- side panel
const srcLinks = (list) => list.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.publisher)}</a>`).join(", ");

export function moneyPanel(diagramId, viewKey, id) {
  const { d, view, nodes, total } = build(diagramId, viewKey);
  const n = nodes.get(id);
  if (!n) return "";
  const share = n.value && total && n.col !== 2 ? ` <span class="muted">(${(n.value / total * 100).toFixed(1)}% of ${esc(d.total_label || "the total")})</span>` : "";
  const flowList = (ls, end) => ls.map((l) => {
    const o = nodes.get(l[end]);
    return `<li><button class="linkish" data-money-node="${esc(o.id)}">${esc(o.label)}</button> <span class="num">${esc(fmt(l.value, d.unit))}</span>${l.note ? `<br><span class="muted">${esc(l.note)}</span>` : ""}</li>`;
  }).join("");
  const taxes = (n.taxes || []).map((t) => D.taxes.byId.get(t)).filter(Boolean);
  const offices = (n.offices || []).filter((o) => D.nodes.has(o));
  const when = [d.year, d.basis].filter(Boolean).join(", ");
  return `<h2>${esc(n.label)}</h2>
    <p class="crumbs">${esc(D.money.groups[n.group]?.label || "")} · ${esc(d.title)}${view ? `, ${esc(view.label.toLowerCase())}` : ""}${when ? ` · ${esc(when)}` : ""}</p>
    ${n.value ? `<p class="money-value">${esc(fmt(n.value, d.unit))}${share}</p>` : `<p class="muted">The size of this flow is not published as a single figure.</p>`}
    ${n.desc ? `<p>${esc(n.desc)}</p>` : ""}
    ${n.fact ? `<p class="source-warning">${esc(n.fact)}</p>` : ""}
    ${n.link ? `<p><button class="linkish" data-money-diagram="${esc(n.link.diagram)}">Open the ${esc(D.money.diagrams[n.link.diagram].title)} diagram</button></p>` : ""}
    ${n.ins.length ? `<h3>Money comes from</h3><ul class="money-list">${flowList(n.ins, "from")}</ul>` : ""}
    ${n.outs.length ? `<h3>Money goes to</h3><ul class="money-list">${flowList(n.outs, "to")}</ul>` : ""}
    ${taxes.length ? `<h3>Taxes and levies</h3>${taxes.map((t) => `<p><strong>${esc(t.name)}.</strong> ${esc(t.who_pays)} <span class="muted">${esc(t.basis)}</span></p>`).join("")}` : ""}
    ${offices.length ? `<h3>Who decides</h3><p>${offices.map((o) => `<button class="linkish" data-node="${esc(o)}">${esc(D.nodes.get(o).title)}</button>`).join(", ")}</p>` : ""}
    <p class="muted">${esc(d.note)}</p>
    <p class="muted">Sources: ${srcLinks([...d.sources, ...(n.sources || [])])}</p>`;
}

// Where an office appears in the money diagrams (for the office panel)
export function moneyRefsFor(officeId) {
  const out = [];
  for (const [did, d] of Object.entries(D.money.diagrams)) {
    const views = d.views ? Object.entries(d.views) : [[null, null]];
    const seen = new Set();
    for (const [vk, v] of views) {
      for (const n of [...d.nodes, ...(v?.nodes || [])]) {
        if ((n.offices || []).includes(officeId) && !seen.has(n.id)) { seen.add(n.id); out.push({ diagram: did, view: vk, node: n.id, label: n.label, title: d.title }); }
      }
    }
  }
  return out;
}

// "union:h.income" -> the diagram, a view that contains it, and the node
export function resolveRef(ref) {
  const [diagram, node] = ref.split(":");
  const d = D.money.diagrams[diagram];
  if (!d) return null;
  if (d.nodes.some((n) => n.id === node)) return { diagram, view: null, node };
  for (const [vk, v] of Object.entries(d.views || {})) if (v.nodes.some((n) => n.id === node)) return { diagram, view: vk, node };
  return null;
}

// ---------------------------------------------------------------- every tax and levy
export function taxesHTML() {
  const T = D.taxes;
  const levels = { union: "Union", state: "State", local: "Local" };
  return Object.entries(T.categories).map(([cat, label]) => {
    const items = T.taxes.filter((t) => t.category === cat);
    if (!items.length) return "";
    return `<h4>${esc(label)}</h4>` + items.map((t) => `<details class="tax">
      <summary>${esc(t.name)} ${t.level.map((l) => `<span class="pill level">${levels[l]}</span>`).join(" ")}</summary>
      <dl>
        <dt>Who pays</dt><dd>${esc(t.who_pays)}</dd>
        <dt>Who bears it</dt><dd>${esc(t.who_bears)}</dd>
        <dt>Collected by</dt><dd>${esc(t.collected_by)}</dd>
        <dt>Where it goes</dt><dd>${esc(t.shared_with_states)}</dd>
        <dt>Legal basis</dt><dd>${esc(t.basis)}</dd>
      </dl>
      ${t.node ? `<button class="linkish" data-money-ref="${esc(t.node)}">Show in the diagram</button>` : `<p class="muted">Outside the government budgets shown above.</p>`}
    </details>`).join("");
  }).join("");
}

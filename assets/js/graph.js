import { D, stepsFromBallot } from "./data.js";
import { glyphInner } from "./glyphs.js";

const NS = "http://www.w3.org/2000/svg";
const BANDS = [
  ["national", "Union"], ["state", "State"], ["district", "District"], ["local", "Below the district"],
];
const REL_UP = ["by", "advice", "confidence", "members"];
let selected = null;
let onSelect = () => {};
let branchesOn = new Set();
let pos = new Map();

export function initGraph(opts) {
  onSelect = opts.onSelect;
  branchesOn = opts.branchesOn;
}

function parents(n) {
  const s = n.selection || {};
  const out = [];
  for (const rel of [...REL_UP, "consult"]) for (const p of s[rel] || []) out.push({ id: p, rel });
  return out;
}

// All nodes upstream (who chose this, and who chose them...) and one level downstream
function neighbourhood(id) {
  const up = new Set([id]), upEdges = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    const n = D.nodes.get(cur);
    if (!n) continue;
    for (const { id: p, rel } of parents(n)) {
      if (rel === "consult") continue;
      upEdges.add(`${p}>${cur}`);
      if (!up.has(p)) { up.add(p); stack.push(p); }
    }
  }
  const down = new Set(), downEdges = new Set();
  for (const n of D.offices.nodes) {
    for (const { id: p, rel } of parents(n)) {
      if (p === id && rel !== "members") { down.add(n.id); downEdges.add(`${id}>${n.id}`); }
    }
  }
  return { up, upEdges, down, downEdges };
}

export function renderGraph(filterSet) {
  if (filterSet) branchesOn = filterSet;
  const svg = document.getElementById("graph");
  const wrap = svg.parentElement;
  const W = Math.max(wrap.clientWidth - 24, 760);
  const left = 130, colW = 182, rowH = 24, bandPad = 18;
  const cols = Math.max(4, Math.floor((W - left - 10) / colW));
  const order = Object.keys(D.branches);
  const visible = (n) => n.id === "voters" || branchesOn.has(n.branch);

  pos = new Map();
  let y = 14;
  const bands = [];
  for (const [scope, label] of BANDS) {
    const nodes = D.offices.nodes.filter((n) => n.scope === scope && visible(n))
      .sort((a, b) => (order.indexOf(a.branch) - order.indexOf(b.branch)) || ((stepsFromBallot(a.id) ?? 99) - (stepsFromBallot(b.id) ?? 99)) || a.title.localeCompare(b.title));
    const rows = Math.ceil(nodes.length / cols) || 1;
    const top = y;
    nodes.forEach((n, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      pos.set(n.id, { x: left + c * colW, y: top + bandPad + r * rowH, n });
    });
    y = top + bandPad * 2 + rows * rowH;
    bands.push({ label, top, h: y - top });
    y += 10;
  }
  const H = y + 10;
  svg.setAttribute("width", W); svg.setAttribute("height", H); svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const hl = selected ? neighbourhood(selected) : null;
  let out = "";
  bands.forEach((b, i) => {
    if (i % 2 === 0) out += `<rect class="band" x="0" y="${b.top}" width="${W}" height="${b.h}"/>`;
    out += `<text class="band-label" x="14" y="${b.top + 22}">${b.label}</text>`;
  });
  // edges
  let edges = "";
  for (const { n, x, y: ty } of pos.values()) {
    for (const { id: p, rel } of parents(n)) {
      const s = pos.get(p);
      if (!s) continue;
      const key = `${p}>${n.id}`;
      let cls = `edge ${rel}`;
      if (hl) {
        if (hl.upEdges.has(key)) cls += " up";
        else if (hl.downEdges.has(key)) cls += " down";
      }
      const x1 = s.x + 7, y1 = s.y, x2 = x + 7, y2 = ty;
      const dy = Math.max(30, Math.abs(y2 - y1) * 0.5);
      edges += `<path class="${cls}" d="M${x1},${y1} C${x1},${y1 + (y2 >= y1 ? dy : -dy)} ${x2},${y2 - (y2 >= y1 ? dy : -dy)} ${x2},${y2}"/>`;
    }
  }
  out += edges;
  let nodes = "";
  for (const [id, { x, y: ny, n }] of pos) {
    const col = D.branches[n.branch]?.color || "#777";
    const label = n.title.length > 27 ? n.title.slice(0, 26) + "…" : n.title;
    let cls = "node";
    if (hl) cls += (id === selected ? " sel" : (hl.up.has(id) || hl.down.has(id)) ? "" : " dim");
    nodes += `<g class="${cls}" data-id="${id}" tabindex="0" role="button" aria-label="${n.title}" transform="translate(${x},${ny - 8})">
      <title>${n.title}</title>
      <g transform="scale(0.95)">${glyphInner(n.selection.method, col)}</g>
      <text x="19" y="12">${label}</text></g>`;
  }
  svg.innerHTML = out + nodes;
  // put highlighted edges on top of plain ones
  svg.querySelectorAll(".edge.up, .edge.down").forEach((e) => svg.insertBefore(e, svg.querySelector(".node")));

  svg.querySelectorAll(".node").forEach((g) => {
    const go = () => select(g.dataset.id);
    g.addEventListener("click", go);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

// ------------------------------------------------------------ lineage
// A left-to-right reading of how one office is filled: everyone upstream
// (by shortest path), the office itself, then the posts it fills.
function wrapText(t, max = 25) {
  const words = t.split(" "), lines = [""];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if ((cur + " " + w).trim().length > max && cur) lines.push(w); else lines[lines.length - 1] = (cur + " " + w).trim();
  }
  if (lines.length > 2) { lines.length = 2; lines[1] = lines[1].slice(0, max - 1) + "…"; }
  return lines;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderLineage(id) {
  const box = document.querySelector(".lineage");
  const n0 = id && D.nodes.get(id);
  if (!n0) { box.hidden = true; return; }
  box.hidden = false;
  const steps = stepsFromBallot(id);
  box.querySelector("h3").textContent = `How the ${n0.title} is chosen` + (steps != null ? ` · ${steps} step${steps === 1 ? "" : "s"} from a ballot` : "");
  // shortest-path depth upstream
  const depth = new Map([[id, 0]]);
  const q = [id];
  // Follow only the lines of choice (chooses, recommends, made up of) upstream;
  // confidence and consultation are shown for the selected office alone.
  const FOLLOW = new Set(["by", "advice", "members"]);
  while (q.length) {
    const cur = q.shift();
    for (const { id: p, rel } of parents(D.nodes.get(cur) || {})) {
      if (cur !== id && !FOLLOW.has(rel)) continue;
      if (!D.nodes.has(p) || depth.has(p)) continue;
      depth.set(p, depth.get(cur) + 1); q.push(p);
    }
  }
  const maxD = Math.max(...depth.values());
  const kids = [];
  for (const n of D.offices.nodes) for (const { id: p, rel } of parents(n)) if (p === id && rel !== "consult" && !depth.has(n.id)) { kids.push(n.id); break; }
  const cols = [];
  for (const [nid, d] of depth) (cols[maxD - d] ||= []).push(nid);
  if (kids.length) cols.push(kids.slice(0, 14));
  const scopeRank = { national: 0, state: 1, district: 2, local: 3 };
  cols.forEach((c) => c.sort((a, b) => (scopeRank[D.nodes.get(a).scope] - scopeRank[D.nodes.get(b).scope]) || D.nodes.get(a).title.localeCompare(D.nodes.get(b).title)));
  const BW = 180, BH = 40, GX = 50, GY = 10, TOP = 26;
  const P = new Map();
  cols.forEach((c, ci) => c.forEach((nid, ri) => P.set(nid, { x: 8 + ci * (BW + GX), y: TOP + ri * (BH + GY) })));
  const W = 16 + cols.length * (BW + GX) - GX, H = TOP + Math.max(...cols.map((c) => c.length)) * (BH + GY) + 4;
  let out = "";
  cols.forEach((c, ci) => {
    const lbl = ci === maxD ? "This office" : ci > maxD ? `It chooses${kids.length > 14 ? ` (14 of ${kids.length})` : ""}` : ci === 0 ? "Starts here" : "";
    if (lbl) out += `<text class="col-label" x="${8 + ci * (BW + GX)}" y="14">${lbl}</text>`;
  });
  // edges
  for (const [nid, b] of P) {
    const n = D.nodes.get(nid);
    for (const { id: p, rel } of parents(n)) {
      const a = P.get(p);
      if (!a) continue;
      if (kids.includes(nid) && p !== id) continue;
      if (nid !== id && !FOLLOW.has(rel)) continue;
      const x1 = a.x + BW, y1 = a.y + BH / 2, x2 = b.x, y2 = b.y + BH / 2;
      const back = x2 <= x1;
      if (back && !(nid === id || p === id)) continue;   // keep the picture readable
      const d = back
        ? `M${a.x + BW / 2},${a.y + BH} C${a.x + BW / 2},${a.y + BH + 30} ${b.x + BW / 2},${b.y + BH + 30} ${b.x + BW / 2},${b.y + BH}`
        : `M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2 - 4},${y2}`;
      out += `<path class="ledge ${rel}${kids.includes(nid) ? " out" : ""}" d="${d}" marker-end="url(#lin-arrow)"/>`;
    }
  }
  for (const [nid, b] of P) {
    const n = D.nodes.get(nid);
    const col = D.branches[n.branch]?.color || "#777";
    const lines = wrapText(n.title);
    const meta = D.offices.methods?.[n.selection.method]?.label || n.selection.method.replace(/_/g, " ");
    out += `<g class="box${nid === id ? " sel" : ""}" data-id="${nid}" tabindex="0" role="button" aria-label="${esc(n.title)}" transform="translate(${b.x},${b.y})">
      <rect width="${BW}" height="${BH}" rx="5"/><rect width="4" height="${BH}" rx="1" style="fill:${col};stroke:none"/>
      <g transform="translate(9,${lines.length > 1 ? 5 : 9}) scale(0.8)">${glyphInner(n.selection.method, col)}</g>
      ${lines.map((l, i) => `<text x="26" y="${lines.length > 1 ? 15 + i * 13 : 17}">${esc(l)}</text>`).join("")}
      ${lines.length === 1 ? `<text class="meta" x="26" y="31">${esc(meta)}</text>` : ""}
      <title>${esc(n.title)}: ${esc(meta)}</title></g>`;
  }
  const svg = document.getElementById("lineage");
  svg.setAttribute("width", W); svg.setAttribute("height", H + 30); svg.setAttribute("viewBox", `0 0 ${W} ${H + 30}`);
  svg.setAttribute("aria-label", `Diagram of how the ${n0.title} is chosen`);
  svg.innerHTML = `<defs><marker id="lin-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" style="fill:var(--ink-2)"/></marker></defs>` + out;
  const sc = box.querySelector(".lineage-scroll"), me = P.get(id);
  sc.scrollLeft = Math.max(0, me.x + BW + (kids.length ? BW + GX : 0) + 16 - sc.clientWidth);
  svg.querySelectorAll(".box").forEach((g) => {
    const go = () => select(g.dataset.id);
    g.addEventListener("click", go);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

export function select(id, { scroll = false } = {}) {
  selected = id;
  onSelect(id);          // opens the side panel first, so the diagram sizes to the space left
  renderGraph();
  renderLineage(id);
  if (scroll && id && pos.has(id)) {
    const { y } = pos.get(id);
    document.querySelector(".view-graph").scrollTo({ top: 0, behavior: "smooth" });
  }
}

export function clearSelection() { selected = null; renderGraph(); renderLineage(null); }

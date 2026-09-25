import { D, loadCore, loadStateHolders, loadStateEconomy, loadCrime, economyChoropleth, stateOf, isDistrict, isConstituency, constituencyKind, jurName } from "./data.js";
import { initMap, render, restyle, refreshPins, focus, resetView, invalidate, RAMP } from "./map.js";
import { politicalPanel, economicPanel, crimePanel, hoverHTML, nodePanel, ECON_METRICS } from "./panel.js";
import { initGraph, renderGraph, select as selectNode, clearSelection } from "./graph.js";
import { initTimeline, renderTimeline } from "./timeline.js";
import { initMoney, renderMoney, moneyPanel, resolveRef, taxesHTML } from "./money.js";
import { initReport, openReport } from "./report.js";
import { glyph, METHOD_ORDER } from "./glyphs.js";

const S = {
  view: "map", lens: "political", level: "district", geo: "real", selected: null, node: null,
  flow: "union", flowView: "purpose", flowNode: null,
  branches: new Set(), pins: true, econMetric: ECON_METRICS[0].id, crimeMetric: "total_cognizable", crimeYear: null,
};
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const bundles = new Map();
const bundle = (st) => { if (!bundles.has(st)) bundles.set(st, loadStateHolders(st)); return bundles.get(st); };
let crimeData = null, econData = null;

// ---------------------------------------------------------------- URL state
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("view")) S.view = h.get("view");
  if (h.get("lens")) S.lens = h.get("lens");
  if (h.get("level")) S.level = h.get("level");
  if (h.get("geo")) S.geo = h.get("geo");
  if (h.get("sel")) S.selected = h.get("sel");
  if (h.get("office")) S.node = h.get("office");
  if (h.get("flow")) S.flow = h.get("flow");
  if (h.get("by")) S.flowView = h.get("by");
  if (h.get("item")) S.flowNode = h.get("item");
}
function writeHash() {
  const h = new URLSearchParams();
  if (S.view !== "map") h.set("view", S.view);
  if (S.lens !== "political") h.set("lens", S.lens);
  if (S.level !== "district") h.set("level", S.level);
  if (S.geo !== "real") h.set("geo", S.geo);
  if (S.selected) h.set("sel", S.selected);
  if (S.view === "graph" && S.node) h.set("office", S.node);
  if (S.view === "money") {
    if (S.flow !== "union") h.set("flow", S.flow);
    if (S.flow === "union" && S.flowView !== "purpose") h.set("by", S.flowView);
    if (S.flowNode) h.set("item", S.flowNode);
  }
  history.replaceState(null, "", h.toString() ? `#${h}` : location.pathname);
}

// ---------------------------------------------------------------- controls
function buildControls() {
  for (const b of Object.keys(D.branches)) S.branches.add(b);
  const branchItems = (cls) => Object.entries(D.branches).map(([id, b]) =>
    `<li><label class="check"><input type="checkbox" class="${cls}" value="${id}" checked><span class="swatch" style="background:${b.color}"></span>${b.label}</label></li>`).join("");
  $(".controls .branch-list").innerHTML = branchItems("branch-toggle");
  $(".graph-filters").innerHTML = branchItems("graph-branch-toggle").replace(/<\/?li>/g, "");
  $(".method-key").innerHTML = METHOD_ORDER.filter((m) => D.methods[m]).map((m) =>
    `<li>${glyph(m, "var(--ink)", 14)} ${D.methods[m].label}</li>`).join("");

  $("#econ-metric").innerHTML = ECON_METRICS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
  const cats = D.crimeIndex.categories;
  $("#crime-metric").innerHTML = Object.entries(cats).map(([k, v]) => `<option value="${k}" ${k === S.crimeMetric ? "selected" : ""}>${v} per lakh people</option>`).join("");
  const ds = D.crimeIndex.datasets || [];
  $("#crime-year").innerHTML = ds.length ? ds.map((d) => `<option value="${d.file}">${d.year} (${d.source || "NCRB"})</option>`).join("") : `<option value="">No years loaded yet</option>`;
  S.crimeYear = ds[0]?.file || null;

  $$("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $$("[data-lens]").forEach((b) => b.addEventListener("click", () => setLens(b.dataset.lens)));
  $$("[data-level]").forEach((b) => b.addEventListener("click", () => {
    S.level = b.dataset.level;
    if (S.selected && S.level === "state") S.selected = stateOf(S.selected);
    else if (S.selected && S.level === "rajya_sabha") S.selected = `RS/${stateOf(S.selected)}`;
    else if (S.selected && (S.level === "district" && !isDistrict(S.selected))) S.selected = null;
    else if (S.selected && S.level === "lok_sabha" && !S.selected.startsWith("LS/")) S.selected = null;
    else if (S.selected && S.level === "vidhan_sabha" && !S.selected.startsWith("VS/")) S.selected = null;
    sync(); drawMap(); showPanel();
  }));
  $$("[data-geo]").forEach((b) => b.addEventListener("click", () => { S.geo = b.dataset.geo; sync(); drawMap(); }));
  $("[data-home]").addEventListener("click", (e) => { e.preventDefault(); S.selected = null; setView("map"); resetView(); showPanel(); });
  $("[data-report]").addEventListener("click", () => openReport({ where: S.selected || "" }));
  $$(".branch-toggle").forEach((c) => c.addEventListener("change", () => {
    c.checked ? S.branches.add(c.value) : S.branches.delete(c.value);
    $$(".graph-branch-toggle").forEach((g) => { g.checked = S.branches.has(g.value); });
    refreshPins(); showPanel();
  }));
  $$(".graph-branch-toggle").forEach((c) => c.addEventListener("change", () => {
    c.checked ? S.branches.add(c.value) : S.branches.delete(c.value);
    $$(".branch-toggle").forEach((g) => { g.checked = S.branches.has(g.value); });
    renderGraph(S.branches);
  }));
  $("#pins-toggle").addEventListener("change", (e) => { S.pins = e.target.checked; refreshPins(); });
  $("#econ-metric").addEventListener("change", (e) => { S.econMetric = e.target.value; applyLens(); });
  $("#crime-metric").addEventListener("change", (e) => { S.crimeMetric = e.target.value; applyLens(); });
  $("#crime-year").addEventListener("change", (e) => { S.crimeYear = e.target.value; applyLens(); });
  $(".panel-close").addEventListener("click", () => {
    if (S.view === "graph") { S.node = null; showPanel(); clearSelection(); }
    else if (S.view === "money") { S.flowNode = null; showPanel(); drawMoney(); }
    else { S.selected = null; restyle({ selected: null }); showPanel(); }
    writeHash();
  });
  const tog = $(".controls-toggle");
  tog.addEventListener("click", () => {
    const open = $(".controls").classList.toggle("open");
    tog.setAttribute("aria-expanded", open);
  });
  buildSearch();
  $$("[data-flow]").forEach((b) => b.addEventListener("click", () => { S.flow = b.dataset.flow; S.flowNode = null; showPanel(); drawMoney(); }));
  $$("[data-flow-view]").forEach((b) => b.addEventListener("click", () => { S.flowView = b.dataset.flowView; S.flowNode = null; showPanel(); drawMoney(); }));
  $(".tax-list").innerHTML = taxesHTML();
  $(".tax-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-money-ref]");
    if (b) openMoney(resolveRef(b.dataset.moneyRef));
  });
}

// ---------------------------------------------------------------- who pays whom
function drawMoney() {
  const d = D.money.diagrams[S.flow] ? S.flow : "union";
  S.flow = d;
  $$("[data-flow]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.flow === d)));
  $("[data-flow-views]").hidden = !D.money.diagrams[d].views;
  $$("[data-flow-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.flowView === S.flowView)));
  $(".money-note").textContent = D.money.diagrams[d].note;
  renderMoney({ diagram: d, view: S.flowView, selected: S.flowNode });
  writeHash();
}

function openMoney(ref) {
  if (!ref) return;
  S.flow = ref.diagram;
  if (ref.view) S.flowView = ref.view;
  S.flowNode = ref.node;
  if (S.view !== "money") setView("money"); else { showPanel(); drawMoney(); }
  document.querySelector(".view-money").scrollTo({ top: 0, behavior: "smooth" });
}

function sync() {
  $$("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === S.view)));
  $$("[data-lens]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.lens === S.lens)));
  $$("[data-level]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.level === S.level)));
  $$("[data-geo]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.geo === S.geo)));
  $$("[data-view-panel]").forEach((p) => { p.hidden = p.dataset.viewPanel !== S.view; });
  $$("[data-lens-controls]").forEach((p) => { p.hidden = p.dataset.lensControls !== S.lens; });
  const hexHint = $("[data-hint-hex]");
  hexHint.hidden = S.geo !== "hex";
  if (!hexHint.hidden) hexHint.textContent = S.level === "rajya_sabha"
    ? "States drawn from one hexagon per district. Each state's MLAs elect its Rajya Sabha members."
    : `One hexagon per ${{ state: "district, grouped by state", district: "district", lok_sabha: "Lok Sabha constituency", vidhan_sabha: "Vidhan Sabha constituency" }[S.level]}, so each gets equal space.`;
  $(".lenses").hidden = S.view !== "map";
  writeHash();
}

function buildSearch() {
  const input = $("#search-input"), list = $(".search-results");
  const all = [
    ...[...D.states.values()].map((s) => ({ id: s.id, name: s.name, sub: s.type === "state" ? "State" : "Union territory" })),
    ...[...D.districts.values()].map((d) => ({ id: d.id, name: d.name, sub: D.states.get(d.state)?.name })),
    ...[...D.constituencies.values()].filter((c) => !c.id.startsWith("RS/")).map((c) => ({ id: c.id, name: c.name, sub: `${constituencyKind(c.id)}, ${D.states.get(c.st)?.name}`, level: c.id.startsWith("LS/") ? "lok_sabha" : "vidhan_sabha" })),
  ];
  const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, "");
  input.addEventListener("input", () => {
    const q = norm(input.value.trim());
    if (!q) { list.hidden = true; return; }
    const hits = all.filter((x) => norm(x.name).includes(q))
      .sort((a, b) => (norm(a.name).startsWith(q) ? 0 : 1) - (norm(b.name).startsWith(q) ? 0 : 1) || a.name.length - b.name.length).slice(0, 12);
    list.innerHTML = hits.length ? hits.map((h) => `<li><button data-id="${h.id}">${h.name} <small>${h.sub}</small></button></li>`).join("")
      : `<li class="muted" style="padding:5px 8px">No state or district matches “${input.value}”.</li>`;
    list.hidden = false;
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    const id = b.dataset.id;
    const hit = all.find((x) => x.id === id);
    if (hit?.level && S.level !== hit.level) { S.level = hit.level; sync(); drawMap(); }
    else if (isDistrict(id) && S.level !== "district") { S.level = "district"; sync(); drawMap(); }
    list.hidden = true; input.value = "";
    selectJur(id); focus(id);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { list.hidden = true; input.blur(); } });
}

// ---------------------------------------------------------------- lens colouring
function quantiles(vals, k = 5) {
  const s = [...vals].sort((a, b) => a - b);
  return Array.from({ length: k - 1 }, (_, i) => s[Math.floor(((i + 1) / k) * s.length)]);
}
const bin = (v, breaks) => breaks.filter((b) => v >= b).length;

async function applyLens() {
  const legend = $(".legend");
  legend.classList.toggle("intro", S.lens === "political");
  let colorFn = null;
  if (S.lens === "political") {
    const n = D.holderStates.size;
    const touch = matchMedia("(hover: none)").matches;
    const unit = { state: "state", district: "district", lok_sabha: "Lok Sabha constituency", rajya_sabha: "Rajya Sabha region", vidhan_sabha: "Vidhan Sabha constituency" }[S.level];
    legend.innerHTML = `<strong>${touch ? "Tap" : "Hover"} a ${unit} to see who represents or runs it${touch ? "" : "; click for everything"}.</strong>
      Colours only separate neighbouring states. Named office holders are recorded for ${n} of ${D.states.size} states and UTs so far.`;
  } else if (S.lens === "economic") {
    const metric = ECON_METRICS.find((m) => m.id === S.econMetric);
    econData = await economyChoropleth(S.econMetric);
    const vals = [...econData.valueByState.values()];
    const breaks = vals.length ? quantiles(vals) : [];
    colorFn = (id) => { const v = econData.valueByState.get(stateOf(id)); return v == null ? "url(#slc-nodata)" : RAMP[bin(v, breaks)]; };
    legend.innerHTML = `<strong>${metric.label}</strong>` + (vals.length
      ? `<div class="ramp">${RAMP.map((c) => `<span style="background:${c}"></span>`).join("")}</div><div class="ramp-labels"><span>${econData.min}${metric.unit === "%" ? "%" : ""}</span><span>${econData.max}${metric.unit === "%" ? "%" : ""}</span></div>` : "") +
      `<div><span class="nodata"></span>Not compiled yet: ${D.states.size - vals.length} of ${D.states.size} states and UTs</div>`;
  } else {
    crimeData = S.crimeYear ? await loadCrime(S.crimeYear) : null;
    const label = D.crimeIndex.categories[S.crimeMetric];
    const rate = (id) => { const r = crimeData?.values?.[id]; return r && r[S.crimeMetric] != null && r.population ? (r[S.crimeMetric] / r.population) * 1e5 : null; };
    const ids = S.level === "state" || S.level === "rajya_sabha" ? [...D.states.keys()]
      : S.level === "district" ? [...D.districts.keys()]
        : [...D.constituencies.keys()].filter((id) => id.startsWith(S.level === "lok_sabha" ? "LS/" : "VS/"));
    const vals = ids.map(rate).filter((v) => v != null);
    const breaks = vals.length ? quantiles(vals) : [];
    colorFn = (id) => { const v = rate(id); return v == null ? "url(#slc-nodata)" : RAMP[bin(v, breaks)]; };
    legend.innerHTML = `<strong>${label}, per lakh people${crimeData ? `, ${crimeData.year}` : ""}</strong>` + (vals.length
      ? `<div class="ramp">${RAMP.map((c) => `<span style="background:${c}"></span>`).join("")}</div><div class="ramp-labels"><span>${Math.min(...vals).toFixed(1)}</span><span>${Math.max(...vals).toFixed(1)}</span></div>` : "") +
      `<div><span class="nodata"></span>${vals.length ? "No figures" : "No NCRB figures loaded yet"}</div>
       <div class="muted">Registered cases, not all crime that happened.</div>`;
  }
  restyle({ colorFn, lens: S.lens });
  refreshPins();
  if (S.selected) showPanel();
}

function drawMap() {
  render({ geo: S.geo, level: S.level, lens: S.lens, selected: S.selected });
  applyLens();
}

function setLens(l) { S.lens = l; sync(); applyLens(); }

function setView(v) {
  S.view = v; sync();
  if (v === "map") invalidate();
  if (v === "graph") { renderGraph(S.branches); if (S.node) selectNode(S.node, { scroll: true }); }
  if (v === "timeline") renderTimeline();
  showPanel();
  if (v === "money") drawMoney();
}

// ---------------------------------------------------------------- selection, hover, panel
function selectJur(id) {
  if (id && S.level === "state" && isDistrict(id)) id = stateOf(id);
  S.selected = id;
  restyle({ selected: id });
  showPanel();
  writeHash();
}

async function showPanel() {
  const panel = $(".panel"), body = $(".panel-body");
  if (S.view === "timeline" || (S.view === "map" && !S.selected) || (S.view === "graph" && !S.node) || (S.view === "money" && !S.flowNode)) { panel.hidden = true; document.body.classList.remove("panel-open"); return; }
  panel.hidden = false;
  document.body.classList.add("panel-open");
  if (S.view === "graph") { body.innerHTML = nodePanel(S.node); return; }
  if (S.view === "money") { body.innerHTML = moneyPanel(S.flow, S.flowView, S.flowNode); panel.scrollTop = 0; return; }
  const id = S.selected, st = stateOf(id);
  const b = await bundle(st);
  if (id !== S.selected) return;
  if (S.lens === "political") body.innerHTML = politicalPanel(id, b, S.branches);
  else if (S.lens === "economic") body.innerHTML = economicPanel(id, b, await loadStateEconomy(st));
  else body.innerHTML = crimePanel(id, b, crimeData);
  panel.scrollTop = 0;
}

function wirePanel() {
  $(".panel").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.hasAttribute("data-toggle")) {
      const open = t.getAttribute("aria-expanded") === "true";
      t.setAttribute("aria-expanded", String(!open));
      document.getElementById(t.getAttribute("aria-controls")).hidden = open;
    } else if (t.dataset.node || t.dataset.graphNode) {
      S.node = t.dataset.node || t.dataset.graphNode;
      setView("graph");
    } else if (t.dataset.select) {
      if (S.level !== "state" && !isDistrict(t.dataset.select)) { /* keep district boundaries, select the state */ }
      selectJur(t.dataset.select); focus(t.dataset.select);
    } else if (t.dataset.moneyNode) {
      openMoney({ diagram: t.dataset.moneyDiagram || S.flow, view: t.dataset.moneyView || null, node: t.dataset.moneyNode });
    } else if (t.dataset.moneyDiagram) {
      S.flow = t.dataset.moneyDiagram; S.flowNode = null; showPanel(); drawMoney();
    } else if (t.dataset.reportOffice) {
      openReport({ office: t.dataset.reportOffice, where: t.dataset.reportWhere });
    }
  });
}

const card = () => $(".hovercard");
let hoverToken = 0;
async function onHover(id, pt) {
  const c = card();
  if (!id) { c.hidden = true; return; }
  const token = ++hoverToken;
  const place = () => {
    const mapEl = $("#map").getBoundingClientRect();
    const w = c.offsetWidth || 240, h = c.offsetHeight || 120;
    let x = pt.x + 18, y = pt.y + 18;
    if (x + w > mapEl.width - 8) x = pt.x - w - 18;
    if (y + h > mapEl.height - 8) y = pt.y - h - 18;
    c.style.left = `${x}px`; c.style.top = `${y}px`;
  };
  let extra = null;
  if (S.lens === "economic") {
    const m = ECON_METRICS.find((x) => x.id === S.econMetric);
    const v = econData?.valueByState.get(stateOf(id));
    extra = { label: m.label, value: v == null ? null : `${m.unit === "₹" ? "₹" : ""}${v}${m.unit === "%" ? "%" : ""}` };
  } else if (S.lens === "crime") {
    const r = crimeData?.values?.[id];
    extra = { label: `${D.crimeIndex.categories[S.crimeMetric]} per lakh`, value: r && r[S.crimeMetric] != null && r.population ? (r[S.crimeMetric] / r.population * 1e5).toFixed(1) : null };
  }
  const b = bundles.has(stateOf(id)) ? await bundle(stateOf(id)) : null;
  if (token !== hoverToken) return;
  c.innerHTML = hoverHTML(id, b, S.lens, extra);
  c.hidden = false; place();
  if (!b) {
    const fresh = await bundle(stateOf(id));
    if (token !== hoverToken) return;
    c.innerHTML = hoverHTML(id, fresh, S.lens, extra); place();
  }
}

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    await loadCore();
  } catch (e) {
    document.querySelector("main").innerHTML = `<div class="empty-state" style="margin:40px auto;max-width:560px"><p><strong>The map data didn't load.</strong> ${e.message}.</p><p>If you opened index.html directly from disk, run a local server instead: <code>python3 -m http.server</code> in the repository folder, then visit http://localhost:8000.</p></div>`;
    return;
  }
  readHash();
  buildControls();
  wirePanel();
  initMap({ onHover, onSelect: selectJur, branchesOn: () => S.branches, pinsVisible: () => S.pins });
  initGraph({ onSelect: (id) => { S.node = id; showPanel(); writeHash(); }, branchesOn: S.branches });
  initTimeline();
  // the panel changes the width available to the diagram, so open or close it before drawing
  initMoney({ onSelect: (id) => { S.flowNode = id; showPanel(); drawMoney(); } });
  initReport();
  sync();
  drawMap();
  if (S.view !== "map") setView(S.view);
  if (S.selected) { showPanel(); setTimeout(() => focus(S.selected), 50); }
  window.addEventListener("resize", () => { if (S.view === "graph") renderGraph(); if (S.view === "money") drawMoney(); });
}
boot();

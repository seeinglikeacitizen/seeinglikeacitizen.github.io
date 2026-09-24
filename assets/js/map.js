/* global L, topojson */
import { D, stateOf, isDistrict } from "./data.js";

const SQ3 = Math.sqrt(3);
const TINTS_LIGHT = ["#F1F2EA", "#E7EDEA", "#F0ECE3", "#E9EAF1", "#EDEFE4"];
const TINTS_DARK = ["#2A3945", "#26343F", "#2E3B44", "#29353F", "#2C3A40"];
export const RAMP = ["#EFEAF7", "#D6CBEB", "#B7A5DA", "#8E76C0", "#5A3E96"];

const dark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

let map = null;
let layers = {};
let byId = new Map();          // jurisdiction id -> Leaflet layer
let stateTint = new Map();
let opts = null;               // callbacks from app.js
let current = { geo: "real", level: "district", lens: "political", selected: null, colorFn: null };
let hoverId = null;

export function initMap(options) {
  opts = options;
  colourStates();
}

// Greedy colouring so neighbouring states never share a tint
function colourStates() {
  const geoms = D.topo.objects.states.geometries;
  const nb = topojson.neighbors(geoms);
  const order = geoms.map((g, i) => i).sort((a, b) => nb[b].length - nb[a].length);
  const pick = new Array(geoms.length).fill(-1);
  for (const i of order) {
    const used = new Set(nb[i].map((j) => pick[j]));
    let c = 0; while (used.has(c)) c++;
    pick[i] = c % TINTS_LIGHT.length;
  }
  geoms.forEach((g, i) => stateTint.set(g.properties.st, pick[i]));
}

function tintFor(stateId) {
  const pal = dark() ? TINTS_DARK : TINTS_LIGHT;
  return pal[stateTint.get(stateId) || 0];
}

export function render(state) {
  const rebuild = !map || state.geo !== current.geo;
  current = { ...current, ...state };
  if (rebuild) buildMap();
  else drawLayers();
}

function buildMap() {
  if (map) { map.remove(); map = null; }
  const el = document.getElementById("map");
  if (current.geo === "hex") {
    map = L.map(el, { crs: L.CRS.Simple, zoomSnap: 0.25, minZoom: 1, maxZoom: 7, attributionControl: true, zoomControl: true });
  } else {
    map = L.map(el, { zoomSnap: 0.25, minZoom: 4, maxZoom: 11, renderer: L.svg({ padding: 0.5 }), attributionControl: true });
    map.setMaxBounds([[2, 60], [41, 104]]);
  }
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution(current.geo === "hex"
    ? "Schematic: one hexagon per district"
    : 'Boundaries: <a href="https://github.com/datta07/INDIAN-SHAPEFILES">datta07/INDIAN-SHAPEFILES</a>');
  map.zoomControl.setPosition("bottomright");
  // Leaflet's renderers need a view before any vector layer is added
  if (current.geo === "hex") {
    const t = D.hex.tiles, c = t.map(hexCenter);
    const lat = c.reduce((a, p) => a + p[0], 0) / c.length, lng = c.reduce((a, p) => a + p[1], 0) / c.length;
    map.setView([lat, lng], 2, { animate: false });
  } else map.setView([22.5, 82.5], 4.5, { animate: false });
  addPatterns();
  drawLayers();
  fitIndia();
  map.on("click", (e) => { if (!e.originalEvent._slcHit) opts.onSelect(null); });
  map.on("zoomend", () => updateLabels());
  map.on("moveend", () => { if (current.geo === "real" && current.level === "district" && map.getZoom() >= 6.5) updateLabels(); });
}

const wide = () => window.innerWidth > 860;
function fitIndia() {
  if (!map) return;
  const b = layers.base ? layers.base.getBounds() : null;
  if (b && b.isValid()) map.fitBounds(b, wide() ? { paddingTopLeft: [280, 16], paddingBottomRight: [16, 16] } : { paddingTopLeft: [8, 8], paddingBottomRight: [8, 90] });
}

function addPatterns() {
  // Hatch patterns for "no data yet" and for disputed slivers, injected into Leaflet's SVG
  map.once("layeradd", () => {
    const root = map.getPanes().overlayPane.querySelector("svg");
    if (!root || root.querySelector("#slc-nodata")) return;
    const ns = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(ns, "defs");
    defs.innerHTML = `
      <pattern id="slc-nodata" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="${css("--paper")}"/><line x1="0" y1="0" x2="0" y2="6" stroke="${css("--rule")}" stroke-width="1.6"/>
      </pattern>
      <pattern id="slc-disputed" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
        <rect width="5" height="5" fill="${css("--sea")}"/><line x1="0" y1="0" x2="0" y2="5" stroke="${css("--ink-3")}" stroke-width="1.2"/>
      </pattern>`;
    root.insertBefore(defs, root.firstChild);
  });
}

// ---------------------------------------------------------------- geometry
function hexCenter(t) { return [1.5 * t.r, SQ3 * (t.q + t.r / 2)]; } // [lat(y), lng(x)]
function hexRing(t) {
  const [y, x] = hexCenter(t);
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (30 + 60 * i);
    pts.push([y + Math.sin(a), x + Math.cos(a)]);
  }
  return pts;
}

function hexStateBorders() {
  const key = (lat, lng) => `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const at = new Map();
  for (const t of D.hex.tiles) { const c = hexCenter(t); at.set(key(c[0], c[1]), t); }
  const segs = [];
  for (const t of D.hex.tiles) {
    const ring = hexRing(t), c = hexCenter(t);
    for (let i = 0; i < 6; i++) {
      const a = ring[i], b = ring[(i + 1) % 6];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const nb = at.get(key(2 * m[0] - c[0], 2 * m[1] - c[1]));
      if (!nb || nb.st !== t.st) segs.push([a, b]);
    }
  }
  return segs;
}

// ---------------------------------------------------------------- layers
function styleFor(id) {
  const sel = current.selected;
  const isSel = sel && (sel === id || (current.level === "state" && stateOf(sel) === id));
  const fill = current.colorFn ? current.colorFn(id) : tintFor(stateOf(id));
  const districtLevel = isDistrict(id);
  return {
    color: isSel ? css("--stamp") : (districtLevel ? css("--rule") : css("--ink-3")),
    weight: isSel ? 2.6 : (districtLevel ? 0.6 : 0.9),
    fillColor: fill,
    fillOpacity: 1,
    opacity: 1,
    className: "slc-shape",
  };
}

function bindShape(layer, id) {
  byId.set(id, layer);
  layer.on("mouseover", (e) => {
    hoverId = id;
    layer.bringToFront();
    if (layers.borders) layers.borders.bringToFront();
    layer.getElement()?.classList.add("slc-lift");
    opts.onHover(id, e.containerPoint);
  });
  layer.on("mousemove", (e) => opts.onHover(id, e.containerPoint));
  layer.on("mouseout", () => {
    layer.getElement()?.classList.remove("slc-lift");
    if (hoverId === id) { hoverId = null; opts.onHover(null); }
  });
  layer.on("click", (e) => { e.originalEvent._slcHit = true; opts.onSelect(id); });
}

function drawLayers() {
  for (const k of Object.keys(layers)) layers[k] && map.removeLayer(layers[k]);
  layers = {}; byId = new Map();
  if (current.geo === "hex") drawHex(); else drawReal();
  drawPins();
  updateLabels();
}

function drawReal() {
  const topo = D.topo;
  if (current.level === "district") {
    const fc = topojson.feature(topo, topo.objects.districts);
    layers.base = L.geoJSON(fc, {
      style: (f) => styleFor(f.properties.id),
      onEachFeature: (f, layer) => bindShape(layer, f.properties.id),
    }).addTo(map);
    const mesh = topojson.mesh(topo, topo.objects.states, (a, b) => a !== b);
    layers.borders = L.geoJSON(mesh, { style: { color: css("--ink-2"), weight: 1.3, opacity: 0.9 }, interactive: false }).addTo(map);
  } else {
    const fc = topojson.feature(topo, topo.objects.states);
    layers.base = L.geoJSON(fc, {
      style: (f) => styleFor(f.properties.st),
      onEachFeature: (f, layer) => bindShape(layer, f.properties.st),
    }).addTo(map);
  }
  const outline = topojson.mesh(topo, topo.objects.states, (a, b) => a === b);
  layers.outline = L.geoJSON(outline, { style: { color: css("--ink"), weight: 1.4 }, interactive: false }).addTo(map);
  if (topo.objects.disputed) {
    layers.disputed = L.geoJSON(topojson.feature(topo, topo.objects.disputed), {
      style: { color: css("--ink-3"), weight: 0.5, fillColor: "url(#slc-disputed)", fillOpacity: 1 },
      onEachFeature: (f, layer) => layer.bindTooltip(`Boundary unresolved in source data: ${f.properties.note || ""}`, { sticky: true }),
    }).addTo(map);
  }
}

function drawHex() {
  const group = L.featureGroup();
  if (current.level === "district") {
    for (const t of D.hex.tiles) {
      const poly = L.polygon(hexRing(t), styleFor(t.id));
      bindShape(poly, t.id);
      group.addLayer(poly);
    }
  } else {
    const byState = new Map();
    for (const t of D.hex.tiles) {
      if (!byState.has(t.st)) byState.set(t.st, []);
      byState.get(t.st).push([hexRing(t)]);
    }
    for (const [st, rings] of byState) {
      const poly = L.polygon(rings, { ...styleFor(st), weight: 0, stroke: false });
      bindShape(poly, st);
      group.addLayer(poly);
    }
  }
  layers.base = group.addTo(map);
  layers.borders = L.featureGroup(hexStateBorders().map((s) => L.polyline(s, { color: css("--ink"), weight: 1.6, interactive: false }))).addTo(map);
}

function drawPins() {
  if (current.geo === "hex" || current.lens !== "political" || !opts.pinsVisible()) return;
  const on = opts.branchesOn();
  const g = L.layerGroup();
  for (const p of D.institutions) {
    if (!on.has(p.branch)) continue;
    const c = D.branches[p.branch]?.color || "#333";
    const shape = p.kind === "institution"
      ? `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1 L11 6 L6 11 L1 6 Z" fill="${c}" stroke="#fff" stroke-width="1.2"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" fill="${c}" stroke="#fff" stroke-width="1.2"/></svg>`;
    const m = L.marker(p.latlng, { icon: L.divIcon({ html: shape, className: "pin", iconSize: [12, 12] }), keyboard: false, riseOnHover: true });
    m.bindTooltip(`<strong>${p.name}</strong><br>${D.branches[p.branch]?.label || ""}`, { direction: "top", offset: [0, -6] });
    m.on("click", (e) => { e.originalEvent._slcHit = true; });
    g.addLayer(m);
  }
  layers.pins = g.addTo(map);
}

function updateLabels() {
  if (layers.labels) { map.removeLayer(layers.labels); layers.labels = null; }
  if (!map) return;
  const z = map.getZoom();
  const g = L.layerGroup();
  if (current.geo === "hex") {
    const acc = new Map();
    for (const t of D.hex.tiles) {
      const c = hexCenter(t);
      const a = acc.get(t.st) || [0, 0, 0];
      acc.set(t.st, [a[0] + c[0], a[1] + c[1], a[2] + 1]);
    }
    for (const [st, a] of acc) {
      g.addLayer(L.marker([a[0] / a[2], a[1] / a[2]], { interactive: false, icon: L.divIcon({ className: "state-label", html: (z >= 4.5 || a[2] >= 6) ? D.states.get(st)?.name : st, iconSize: [120, 14] }) }));
    }
  } else if (current.level === "state" || z < 6.5) {
    if (!wide() && z < 4.5) { layers.labels = g.addTo(map); return; }  // too crowded on a phone
    for (const s of D.states.values()) {
      if (z < 5.75 && ["CH", "DH", "LD", "PY", "GA", "DL", "SK", "TR", "MZ", "MN", "NL", "ML"].includes(s.id)) continue;
      const cen = stateCentroid(s.id);
      if (cen) g.addLayer(L.marker(cen, { interactive: false, icon: L.divIcon({ className: "state-label", html: s.name, iconSize: [140, 14] }) }));
    }
  } else {
    const b = map.getBounds();
    for (const d of D.districts.values()) {
      if (!d.centroid || !b.contains(d.centroid)) continue;
      g.addLayer(L.marker(d.centroid, { interactive: false, icon: L.divIcon({ className: "state-label", html: d.name, iconSize: [120, 14] }) }));
    }
  }
  layers.labels = g.addTo(map);
}

const centroidCache = new Map();
// Label point: area-weighted centroid of the state's largest polygon (so island
// groups and split UTs like Dadra-Daman don't get a label in the sea)
function stateCentroid(st) {
  if (centroidCache.has(st)) return centroidCache.get(st);
  const g = D.topo.objects.states.geometries.find((x) => x.properties.st === st);
  if (!g) return null;
  const f = topojson.feature(D.topo, g).geometry;
  const polys = f.type === "Polygon" ? [f.coordinates] : f.coordinates;
  let best = null;
  for (const poly of polys) {
    const ring = poly[0];
    let A = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x0, y0] = ring[j], [x1, y1] = ring[i];
      const k = x0 * y1 - x1 * y0;
      A += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
    }
    if (!best || Math.abs(A) > Math.abs(best.A)) best = { A, c: A ? [cy / (3 * A), cx / (3 * A)] : [ring[0][1], ring[0][0]] };
  }
  centroidCache.set(st, best.c);
  return best.c;
}

export function restyle(state) {
  current = { ...current, ...state };
  if (!map) return;
  for (const [id, layer] of byId) layer.setStyle(styleFor(id));
  if (layers.borders) layers.borders.bringToFront();
  if (layers.outline) layers.outline.bringToFront();
}

export function refreshPins() {
  if (!map) return;
  if (layers.pins) { map.removeLayer(layers.pins); layers.pins = null; }
  drawPins();
}

export function focus(id) {
  const layer = byId.get(id);
  if (layer && layer.getBounds) {
    map.flyToBounds(layer.getBounds(), { padding: [60, 60], maxZoom: current.geo === "hex" ? 5 : 9, duration: 0.6 });
  } else if (isDistrict(id) && current.level === "state") {
    const s = byId.get(stateOf(id));
    if (s) map.flyToBounds(s.getBounds(), { padding: [40, 40], duration: 0.6 });
  }
}

export function resetView() { fitIndia(); }
export function invalidate() { map && map.invalidateSize(); }

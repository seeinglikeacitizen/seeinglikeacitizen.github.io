/* global L, topojson */
import { D, stateOf, isDistrict, jurName } from "./data.js";

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
let lifted = null;             // non-interactive copy of the hovered shape, drawn on top
let mapAttribution = null;

const electoralLevel = (level = current.level) => level === "lok_sabha" || level === "vidhan_sabha";
const boundaryLabel = (level = current.level) => ({
  state: "state", district: "district", lok_sabha: "Lok Sabha constituency",
  rajya_sabha: "Rajya Sabha electoral region", vidhan_sabha: "Vidhan Sabha constituency",
}[level]);

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
  const relevel = state.level && state.level !== current.level;
  current = { ...current, ...state };
  if (rebuild) buildMap();
  else {
    updateAttribution(); drawLayers();
    // each boundary level has its own hexagon layout, so the old view may show none of it
    if (relevel && current.geo === "hex") fitIndia();
  }
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
  updateAttribution();
  map.zoomControl.setPosition("bottomright");
  initialiseView();
}

function updateAttribution() {
  if (!map) return;
  const electoral = electoralLevel() || current.level === "rajya_sabha";
  const next = current.geo === "hex"
    ? `Schematic: one hexagon per ${electoralLevel() ? boundaryLabel() : "district"}`
    : electoral && current.level !== "rajya_sabha"
      ? 'Electoral boundaries: <a href="https://github.com/datameet/maps">DataMeet</a>'
      : 'Administrative boundaries: <a href="https://github.com/datta07/INDIAN-SHAPEFILES">datta07/INDIAN-SHAPEFILES</a>';
  if (mapAttribution) map.attributionControl.removeAttribution(mapAttribution);
  mapAttribution = next;
  map.attributionControl.addAttribution(mapAttribution);
}

function initialiseView() {
  // Leaflet's renderers need a view before any vector layer is added
  if (current.geo === "hex") {
    const t = tilesForLevel(), c = t.map(hexCenter);
    const lat = c.reduce((a, p) => a + p[0], 0) / c.length, lng = c.reduce((a, p) => a + p[1], 0) / c.length;
    map.setView([lat, lng], 2, { animate: false });
  } else map.setView([22.5, 82.5], 4.5, { animate: false });
  addPatterns();
  drawLayers();
  fitIndia();
  map.on("click", (e) => { if (!e.originalEvent._slcHit) opts.onSelect(null); });
  map.on("mouseout", () => {
    drop();
    if (hoverId) {
      const id = hoverId, layer = byId.get(id);
      hoverId = null;
      if (layer?.setStyle) layer.setStyle(styleFor(id));
      opts.onHover(null);
    }
  });
  map.on("zoomend", () => updateLabels());
  map.on("moveend", () => { if ((current.geo === "real" || electoralLevel()) && map.getZoom() >= 6.5) updateLabels(); });
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

function hexGroupBorders(tiles) {
  const key = (lat, lng) => `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const at = new Map();
  for (const t of tiles) { const c = hexCenter(t); at.set(key(c[0], c[1]), t); }
  const segs = [];
  for (const t of tiles) {
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
  const fill = hoverId === id ? css("--hover-blue") : (current.colorFn ? current.colorFn(id) : tintFor(stateOf(id)));
  const districtLevel = current.level !== "state" && current.level !== "rajya_sabha";
  return {
    color: hoverId === id ? css("--hover-blue-edge") : (isSel ? css("--stamp") : (districtLevel ? css("--rule") : css("--ink-3"))),
    weight: hoverId === id ? 2.2 : (isSel ? 2.6 : (districtLevel ? 0.6 : 0.9)),
    fillColor: fill,
    fillOpacity: 1,
    opacity: 1,
    className: "slc-shape",
  };
}

// The hovered shape itself never moves: reordering or transforming the element under the
// pointer makes browsers drop its mouseout (leaving it stuck up) and can swallow the click.
// Instead a copy that ignores the pointer is lifted above it.
function lift(layer, id) {
  drop();
  lifted = L.polygon(layer.getLatLngs(), { ...layer.options, ...styleFor(id), interactive: false }).addTo(map);
  const el = lifted.getElement();
  requestAnimationFrame(() => el && el.classList.add("slc-lift"));
}
function drop() {
  if (lifted) { map.removeLayer(lifted); lifted = null; }
}

function bindShape(layer, id) {
  byId.set(id, layer);
  layer.on("mouseover", (e) => {
    hoverId = id;
    layer.setStyle(styleFor(id));
    lift(layer, id);
    opts.onHover(id, e.containerPoint);
  });
  layer.on("mousemove", (e) => opts.onHover(id, e.containerPoint));
  layer.on("mouseout", () => {
    if (hoverId !== id) return;
    hoverId = null;
    drop();
    layer.setStyle(styleFor(id));
    opts.onHover(null);
  });
  layer.on("click", (e) => { e.originalEvent._slcHit = true; opts.onSelect(id); });
}

function drawLayers() {
  drop(); hoverId = null;
  for (const k of Object.keys(layers)) layers[k] && map.removeLayer(layers[k]);
  layers = {}; byId = new Map();
  if (current.geo === "hex") drawHex(); else drawReal();
  drawPins();
  updateLabels();
}

function drawReal() {
  const topo = D.topo;
  if (electoralLevel()) {
    const fc = D.electoral?.[current.level];
    if (!fc) return;
    layers.base = L.geoJSON(fc, {
      style: (f) => styleFor(f.properties.id),
      onEachFeature: (f, layer) => bindShape(layer, f.properties.id),
    }).addTo(map);
    const outline = topojson.mesh(topo, topo.objects.states, (a, b) => a === b);
    layers.outline = L.geoJSON(outline, { style: { color: css("--ink"), weight: 1.4 }, interactive: false }).addTo(map);
    return;
  }
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
      style: (f) => styleFor(current.level === "rajya_sabha" ? `RS/${f.properties.st}` : f.properties.st),
      onEachFeature: (f, layer) => bindShape(layer, current.level === "rajya_sabha" ? `RS/${f.properties.st}` : f.properties.st),
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
  const tiles = tilesForLevel();
  if (current.level === "district" || electoralLevel()) {
    for (const t of tiles) {
      const poly = L.polygon(hexRing(t), styleFor(t.id));
      bindShape(poly, t.id);
      group.addLayer(poly);
    }
  } else {
    const byState = new Map();
    for (const t of tiles) {
      if (!byState.has(t.st)) byState.set(t.st, []);
      byState.get(t.st).push([hexRing(t)]);
    }
    for (const [st, rings] of byState) {
      const id = current.level === "rajya_sabha" ? `RS/${st}` : st;
      const poly = L.polygon(rings, { ...styleFor(id), weight: 0, stroke: false });
      bindShape(poly, id);
      group.addLayer(poly);
    }
  }
  layers.base = group.addTo(map);
  layers.borders = L.featureGroup(hexGroupBorders(tiles).map((s) => L.polyline(s, { color: css("--ink"), weight: 1.6, interactive: false }))).addTo(map);
}

function tilesForLevel(level = current.level) {
  return electoralLevel(level) ? D.electoral?.hex?.[level]?.tiles || [] : D.hex.tiles;
}

// ---------------------------------------------------------------- institution pins
// On the hexagon map a pin sits in the hexagon of the district that contains it, fanned out
// around the centre when a district has several.
const pinHex = new Map();   // hexagon layout ("district", "lok_sabha", "vidhan_sabha") -> pin id -> [lat, lng]
function pinHexPositions() {
  const layout = electoralLevel() ? current.level : "district";
  if (pinHex.has(layout)) return pinHex.get(layout);
  const tiles = new Map(tilesForLevel(layout).map((t) => [t.id, t]));
  const feats = (layout === "district" ? topojson.feature(D.topo, D.topo.objects.districts).features : D.electoral?.[layout]?.features || [])
    .filter((f) => tiles.has(f.properties.id));
  const inRing = (x, y, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const polys = (g) => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);
  const inGeom = (x, y, g) => polys(g).some((poly) => inRing(x, y, poly[0]) && !poly.slice(1).some((hole) => inRing(x, y, hole)));
  const centre = (g) => { const ring = polys(g)[0][0]; return ring.reduce((a, [x, y]) => [a[0] + x / ring.length, a[1] + y / ring.length], [0, 0]); };
  const centres = feats.map((f) => [f.properties.id, centre(f.geometry)]);
  const shapeAt = ([lat, lng]) => {
    const f = feats.find((f) => inGeom(lng, lat, f.geometry));
    if (f) return f.properties.id;
    let best = null, bd = Infinity;   // offshore or in a gap: nearest shape
    for (const [id, [x, y]] of centres) {
      const dd = (y - lat) ** 2 + (x - lng) ** 2;
      if (dd < bd) { bd = dd; best = id; }
    }
    return best;
  };
  const byTile = new Map();
  for (const p of D.institutions) {
    const id = shapeAt(p.latlng);
    if (!id) continue;
    if (!byTile.has(id)) byTile.set(id, []);
    byTile.get(id).push(p);
  }
  const out = new Map();
  for (const [id, ps] of byTile) {
    const [y, x] = hexCenter(tiles.get(id));
    ps.forEach((p, i) => {
      if (ps.length === 1) { out.set(p.id, [y, x]); return; }
      const a = (2 * Math.PI * i) / ps.length, r = 0.5;
      out.set(p.id, [y + r * Math.sin(a), x + r * Math.cos(a)]);
    });
  }
  pinHex.set(layout, out);
  return out;
}

function drawPins() {
  if (current.lens !== "political" || !opts.pinsVisible()) return;
  const hex = current.geo === "hex" ? pinHexPositions() : null;
  const on = opts.branchesOn();
  const g = L.layerGroup();
  for (const p of D.institutions) {
    if (!on.has(p.branch)) continue;
    const at = hex ? hex.get(p.id) : p.latlng;
    if (!at) continue;
    const c = D.branches[p.branch]?.color || "#333";
    const shape = p.kind === "institution"
      ? `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1 L11 6 L6 11 L1 6 Z" fill="${c}" stroke="#fff" stroke-width="1.2"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" fill="${c}" stroke="#fff" stroke-width="1.2"/></svg>`;
    const m = L.marker(at, { icon: L.divIcon({ html: shape, className: "pin", iconSize: [12, 12] }), keyboard: false, riseOnHover: true });
    const meta = [p.services?.join(", "), p.ownership, p.governance].filter(Boolean).join(" · ");
    m.bindTooltip(`<strong>${p.name}</strong><br>${D.branches[p.branch]?.label || ""}${meta ? `<br><span>${meta}</span>` : ""}`, { direction: "top", offset: [0, -6], className: "institution-tooltip" });
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
    if (electoralLevel()) {
      const min = current.level === "vidhan_sabha" ? 5.25 : 3.75;
      if (z >= min) {
        const b = map.getBounds();
        for (const t of tilesForLevel()) {
          const at = hexCenter(t);
          if (!b.contains(at)) continue;
          const name = jurName(t.id) || t.id;
          g.addLayer(L.marker(at, { interactive: false, icon: L.divIcon({ className: "state-label constituency-label", html: name, iconSize: [96, 24] }) }));
        }
      }
      layers.labels = g.addTo(map);
      return;
    }
    const acc = new Map();
    for (const t of D.hex.tiles) {
      const c = hexCenter(t);
      const a = acc.get(t.st) || [0, 0, 0];
      acc.set(t.st, [a[0] + c[0], a[1] + c[1], a[2] + 1]);
    }
    for (const [st, a] of acc) {
      g.addLayer(L.marker([a[0] / a[2], a[1] / a[2]], { interactive: false, icon: L.divIcon({ className: "state-label", html: (z >= 4.5 || a[2] >= 6) ? D.states.get(st)?.name : st, iconSize: [120, 14] }) }));
    }
  } else if (electoralLevel()) {
    const min = current.level === "vidhan_sabha" ? 8 : 6.5;
    if (z >= min) {
      const b = map.getBounds();
      for (const f of D.electoral?.[current.level]?.features || []) {
        const layer = byId.get(f.properties.id);
        if (!layer?.getBounds) continue;
        const at = layer.getBounds().getCenter();
        if (!b.contains(at)) continue;
        g.addLayer(L.marker(at, { interactive: false, icon: L.divIcon({ className: "state-label constituency-label", html: f.properties.name, iconSize: [110, 24] }) }));
      }
    }
  } else if (current.level === "state" || current.level === "rajya_sabha" || z < 6.5) {
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
  if (lifted && hoverId) { lifted.setStyle(styleFor(hoverId)); lifted.bringToFront(); }
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

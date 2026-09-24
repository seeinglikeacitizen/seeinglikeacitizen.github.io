import { CONFIG } from "./config.js";

const cache = new Map();
async function getJSON(path, { optional = false } = {}) {
  if (cache.has(path)) return cache.get(path);
  const p = fetch(`${CONFIG.DATA}/${path}`).then((r) => {
    if (!r.ok) {
      if (optional) return null;
      throw new Error(`Could not load ${path} (${r.status})`);
    }
    return r.json();
  }).catch((e) => { if (optional) return null; throw e; });
  cache.set(path, p);
  return p;
}

export const D = {
  offices: null, nodes: new Map(), branches: {}, methods: {},
  jur: null, states: new Map(), districts: new Map(), highCourts: {},
  institutions: [], national: null, timeline: [], econNational: null, econLens: null, crimeIndex: null,
  topo: null, hex: null, electoral: null, constituencies: new Map(),
};

export async function loadCore() {
  const [offices, jur, inst, national, timeline, econ, econLens, crime, topo, hex, electoral, hcHolders, hIdx, eIdx] = await Promise.all([
    getJSON("offices.json"), getJSON("jurisdictions.json"), getJSON("institutions.json"),
    getJSON("holders/national.json"), getJSON("timeline.json"), getJSON("economic/national.json"), getJSON("economic/lens.json"),
    getJSON("crime/index.json"), getJSON("geo/india.topo.json"), getJSON("geo/hex.json"),
    getJSON("geo/constituencies.json", { optional: true }),
    getJSON("holders/high_courts.json", { optional: true }),
    getJSON("holders/index.json", { optional: true }), getJSON("economic/index.json", { optional: true }),
  ]);
  D.holderStates = new Set((hIdx && hIdx.states) || []);
  D.econStates = new Set((eIdx && eIdx.states) || []);
  D.offices = offices;
  D.branches = offices.branches;
  D.methods = offices.methods;
  for (const n of offices.nodes) D.nodes.set(n.id, n);
  D.jur = jur;
  D.highCourts = jur.high_courts;
  for (const s of jur.states) D.states.set(s.id, s);
  for (const d of jur.districts) D.districts.set(d.id, d);
  D.institutions = inst.pins;
  D.national = national.holders || {};
  D.hcHolders = (hcHolders && hcHolders.high_courts) || {};
  D.timeline = (timeline.events || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  D.econNational = econ;
  D.econLens = econLens;
  D.crimeIndex = crime;
  D.topo = topo;
  D.hex = hex;
  D.electoral = electoral;
  for (const kind of ["lok_sabha", "vidhan_sabha"]) {
    for (const f of electoral?.[kind]?.features || []) D.constituencies.set(f.properties.id, f.properties);
  }
  for (const s of D.states.values()) D.constituencies.set(`RS/${s.id}`, { id: `RS/${s.id}`, st: s.id, name: s.name, category: "" });
  computeSteps();
  return D;
}

// ---------------------------------------------------------------- jurisdiction helpers
export function stateOf(jurId) {
  if (!jurId) return null;
  const p = jurId.split("/");
  return ["LS", "RS", "VS"].includes(p[0]) ? p[1] : p[0];
}
export function isDistrict(jurId) { return !!jurId && D.districts.has(jurId); }
export function isConstituency(jurId) { return !!jurId && D.constituencies.has(jurId); }
export function constituencyKind(jurId) {
  return jurId?.startsWith("LS/") ? "Lok Sabha constituency"
    : jurId?.startsWith("RS/") ? "Rajya Sabha electoral region"
      : jurId?.startsWith("VS/") ? "Vidhan Sabha constituency" : null;
}
export function jurName(jurId) {
  if (!jurId || jurId === "IN") return "India";
  if (isConstituency(jurId)) return D.constituencies.get(jurId)?.name;
  return isDistrict(jurId) ? D.districts.get(jurId)?.name : D.states.get(jurId)?.name;
}

export function applies(node, stateId) {
  const a = node.applies;
  if (!a || !stateId) return true;
  const st = D.states.get(stateId);
  if (a.states && !a.states.includes(stateId)) return false;
  if (a.types && st && !a.types.includes(st.type)) return false;
  if (a.exclude && a.exclude.includes(stateId)) return false;
  return true;
}

export function officesFor(scope, stateId, { includeBodies = false } = {}) {
  return D.offices.nodes.filter((n) => n.scope === scope && (includeBodies || n.kind === "office") && applies(n, stateId));
}

// ---------------------------------------------------------------- holders
export async function loadStateHolders(stateId) {
  if (!D.holderStates.has(stateId)) return { state: {}, districts: {} };
  const [st, di] = await Promise.all([
    getJSON(`holders/states/${stateId}.json`, { optional: true }),
    getJSON(`holders/districts/${stateId}.json`, { optional: true }),
  ]);
  return { state: (st && st.holders) || {}, districts: (di && di.districts) || {} };
}

// Returns the holder record (or array for multi-holder offices) for an office in a jurisdiction.
export function holderFrom(bundle, node, jurId) {
  if (node.scope === "national") return D.national[node.id] || null;
  const st = stateOf(jurId);
  if (node.id.startsWith("state.hc_")) {
    const hc = D.states.get(st)?.high_court;
    return (D.hcHolders[hc] || {})[node.id] || null;
  }
  if (!bundle) return null;
  if (node.scope === "state") return bundle.state[node.id] || null;
  if (isDistrict(jurId)) return (bundle.districts[jurId] || {})[node.id] || null;
  return null;
}

export function holderList(h) {
  if (!h) return [];
  if (Array.isArray(h)) return h;
  if (Array.isArray(h.holders)) return h.holders;
  return [h];
}

// ---------------------------------------------------------------- appointment graph
// "Steps from a ballot": voters are 0. An elected body is 1. Anyone else is one more than the
// closest body or person that chooses them or whose confidence they need. A body made up of other
// offices (a committee) is as close as its closest member.
const STEPS = new Map();
const VIA = new Map();

function parentsOf(n) {
  const s = n.selection || {};
  if (s.method === "composite") return { kind: "members", ids: s.members || [] };
  return { kind: "chosen", ids: [...(s.by || []), ...(s.advice || []), ...(s.confidence || [])] };
}

function computeSteps() {
  STEPS.clear(); VIA.clear();
  const visiting = new Set();
  const calc = (id) => {
    if (STEPS.has(id)) return STEPS.get(id);
    const n = D.nodes.get(id);
    if (!n) return Infinity;
    if (n.selection.method === "citizens") { STEPS.set(id, 0); return 0; }
    if (visiting.has(id)) return Infinity;
    visiting.add(id);
    const { kind, ids } = parentsOf(n);
    let best = Infinity, via = null;
    for (const p of ids) {
      const v = calc(p);
      if (v < best) { best = v; via = p; }
    }
    visiting.delete(id);
    const val = kind === "members" ? best : best + 1;
    if (val !== Infinity) { STEPS.set(id, val); VIA.set(id, via); }
    return val;
  };
  for (const id of D.nodes.keys()) calc(id);
}

export function stepsFromBallot(id) { return STEPS.has(id) ? STEPS.get(id) : null; }

// Chain from voters to this office, as a list of node ids.
export function ballotChain(id) {
  const out = [id];
  let cur = id, guard = 0;
  while (VIA.has(cur) && guard++ < 20) { cur = VIA.get(cur); out.unshift(cur); }
  return out;
}

// Who this node selects, directly (for the graph and the panel)
export function chosenBy(id) {
  const res = [];
  for (const n of D.offices.nodes) {
    const s = n.selection || {};
    for (const rel of ["by", "advice", "consult", "confidence", "members"]) {
      if ((s[rel] || []).includes(id)) res.push({ id: n.id, rel });
    }
  }
  return res;
}

// ---------------------------------------------------------------- economic and crime
export async function loadStateEconomy(stateId) {
  if (!D.econStates.has(stateId)) return null;
  return getJSON(`economic/states/${stateId}.json`, { optional: true });
}

export async function loadCrime(datasetFile) {
  return getJSON(`crime/${datasetFile}`, { optional: true });
}

export async function economyChoropleth(metric) {
  // Returns { valueByState: Map, min, max } for a state-level tax/indicator metric
  const valueByState = new Map();
  await Promise.all([...D.econStates].map(async (sid) => {
    const e = await loadStateEconomy(sid);
    const v = e && e.taxes && e.taxes[metric] && e.taxes[metric].value;
    if (typeof v === "number") valueByState.set(sid, v);
  }));
  const vals = [...valueByState.values()];
  return { valueByState, min: Math.min(...vals), max: Math.max(...vals) };
}

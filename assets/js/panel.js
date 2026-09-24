import { D, officesFor, holderFrom, holderList, stepsFromBallot, ballotChain, chosenBy, stateOf, isDistrict, jurName, applies } from "./data.js";
import { glyph } from "./glyphs.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const year = (d) => (d ? String(d).slice(0, 4) : "");
const color = (branch) => D.branches[branch]?.color || "#777";
const title = (id) => D.nodes.get(id)?.title || id;

// Head-of-state title differs for states, UTs with LGs and UTs with Administrators
function headNode(stateId) {
  const st = D.states.get(stateId);
  if (!st) return "state.governor";
  return st.head === "Governor" ? "state.governor" : st.head === "Lieutenant Governor" ? "ut.lieutenant_governor" : "ut.administrator";
}

// ---------------------------------------------------------------- holders
function holderLine(h, node) {
  const list = holderList(h);
  if (!list.length) return `<span class="unrecorded">Not recorded yet</span>`;
  if (list.length === 1 && list[0].name == null) {
    const v = list[0];
    return `<span class="unrecorded">Vacant${v.vacant_since ? ` since ${esc(v.vacant_since)}` : ""}</span>${v.status === "verified" ? "" : ` <span class="unverified">(unverified)</span>`}`;
  }
  const shown = list.slice(0, 3).map((x) => {
    const flag = x.status === "verified" ? "" : ` <span class="unverified" title="Not yet checked against a source">(unverified)</span>`;
    const since = x.since ? ` <span class="muted">since ${year(x.since)}</span>` : "";
    return `<span class="name">${esc(x.name)}</span>${since}${flag}`;
  });
  const more = list.length > 3 ? ` and ${list.length - 3} more` : "";
  return shown.join(", ") + more;
}

function sourcesHTML(list) {
  const srcs = list.flatMap((x) => x.sources || []);
  if (!srcs.length) return "";
  return `<dt>Sources</dt><dd>${srcs.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher || s.title || "source")}</a>`).join(", ")}</dd>`;
}

// ---------------------------------------------------------------- the ballot chain
export function chainHTML(id) {
  const steps = stepsFromBallot(id);
  if (steps == null) return `<div class="chain muted">No route back to a ballot is recorded for this post.</div>`;
  const chain = ballotChain(id);
  const parts = chain.map((nid) => {
    const n = D.nodes.get(nid);
    return `<span class="link">${glyph(n.selection.method, color(n.branch), 12)}${esc(n.title)}</span>`;
  });
  const label = steps === 0 ? "the voters themselves" : steps === 1 ? "1 step from a ballot" : `${steps} steps from a ballot`;
  return `<div class="chain">${parts.join('<span class="arrow">→</span>')}<span class="steps">${label}</span></div>`;
}

function relList(ids) {
  return ids.map((id) => `<button class="linkish" data-node="${esc(id)}">${esc(title(id))}</button>`).join(", ");
}

export function officeDetailHTML(node, holder, jurId) {
  const s = node.selection || {};
  const m = D.methods[s.method]?.label || s.method;
  const rows = [
    ["How chosen", esc(m)],
    s.by && ["Chosen or appointed by", relList(s.by)],
    s.advice && ["On the recommendation of", relList(s.advice)],
    s.consult && ["After consulting", relList(s.consult)],
    s.confidence && ["Needs the confidence of", relList(s.confidence)],
    s.members && ["Made up of", relList(s.members)],
    s.basis && ["Legal basis", esc(s.basis)],
    node.term && ["Term", esc(node.term)],
    node.removal && ["Removal", esc(node.removal)],
    node.aka && ["Also called", esc(node.aka.join(", "))],
  ].filter(Boolean);
  const picks = chosenBy(node.id).filter((r) => r.rel === "by" || r.rel === "advice");
  if (picks.length) rows.push(["This post chooses", relList([...new Set(picks.map((p) => p.id))])]);
  const list = holderList(holder);
  return `
    ${chainHTML(node.id)}
    ${node.description ? `<p>${esc(node.description)}</p>` : ""}
    ${s.note ? `<p class="muted">${esc(s.note)}</p>` : ""}
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}${sourcesHTML(list)}</dl>
    <div class="actions">
      <button class="linkish" data-report-office="${esc(node.id)}" data-report-where="${esc(jurId || "")}">Report a change to this post</button>
      <button class="linkish" data-graph-node="${esc(node.id)}">Show in who appoints whom</button>
    </div>`;
}

function officeRow(node, bundle, jurId) {
  const h = holderFrom(bundle, node, jurId);
  const rid = `o-${node.id.replace(/\W/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
  return `<div class="office" style="--branch:${color(node.branch)}">
    <button aria-expanded="false" aria-controls="${rid}" data-toggle>
      ${glyph(node.selection.method, color(node.branch), 16, D.methods[node.selection.method]?.label)}
      <span class="title">${esc(node.title)}</span>
      <span class="holder">${holderLine(h, node)}</span>
    </button>
    <div class="detail" id="${rid}" hidden>${officeDetailHTML(node, h, jurId)}</div>
  </div>`;
}

function section(heading, nodes, bundle, jurId, { collapsed = false, sub = "" } = {}) {
  if (!nodes.length) return "";
  const body = nodes.map((n) => officeRow(n, bundle, jurId)).join("");
  if (collapsed) {
    return `<details><summary><h3 style="display:inline-flex;border:0;margin:18px 0 4px">${esc(heading)}</h3></summary>
      ${sub ? `<p class="muted">${sub}</p>` : ""}${body}</details>`;
  }
  return `<h3>${esc(heading)} <small>${nodes.length}</small></h3>${sub ? `<p class="muted">${sub}</p>` : ""}${body}`;
}

const branchSort = (a, b) => Object.keys(D.branches).indexOf(a.branch) - Object.keys(D.branches).indexOf(b.branch);

// ---------------------------------------------------------------- panels by lens
function header(jurId) {
  const st = D.states.get(stateOf(jurId));
  const hc = D.highCourts[st?.high_court];
  if (isDistrict(jurId)) {
    return `<h2>${esc(jurName(jurId))}</h2>
      <p class="crumbs">District in <button data-select="${st.id}">${esc(st.name)}</button></p>
      <dl class="facts"><dt>High Court</dt><dd>${esc(hc?.name || "")}</dd></dl>`;
  }
  const kind = { state: "State", ut_legislature: "Union territory with a legislature", ut: "Union territory" }[st.type];
  const n = [...D.districts.values()].filter((d) => d.state === st.id).length;
  return `<h2>${esc(st.name)}</h2>
    <p class="crumbs">${kind}</p>
    <dl class="facts">
      <dt>Capital</dt><dd>${esc(st.capital.name)}</dd>
      <dt>Districts</dt><dd>${n}</dd>
      <dt>Legislature</dt><dd>${{ bicameral: "Assembly and Legislative Council", unicameral: "Legislative Assembly", none: "None; administered by the Union" }[st.legislature]}</dd>
      <dt>High Court</dt><dd>${esc(hc?.name || "")}${hc?.seat ? `, ${esc(hc.seat)}` : ""}</dd>
    </dl>`;
}

function timelineFor(jurId) {
  const st = stateOf(jurId);
  const ev = D.timeline.filter((e) => e.jurisdiction === jurId || (isDistrict(jurId) && e.jurisdiction === st) || (!isDistrict(jurId) && stateOf(e.jurisdiction) === st));
  if (!ev.length) return `<h3>Recent changes</h3><p class="muted">No changes recorded here yet.</p>`;
  return `<h3>Recent changes <small>${ev.length}</small></h3>` + ev.slice(0, 8).map((e) =>
    `<p><span class="muted">${esc(e.date)}</span> ${esc(e.summary || `${e.person}: ${e.type}`)}</p>`).join("");
}

export function politicalPanel(jurId, bundle, branchesOn) {
  const st = stateOf(jurId);
  const keep = (n) => branchesOn.has(n.branch);
  let html = header(jurId);
  if (isDistrict(jurId)) {
    html += section("In this district", officesFor("district", st).filter(keep).sort(branchSort), bundle, jurId);
    html += section("Below the district", officesFor("local", st).filter(keep).sort(branchSort), bundle, jurId,
      { collapsed: true, sub: "Posts in blocks, tehsils, towns and villages. Each district has many of these." });
  }
  const stateNodes = officesFor("state", st).filter(keep).sort(branchSort);
  html += section(isDistrict(jurId) ? D.states.get(st).name : "State offices", stateNodes, bundle, jurId);
  if (!isDistrict(jurId)) {
    const tmpl = officesFor("district", st).filter(keep).sort(branchSort);
    html += `<h3>In every district <small>${tmpl.length}</small></h3><p class="muted">Select a district to see who holds these posts there.</p>` +
      tmpl.map((n) => `<p style="margin:3px 0">${glyph(n.selection.method, color(n.branch), 12)} ${esc(n.title)}</p>`).join("");
  }
  html += section("Union", officesFor("national", st).filter(keep).sort(branchSort), bundle, jurId, { collapsed: true });
  html += timelineFor(jurId);
  return html;
}

function lawHTML(l) {
  const flag = l.status === "verified" ? "" : ` <span class="pill unverified">unverified</span>`;
  const src = (l.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">source</a>`).join(" ");
  return `<div class="law"><div class="t">${esc(l.title)} <span class="y">${esc(l.year || "")}</span>${flag}</div><p>${esc(l.summary)} ${src}</p></div>`;
}

const TAX_LABELS = {
  stamp_duty_sale_pct: ["Stamp duty on a property sale", "%"],
  registration_fee_pct: ["Registration fee", "%"],
  professional_tax_max_inr: ["Professional tax, highest annual", "₹"],
  vat_petrol_pct: ["VAT on petrol", "%"],
  minimum_wage_unskilled_daily_inr: ["Minimum daily wage, unskilled", "₹"],
  land_ceiling_act: ["Agricultural land ceiling law", ""],
  agricultural_land_purchase_by_non_farmers: ["Can non-farmers buy farmland?", ""],
};
export const ECON_METRICS = Object.entries(TAX_LABELS).filter(([, v]) => v[1]).map(([k, v]) => ({ id: k, label: v[0], unit: v[1] }));

export function economicPanel(jurId, bundle, econ) {
  const st = stateOf(jurId);
  let html = header(jurId);
  const N = D.econNational;
  html += `<h3>Who makes the rules</h3>` + Object.entries(N.who_legislates).map(([k, v]) =>
    `<p><strong>${k[0].toUpperCase() + k.slice(1)}.</strong> ${esc(v)}</p>`).join("");
  html += `<h3>${esc(D.states.get(st).name)}: taxes and rules</h3>`;
  if (econ) {
    html += `<div class="stat">` + Object.entries(TAX_LABELS).map(([k, [label, unit]]) => {
      const t = econ.taxes?.[k];
      const v = t && t.value != null ? (unit === "₹" ? `₹${Number(t.value).toLocaleString("en-IN")}` : `${esc(t.value)}${unit}`) : `<span class="muted">not compiled</span>`;
      return `<span>${label}</span><span class="num">${v}</span><span></span>`;
    }).join("") + `</div>`;
    const dn = isDistrict(jurId) && econ.districts?.[jurId];
    if (dn) html += `<h4>This district</h4><p>${esc(dn.notes || "")}</p>`;
    if (econ.laws?.length) html += `<h4>State laws</h4>` + econ.laws.map(lawHTML).join("");
  } else {
    html += `<div class="empty-state"><p><strong>Not compiled yet.</strong> Stamp duty, minimum wages, land ceiling and farmland purchase rules for this state haven't been gathered.</p>
      <p>The research agent fills these in one state at a time from official notifications. You can also contribute a file: see <code>data/economic/states/_template.json</code>.</p></div>`;
  }
  const admins = [...officesFor("district", st), ...officesFor("local", st)].filter((n) => n.branch === "economy");
  if (isDistrict(jurId)) html += section("Who administers land, labour and money here", admins, bundle, jurId);
  const groups = { land: "Land", labour: "Labour", capital: "Capital", tax: "Tax" };
  for (const [g, label] of Object.entries(groups)) {
    const laws = N.laws.filter((l) => l.domain === g);
    if (laws.length) html += `<h3>${label}: national law <small>${laws.length}</small></h3>` + laws.map(lawHTML).join("");
  }
  return html;
}

export function crimePanel(jurId, bundle, crime) {
  const st = stateOf(jurId);
  let html = header(jurId);
  const cats = D.crimeIndex.categories;
  const row = crime && (crime.values[jurId] || null);
  if (row) {
    const pop = row.population;
    html += `<h3>Reported crime, ${esc(crime.year)} <small>${esc(crime.source || "NCRB")}</small></h3>
      <div class="stat"><span class="muted">Category</span><span class="num muted">Cases</span><span class="num muted">Per lakh</span>` +
      Object.entries(cats).filter(([k]) => row[k] != null).map(([k, label]) =>
        `<span>${esc(label)}</span><span class="num">${Number(row[k]).toLocaleString("en-IN")}</span><span class="num">${pop ? (row[k] / pop * 1e5).toFixed(1) : "–"}</span>`).join("") + `</div>
      <p class="muted">Counts are cases registered by the police, not all crime that happened. NCRB counts only the most serious offence in each case.</p>`;
  } else {
    html += `<div class="empty-state"><p><strong>No crime figures loaded${isDistrict(jurId) ? " for this district" : ""} yet.</strong></p>
      <p>District figures come from the National Crime Records Bureau's annual <em>Crime in India</em> tables. Load them with <code>scripts/ingest_ncrb.py</code>; see <code>data/crime/README.md</code>.</p></div>`;
  }
  const police = [...officesFor("local", st), ...officesFor("district", st), ...officesFor("state", st)].filter((n) => n.branch === "police" || n.id === "district.judge" || n.id === "district.public_prosecutor");
  html += section("Who is responsible here", police, bundle, jurId);
  return html;
}

// ---------------------------------------------------------------- office node panel (graph view)
export function nodePanel(id) {
  const n = D.nodes.get(id);
  if (!n) return "";
  const scope = { national: "Union", state: "Every state or UT where it applies", district: "Every district", local: "Below the district" }[n.scope];
  const where = n.applies?.states ? `Only in ${n.applies.states.map((s) => D.states.get(s)?.name).join(", ")}` : "";
  const h = n.scope === "national" ? D.national[n.id] : null;
  return `<h2>${esc(n.title)}</h2>
    <p class="crumbs">${glyph(n.selection.method, color(n.branch), 12)} ${esc(D.branches[n.branch]?.label)}. ${esc(scope)}. ${esc(where)}</p>
    ${h ? `<p>Currently: ${holderLine(h, n)}</p>` : ""}
    <div class="office"><div class="detail" style="padding-left:0">${officeDetailHTML(n, h, n.scope === "national" ? "IN" : "")}</div></div>`;
}

// ---------------------------------------------------------------- hover card
export function hoverHTML(jurId, bundle, lens, extra) {
  const st = stateOf(jurId);
  const state = D.states.get(st);
  const row = (id, label) => {
    const n = D.nodes.get(id);
    if (!n || !applies(n, st)) return "";
    const list = holderList(holderFrom(bundle, n, jurId));
    const named = list.filter((x) => x.name);
    const v = named.length ? esc(named.map((x) => x.name).slice(0, 2).join(", ")) : `<span class="empty">${list.length ? "vacant" : "not recorded"}</span>`;
    return `<dt>${esc(label || n.title)}</dt><dd>${v}</dd>`;
  };
  let rows = "";
  if (lens === "political") {
    rows = isDistrict(jurId)
      ? row("district.dm", "District Magistrate") + row("district.sp", "Police chief") + row("district.judge", "District Judge") + row("district.zp_chair", "Zila Parishad head")
      : row(headNode(st), state.head) + row("state.cm") + row("state.hc_cj", "High Court CJ") + row("state.dgp", "Police chief");
  } else if (extra) {
    rows = `<dt>${esc(extra.label)}</dt><dd>${extra.value == null ? '<span class="empty">no data yet</span>' : esc(extra.value)}</dd>`;
  }
  const sub = isDistrict(jurId) ? `District, ${esc(state.name)}` : ({ state: "State", ut_legislature: "Union territory", ut: "Union territory" }[state.type]);
  return `<h3>${esc(jurName(jurId))}</h3><div class="sub">${sub}</div><dl>${rows}</dl><div class="more">Click for details</div>`;
}

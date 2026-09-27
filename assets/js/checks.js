import { D } from "./data.js";

// Separation-of-powers detector. For any office, work out which camp really chooses it (following
// binding advice and counting committee seats under the committee's decision rule), then compare that
// with what the office is meant to check (data/checks.json).

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const K = () => D.checks;
const title = (id) => D.nodes.get(id)?.title || id;
const campLabel = (c) => K().camps[c]?.label || "Unclear";
const campColor = (c) => K().camps[c]?.color || "#999";

export function campOf(id, seen = new Set()) {
  const b = K().base[id];
  if (b) return { camp: b.camp, why: b.why };
  if (seen.has(id)) return { camp: null };
  seen.add(id);
  return controller(id, seen);
}

function committee(id, spec, seen) {
  // a seat may stand for several members (e.g. the four senior-most judges)
  const seats = spec.seats.flatMap((s) => Array.from({ length: s.count || 1 }, (_, i) => ({
    label: s.office ? title(s.office) : s.label, office: s.office, note: s.note, repeat: i > 0,
    camp: s.office ? campOf(s.office, new Set(seen)).camp : s.camp,
  })));
  // a seat filled by the other members goes to whoever controls them
  const fixed = seats.filter((s) => s.camp !== "by_members");
  const count = (list) => list.reduce((m, s) => ((m[s.camp] = (m[s.camp] || 0) + 1), m), {});
  const lead = (counts, n) => Object.entries(counts).find(([, k]) => k > n / 2)?.[0];
  const fixedLead = lead(count(fixed), fixed.length);
  for (const s of seats) if (s.camp === "by_members") s.camp = fixedLead || "shared";
  const counts = count(seats), n = seats.length;
  let camp;
  if (spec.rule === "majority") camp = lead(counts, n) || "shared";
  else camp = Object.keys(counts).length === 1 ? Object.keys(counts)[0] : "shared";   // consensus / unanimity
  return { camp, committee: { id, rule: spec.rule, rule_text: spec.rule_text, basis: spec.basis, seats, counts, n } };
}

// Which camp decides who holds `id`, and through which body
export function controller(id, seen = new Set()) {
  const n = D.nodes.get(id);
  if (!n) return { camp: null };
  const spec = K().committees[id];
  if (spec) return committee(id, spec, seen);
  const s = n.selection || {};
  if (s.method === "composite" && s.members?.length) {
    return committee(id, { rule: "majority", seats: s.members.map((o) => ({ office: o })) }, seen);
  }
  // appointed "in consultation with" the High Court or Supreme Court: the courts treat the judiciary's
  // view as decisive for judicial posts (Articles 233-235)
  if (n.branch === "judicial" && !s.advice?.length && (s.consult || []).some((c) => campOf(c, new Set(seen)).camp === "judiciary")) {
    return { camp: "judiciary", why: "Appointed in consultation with the High Court, whose view prevails.", via: s.by?.[0] };
  }
  // a career officer's posting is decided by the government that posts them, whoever empanels them;
  // otherwise binding advice decides
  const src = s.method === "career_posting" ? s.by?.[0] : s.advice?.[0] || s.by?.[0];
  if (!src) return { camp: null };
  // the President or a Governor appointing without named advice acts on their Council of Ministers
  const acts = !s.advice?.length && K().base[src]?.acts_for;
  const c = acts ? { camp: acts, why: `${title(src)} acts on the advice of the ${campLabel(acts).toLowerCase()}.` } : campOf(src, seen);
  return { ...c, via: src };
}

// The deciding body: if the appointing authority acts on a committee's advice, that committee
export function effective(id) {
  const ctl = controller(id);
  if (ctl.committee || !ctl.via) return ctl;
  const inner = controller(ctl.via);
  return inner.committee ? { ...ctl, camp: inner.camp, committee: inner.committee } : ctl;
}

const LEVELS = {
  captured: { label: "Chosen by the side it is meant to check", cls: "captured" },
  shared: { label: "No single side can choose it", cls: "shared" },
  insulated: { label: "Insulated from the side it checks", cls: "insulated" },
  unreviewed: { label: "Chosen by a government; not yet reviewed", cls: "unreviewed" },
};

export function verdict(id) {
  const a = K().analyses[id];
  const ctl = effective(id);
  if (!a) {
    const n = D.nodes.get(id);
    // flag, without asserting a finding: oversight, police and judicial posts the government fills
    if (n && ["oversight", "police"].includes(n.branch) && ["national", "state"].includes(n.scope) && !K().base[id]
        && ["government", "state_government"].includes(ctl.camp) && n.kind === "office") {
      return { level: "unreviewed", ctl, a: null };
    }
    return null;
  }
  const level = a.checks.includes(ctl.camp) ? "captured" : ctl.camp === "shared" ? "shared" : "insulated";
  const worst = Math.max(0, ...(a.chokepoints || []).map((c) => c.severity));
  return { level, ctl, a, worst };
}

export function verdictChip(id) {
  const v = verdict(id);
  return v ? `<span class="verdict ${LEVELS[v.level].cls}">${esc(LEVELS[v.level].label)}</span>` : "";
}

// ---------------------------------------------------------------- panel
function seatsHTML(c) {
  const counts = Object.entries(c.counts).map(([camp, k]) => `<strong style="color:${campColor(camp)}">${k}</strong> ${camp === "shared" ? "chosen jointly" : esc(campLabel(camp).toLowerCase())}`).join(", ");
  return `<div class="seats">${c.seats.filter((s) => !s.repeat).map((s) => `<span class="seat" style="--camp:${campColor(s.camp)}" title="${esc(campLabel(s.camp))}">
      <i></i>${esc(s.label)}${s.note ? ` <span class="muted">(${esc(s.note)})</span>` : ""}</span>`).join("")}</div>
    <p class="muted">${counts} of ${c.n} seats. Decided by ${c.rule === "majority" ? "majority" : c.rule}. ${esc(c.rule_text || "")}</p>`;
}

function explain(v) {
  const c = v.ctl.committee;
  if (c) {
    const k = c.counts[v.ctl.camp];
    if (v.ctl.camp === "shared") return `No camp holds a majority of the ${c.n} seats, so a choice needs members from more than one side to agree.`;
    const others = Object.keys(c.counts).filter((x) => x !== v.ctl.camp).map((x) => campLabel(x).toLowerCase());
    return `The ${campLabel(v.ctl.camp).toLowerCase()} holds ${k} of ${c.n} seats${c.rule === "majority" ? " and decisions are by majority, so it can choose alone" : ""}.` +
      (others.length && c.rule === "majority" ? ` The ${others.join(" and the ")} can dissent but cannot block.` : "");
  }
  return `In practice chosen by the ${campLabel(v.ctl.camp).toLowerCase()}${v.ctl.why ? `: ${v.ctl.why}` : "."}`;
}

function chain(id, ctl) {
  const s = D.nodes.get(id).selection || {};
  if (!s.by?.length && !ctl.committee) return "";
  const who = s.advice?.length ? `${title(s.by?.[0])} on the advice of ${title(s.advice[0])}` : title(s.by?.[0]);
  return `${s.by?.length ? `<p>Formally: ${esc(who)}.</p>` : ""}${ctl.committee ? seatsHTML(ctl.committee) : ""}`;
}

export function separationHTML(id) {
  const v = verdict(id);
  const n = D.nodes.get(id);
  const m = K().method_rules[n.selection?.method];
  let html = "";
  if (v) {
    const a = v.a;
    html += `<section class="sep"><h3>Separation of powers</h3>
      <p>${verdictChip(id)}</p>
      ${a ? `<p><strong>Its job:</strong> ${esc(a.role)} <span class="muted">Meant to be independent of: ${a.checks.map((c) => esc(campLabel(c).toLowerCase())).join(", ")}.</span></p>` : ""}
      <h4>Who really chooses</h4>${chain(id, v.ctl)}<p>${esc(explain(v))}</p>
      ${a?.chokepoints?.length ? `<h4>Chokepoints</h4><ul class="chokes">${a.chokepoints.map((c) => `<li><span class="sev s${c.severity}" title="severity ${c.severity} of 3"></span><strong>${esc(c.stage[0].toUpperCase() + c.stage.slice(1))}.</strong> ${esc(c.text)}</li>`).join("")}</ul>` : ""}
      ${a?.history ? `<h4>Background</h4><p>${esc(a.history)}</p>` : ""}
      ${a?.reforms?.length ? `<h4>Nudges toward incentive compatibility</h4><ul class="reforms">${a.reforms.map((r) => `<li>${esc(r.text)} <span class="muted">${esc(r.by)}.</span> ${r.serves.map((x) => `<span class="pill serve">${x === "people" ? "will of the people" : "growth"}</span>`).join(" ")}</li>`).join("")}</ul>` : ""}
      ${!a ? `<p class="muted">This post has not been analysed yet. It is a candidate: a government fills it, and oversight and police posts are meant to act impartially, including towards that government.</p>` : ""}
    </section>`;
  }
  const challenge = [...(v?.a?.challenge || []), m?.challenge].filter(Boolean);
  if (m) html += `<h4>How it is decided</h4><p>${esc(m.rule)}</p>`;
  if (challenge.length) html += `<h4>How to challenge it</h4><ul class="chokes plain">${challenge.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`;
  if (v?.a?.refs?.length) html += `<p class="muted">References: ${v.a.refs.map((r) => r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.text)}</a>` : esc(r.text)).join("; ")}.</p>`;
  return html;
}

// ---------------------------------------------------------------- the rulebook (Constitution panel)
export function rulebookHTML() {
  const groups = {};
  for (const r of K().rules) (groups[r.group] ||= []).push(r);
  return `<h3>The rulebook</h3>` + Object.entries(groups).map(([g, rs]) => `<h4>${esc(g)}</h4>` + rs.map((r) => `<details class="rule">
      <summary>${esc(r.title)}</summary>
      <dl>
        <dt>Rule</dt><dd>${esc(r.rule)}</dd>
        <dt>How to challenge</dt><dd>${esc(r.challenge)}</dd>
        <dt>Chokepoint</dt><dd>${esc(r.chokepoint)}</dd>
        <dt>Nudge</dt><dd>${esc(r.reform)}${r.by ? ` <span class="muted">${esc(r.by)}.</span>` : ""} ${(r.serves || []).map((x) => `<span class="pill serve">${x === "people" ? "will of the people" : "growth"}</span>`).join(" ")}</dd>
      </dl></details>`).join("")).join("");
}

// ---------------------------------------------------------------- overview for the graph view
export function chokepointsHTML() {
  const rows = D.offices.nodes.map((n) => ({ n, v: verdict(n.id) })).filter((x) => x.v);
  const order = { captured: 0, shared: 2, insulated: 3, unreviewed: 1 };
  rows.sort((a, b) => order[a.v.level] - order[b.v.level] || (b.v.worst || 0) - (a.v.worst || 0) || a.n.title.localeCompare(b.n.title));
  const reviewed = rows.filter((r) => r.v.a), unreviewed = rows.filter((r) => !r.v.a);
  const card = ({ n, v }) => `<button class="choke-card" data-choke="${esc(n.id)}">
      <span class="t">${esc(n.title)}</span>${verdictChip(n.id)}
      <span class="w">${v.a ? esc(v.a.chokepoints?.[0]?.text || "") : `Filled by the ${esc(campLabel(v.ctl.camp).toLowerCase())}.`}</span></button>`;
  return `<h3>Chokepoints <small>where the side being checked chooses the checker</small></h3>
    <p class="muted">Worked out from how each post is filled: who advises the appointing authority, and how many seats each side holds on selection committees under their voting rule. Select a card for the details, ways to challenge and possible reforms. <button class="linkish" data-choke="in.constitution">Open the rulebook</button></p>
    <div class="choke-grid">${reviewed.map(card).join("")}</div>
    ${unreviewed.length ? `<details class="unreviewed"><summary>${unreviewed.length} more oversight and police posts filled by a government, not yet reviewed</summary><div class="choke-grid">${unreviewed.map(card).join("")}</div></details>` : ""}`;
}

import { D, jurName, stateOf } from "./data.js";
import { CONFIG } from "./config.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const VERB = {
  took_office: "Took office", appointed: "Appointed", resigned: "Resigned", removed: "Removed", transferred: "Transferred",
  elected: "Elected", died: "Died in office", additional_charge: "Additional charge", term_ended: "Term ended", other: "Change",
};

export function initTimeline() {
  const scope = document.getElementById("tl-scope");
  scope.insertAdjacentHTML("beforeend", `<option value="IN">Union</option>` +
    [...D.states.values()].sort((a, b) => a.name.localeCompare(b.name)).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join(""));
  scope.addEventListener("change", renderTimeline);
  document.getElementById("tl-status").addEventListener("change", renderTimeline);
}

export function renderTimeline() {
  const scope = document.getElementById("tl-scope").value;
  const status = document.getElementById("tl-status").value;
  const list = D.timeline.filter((e) => {
    if (scope && (scope === "IN" ? e.jurisdiction !== "IN" : stateOf(e.jurisdiction) !== scope)) return false;
    if (status && (status === "verified" ? e.status !== "verified" : e.status === "verified")) return false;
    return true;
  });
  const ol = document.querySelector(".timeline");
  if (!list.length) {
    ol.innerHTML = `<li><p class="muted">Nothing recorded for this filter yet. Use Report a change to add something you know about.</p></li>`;
    return;
  }
  ol.innerHTML = list.map((e) => {
    const office = D.nodes.get(e.office)?.title || e.office;
    const pill = e.status === "verified" ? `<span class="pill verified">verified</span>` : `<span class="pill unverified">unverified</span>`;
    const src = (e.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher || s.title || "source")}</a>`).join(", ");
    const issue = e.report_issue ? ` (<a href="https://github.com/${CONFIG.REPO}/issues/${e.report_issue}">reported in #${e.report_issue}</a>)` : "";
    return `<li class="${esc(e.type)}">
      <div class="date">${esc(e.date)}, ${esc(jurName(e.jurisdiction))}</div>
      <div class="what">${esc(VERB[e.type] || e.type)}: ${esc(e.person)}, ${esc(office)} ${pill}</div>
      ${e.summary ? `<p class="sum">${esc(e.summary)}</p>` : ""}
      <div class="src">${src || '<span class="muted">No source attached yet</span>'}${issue}</div>
    </li>`;
  }).join("");
}

import { D, jurName, isDistrict } from "./data.js";
import { CONFIG } from "./config.js";

// Labels must match the dropdown options in .github/ISSUE_TEMPLATE/report-change.yml,
// because GitHub prefills dropdowns by option text.
const EVENT_LABELS = {
  took_office: "Took office or was appointed", resigned: "Resigned", removed: "Was removed or suspended",
  transferred: "Was transferred", elected: "Was elected", died: "Died in office",
  additional_charge: "Given additional charge", other: "Something else",
};

let dialog, form;

function placeLabel(id) {
  if (!id || id === "IN") return "India (Union)";
  if (isDistrict(id)) return `${jurName(id)}, ${D.states.get(id.split("/")[0]).name} [${id}]`;
  return `${jurName(id)} [${id}]`;
}

export function initReport() {
  dialog = document.querySelector(".report-dialog");
  form = dialog.querySelector("form");
  document.getElementById("office-options").innerHTML = D.offices.nodes.filter((n) => n.kind === "office")
    .map((n) => `<option value="${n.title} [${n.id}]"></option>`).join("");
  const places = ["IN", ...[...D.states.keys()], ...[...D.districts.keys()]];
  document.getElementById("place-options").innerHTML = places.map((p) => `<option value="${placeLabel(p).replace(/"/g, "&quot;")}"></option>`).join("");
  if (CONFIG.REPORT_FALLBACK_URL) {
    form.querySelector(".fineprint").insertAdjacentHTML("beforeend",
      ` No GitHub account? <a href="${CONFIG.REPORT_FALLBACK_URL}" target="_blank" rel="noopener">Use this form instead</a>.`);
  }
  dialog.addEventListener("close", () => {
    if (dialog.returnValue !== "submit") return;
    const f = new FormData(form);
    const person = f.get("person"), office = f.get("office"), where = f.get("where");
    const params = new URLSearchParams({
      template: CONFIG.REPORT_TEMPLATE,
      title: `[Report] ${person}: ${EVENT_LABELS[f.get("event")]}, ${office.replace(/\s*\[.*\]$/, "")}${where ? `, ${where.replace(/\s*\[.*\]$/, "")}` : ""}`,
      event: EVENT_LABELS[f.get("event")],
      person, office, where: where || "",
      date: f.get("date") || "", source: f.get("source") || "", notes: f.get("notes") || "",
    });
    window.open(`https://github.com/${CONFIG.REPO}/issues/new?${params}`, "_blank", "noopener");
    form.reset();
  });
  form.addEventListener("submit", (e) => {
    // Let the browser validate required fields before closing
    if (e.submitter?.value === "submit" && !form.checkValidity()) { e.preventDefault(); form.reportValidity(); }
  });
}

export function openReport({ office = "", where = "" } = {}) {
  form.reset();
  const n = D.nodes.get(office);
  if (n) form.elements.office.value = `${n.title} [${n.id}]`;
  if (where) form.elements.where.value = placeLabel(where);
  dialog.showModal();
  (n ? form.elements.person : form.elements.event).focus();
}

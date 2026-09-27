import { D } from "./data.js";

// State indicators from data/economic/indicators.json (RBI Handbook of Statistics on Indian States).

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (v, d = 0) => Number(v).toLocaleString("en-IN", { maximumFractionDigits: d });

export const isIndicator = (id) => !!D.indicators?.values?.[id];
export const indicator = (id) => D.indicators?.indicators.find((i) => i.id === id);

export function fmtIndicator(ind, v) {
  if (v == null) return "no data";
  switch (ind.unit) {
    case "₹": return `₹${inr(v)}`;
    case "₹ crore": return v >= 100000 ? `₹${inr(v / 100000, 2)} lakh crore` : `₹${inr(v)} crore`;
    case "lakh people": return v >= 100 ? `${inr(v / 100, 2)} crore people` : `${inr(v, 1)} lakh people`;
    case "%": return `${inr(v, 1)}%`;
    case "% of GSVA": case "% of GSDP": return `${inr(v, 1)}% of ${ind.unit.slice(5)}`;
    case "US$ million": return `US$${inr(v)} million`;
    default: return `${inr(v, 1)} ${ind.unit}`;
  }
}

// value for each state, for colouring the map
export function indicatorChoropleth(id) {
  const vals = D.indicators.values[id] || {};
  const valueByState = new Map(Object.entries(vals).map(([st, x]) => [st, x.v]));
  const nums = [...valueByState.values()];
  const years = [...new Set(Object.values(vals).map((x) => x.year))].sort();
  return { valueByState, min: Math.min(...nums), max: Math.max(...nums), years };
}

export function indicatorOptions() {
  if (!D.indicators) return "";
  const byGroup = {};
  for (const i of D.indicators.indicators) (byGroup[i.group] ||= []).push(i);
  return Object.entries(byGroup).map(([g, list]) =>
    `<optgroup label="${esc(D.indicators.groups[g] || g)}">${list.map((i) => `<option value="${i.id}">${esc(i.label)}</option>`).join("")}</optgroup>`).join("");
}

const ord = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;

// "3rd highest of 34" in the top half, "5th lowest of 34" in the bottom half
function rank(id, st) {
  const vals = Object.entries(D.indicators.values[id] || {}).sort((a, b) => b[1].v - a[1].v);
  const i = vals.findIndex(([s]) => s === st);
  if (i < 0) return "";
  const hi = i + 1, lo = vals.length - i, n = vals.length;
  if (hi === 1) return `highest of ${n}`;
  if (lo === 1) return `lowest of ${n}`;
  return hi <= lo ? `${ord(hi)} highest of ${n}` : `${ord(lo)} lowest of ${n}`;
}

export function indicatorsPanelHTML(st, isDistrictView) {
  if (!D.indicators) return "";
  const byGroup = {};
  for (const i of D.indicators.indicators) {
    const x = D.indicators.values[i.id]?.[st];
    if (x) (byGroup[i.group] ||= []).push([i, x]);
  }
  if (!Object.keys(byGroup).length) return "";
  const src = D.indicators.source;
  return `<h3>The state's economy${isDistrictView ? " <small>state figures</small>" : ""}</h3>` +
    Object.entries(byGroup).map(([g, rows]) => `<h4>${esc(D.indicators.groups[g] || g)}</h4><div class="stat indicators">` +
      rows.map(([i, x]) => `<span>${esc(i.label)} <span class="muted">${esc(x.year)}</span></span><span class="num">${esc(fmtIndicator(i, x.v))}</span><span class="muted rank">${esc(rank(i.id, st))}</span>`).join("") +
      `</div>`).join("") +
    `<p class="muted">Source: <a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.title)}</a>, ${esc(src.publisher)}. Each figure is the latest year the Handbook gives for this state.</p>`;
}

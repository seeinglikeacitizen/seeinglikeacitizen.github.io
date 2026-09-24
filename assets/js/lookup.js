import { D, stateOf, isDistrict } from "./data.js";

// Places a reader can check who holds a post right now. Wikipedia keeps lists of current holders
// for the senior posts; for district posts the official district, court and police websites
// (found through the government's own directory, igod.gov.in) are the most direct source.

const wikiPage = (title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
const wikiSearch = (q) => `https://en.wikipedia.org/w/index.php?title=Special:Search&go=Go&search=${encodeURIComponent(q)}`;
const igod = (q) => `https://igod.gov.in/search?keyword=${encodeURIComponent(q)}`;
const govSearch = (q) => `https://www.google.com/search?q=${encodeURIComponent(`${q} site:gov.in OR site:nic.in`)}`;

const SPEAKERS = "List of current Indian legislative speakers and chairpersons";
const OPPOSITION = "List of current Indian opposition leaders";
const UNION_MINISTERS = "Union Council of Ministers";

// Wikipedia lists that name the current holder of a post in every state (or the Union)
const WIKI_LIST = {
  "state.cm": "List of current Indian chief ministers",
  "state.governor": "List of current Indian governors",
  "ut.lieutenant_governor": "List of current Indian governors",
  "ut.administrator": "List of current Indian governors",
  "state.speaker": SPEAKERS,
  "state.council_chairman": SPEAKERS,
  "state.lop": OPPOSITION,
  "state.hc_cj": "List of sitting judges of the high courts of India",
  "state.hc_judge": "List of sitting judges of the high courts of India",
  "in.speaker_ls": SPEAKERS,
  "in.deputy_chairman_rs": SPEAKERS,
  "in.lop_ls": OPPOSITION,
  "in.lop_rs": OPPOSITION,
  "in.cji": "List of sitting judges of the Supreme Court of India",
  "in.sc_judge": "List of sitting judges of the Supreme Court of India",
  "in.pm": UNION_MINISTERS,
  "in.union_minister": UNION_MINISTERS,
  "in.home_minister": UNION_MINISTERS,
  "in.finance_minister": UNION_MINISTERS,
  "in.labour_minister": UNION_MINISTERS,
  "in.health_minister": UNION_MINISTERS,
  "in.education_minister": UNION_MINISTERS,
};

// Elected district posts: the district's Wikipedia article lists its constituencies and members
const BY_CONSTITUENCY = new Set(["district.mp", "district.mla"]);

export function lookupLinks(node, jurId) {
  const links = [];
  const list = WIKI_LIST[node.id];
  const st = D.states.get(stateOf(jurId));
  const district = isDistrict(jurId) ? D.districts.get(jurId) : null;
  const hc = node.id.startsWith("state.hc_") && st ? D.highCourts[st.high_court] : null;

  if (list) links.push({ label: "Wikipedia list of current holders", url: wikiPage(list) });

  if (node.scope === "national") {
    if (!list) links.push({ label: "Wikipedia", url: wikiSearch(`${node.title} India`) });
  } else if (district && (node.scope === "district" || node.scope === "local")) {
    const place = `${district.name} district, ${st.name}`;
    if (BY_CONSTITUENCY.has(node.id)) links.push({ label: `${district.name} on Wikipedia`, url: wikiSearch(`${district.name} district`) });
    links.push({ label: "Official district websites", url: igod(district.name) });
    links.push({ label: "Search government sites", url: govSearch(`"${node.title}" ${place}`) });
  } else if (hc) {
    links.push({ label: `${hc.name} on Wikipedia`, url: wikiSearch(hc.name) });
    links.push({ label: "Official High Court websites", url: igod(hc.name) });
  } else if (st) {
    if (!list) links.push({ label: "Wikipedia", url: wikiSearch(`${node.title} ${st.name}`) });
    links.push({ label: "Search government sites", url: govSearch(`"${node.title}" ${st.name}`) });
  } else if (!list) {
    links.push({ label: "Wikipedia", url: wikiSearch(`${node.title} India`) });
  }
  return links;
}

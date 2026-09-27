// Download tables of the RBI Handbook of Statistics on Indian States (spreadsheets) into a folder.
//
//   npm i --no-save puppeteer-core
//   node scripts/fetch_rbi_handbook.mjs raw/rbi-handbook $(python3 scripts/ingest_rbi_handbook.py --tables)
//
// The RBI's download server answers plain scripts with a browser check, so this drives a local
// Chrome (set CHROME to its path if it is not in the usual macOS or Linux place). Files keep the RBI's
// names, which start with the table number (19T_....XLSX); ingest_rbi_handbook.py matches on that.
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-core";

const PAGE = "https://www.rbi.org.in/Scripts/AnnualPublications.aspx?head=Handbook%20of%20Statistics%20on%20Indian%20States";
const [out, ...nums] = process.argv.slice(2);
if (!out || !nums.length) {
  console.error("usage: node scripts/fetch_rbi_handbook.mjs <folder> <table numbers...>");
  process.exit(2);
}
const chrome = process.env.CHROME || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"]
  .find((p) => fs.existsSync(p));
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const page = await browser.newPage();
await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36");
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path.resolve(out) });

// the Handbook page lists every table with a link to its spreadsheet
await page.goto(PAGE, { waitUntil: "networkidle2", timeout: 120000 });
const links = await page.evaluate(() => [...document.querySelectorAll("a[href$='.XLSX'], a[href$='.xlsx']")]
  .map((a) => ({ url: a.href, n: (a.href.split("/").pop().match(/^(\d+)T_/) || [])[1] })).filter((x) => x.n));
const edition = await page.evaluate(() => (document.body.innerText.match(/Handbook of Statistics on Indian States (\d{4}-\d{2})/) || [])[1]);

let ok = 0;
for (const n of nums) {
  const link = links.find((l) => l.n === String(n));
  if (!link) { console.error(`table ${n}: not listed on the page`); continue; }
  const target = path.join(out, link.url.split("/").pop());
  for (let attempt = 0; attempt < 3 && !fs.existsSync(target); attempt++) {
    await page.goto(link.url, { timeout: 90000 }).catch(() => {});   // a download aborts the navigation
    for (let i = 0; i < 30 && !fs.existsSync(target); i++) await new Promise((r) => setTimeout(r, 500));
  }
  if (fs.existsSync(target)) ok++; else console.error(`table ${n}: download failed`);
}
await browser.close();
console.log(`${ok}/${nums.length} tables saved to ${out}${edition ? ` (Handbook ${edition})` : ""}`);

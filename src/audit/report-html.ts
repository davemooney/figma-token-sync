/**
 * Self-contained HTML report renderer (SIGNAL aesthetic).
 *
 * Emits ONE file with inline CSS + JS — no external deps, no build step, opens
 * straight from disk. Designed to double as a portfolio artifact:
 *   - exec-summary scorecards (adoption %, unbound, ad-hoc text, library size),
 *   - severity heatmap by rule,
 *   - top offending files,
 *   - a client-side sortable / filterable / paginated findings table with
 *     working Figma deep-links,
 *   - per-file drill-down.
 *
 * The full findings array is embedded as JSON and rendered client-side, so the
 * table stays responsive with thousands of rows across hundreds of files.
 */

import type { AuditResult, RuleId, Severity } from "./types.js";

const RULE_LABELS: Record<RuleId, string> = {
  adoption: "Adoption",
  "unbound-value": "Unbound value",
  "adhoc-text": "Ad-hoc text",
  "local-component": "Local component",
  "duplicate-component": "Duplicate component",
  "detached-candidate": "Detached candidate",
};

const RELIABILITY: Record<RuleId, "reliable" | "heuristic"> = {
  adoption: "reliable",
  "unbound-value": "reliable",
  "adhoc-text": "reliable",
  "local-component": "reliable",
  "duplicate-component": "heuristic",
  "detached-candidate": "heuristic",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scoreColor(pct: number): string {
  if (pct >= 80) return "var(--ok)";
  if (pct >= 50) return "var(--warn)";
  return "var(--bad)";
}

const STYLE = `
:root{
  --bg:#0a0b0f; --panel:#13151c; --panel-2:#191c25; --line:#262a36;
  --ink:#e7e9ee; --muted:#8b90a0; --faint:#5a5f70;
  --accent:#6e7bff; --accent-2:#33e1c4;
  --ok:#33e1c4; --warn:#ffcc66; --bad:#ff6b81; --info:#6e7bff;
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:'Switzer','Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
  font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1200px;margin:0 auto;padding:40px 24px 96px}
header.top{display:flex;justify-content:space-between;align-items:flex-end;
  border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:32px;gap:24px;flex-wrap:wrap}
.brand{font-family:var(--mono);font-weight:600;letter-spacing:.02em;font-size:13px;
  color:var(--accent-2);text-transform:uppercase}
h1{margin:6px 0 4px;font-size:28px;font-weight:600;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px;font-family:var(--mono)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:32px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 22px;position:relative;overflow:hidden}
.card .k{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.card .v{font-size:34px;font-weight:600;margin-top:8px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.card .meta{color:var(--faint);font-size:12px;margin-top:4px;font-family:var(--mono)}
.bar{height:6px;border-radius:6px;background:var(--panel-2);margin-top:14px;overflow:hidden}
.bar>i{display:block;height:100%;border-radius:6px}
section{margin-bottom:36px}
h2{font-size:16px;font-weight:600;margin:0 0 14px;display:flex;align-items:center;gap:10px}
h2 .pill{font-family:var(--mono);font-size:10px;font-weight:500;padding:3px 8px;border-radius:20px;
  background:var(--panel-2);color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.heat{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.heat .h{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.heat .h .n{font-family:var(--mono);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;
  display:flex;justify-content:space-between;align-items:center}
.heat .h .c{font-size:24px;font-weight:600;margin-top:6px;font-variant-numeric:tabular-nums}
.tag{font-family:var(--mono);font-size:9px;padding:2px 6px;border-radius:5px;letter-spacing:.04em;text-transform:uppercase}
.tag.reliable{background:rgba(51,225,196,.12);color:var(--ok)}
.tag.heuristic{background:rgba(255,204,102,.12);color:var(--warn)}
.sev{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:middle}
.sev.info{background:var(--info)} .sev.warning{background:var(--warn)} .sev.error{background:var(--bad)}
.controls{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
.controls input,.controls select{background:var(--panel);border:1px solid var(--line);color:var(--ink);
  border-radius:9px;padding:9px 12px;font-family:var(--mono);font-size:12px;outline:none}
.controls input:focus,.controls select:focus{border-color:var(--accent)}
.controls input[type=search]{flex:1;min-width:220px}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{text-align:left;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--muted);padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;user-select:none;white-space:nowrap}
thead th:hover{color:var(--ink)}
thead th .arr{opacity:.4;margin-left:4px}
tbody td{padding:10px 12px;border-bottom:1px solid var(--panel-2);vertical-align:top}
tbody tr:hover{background:var(--panel)}
td.path{color:var(--muted);font-family:var(--mono);font-size:11px;max-width:340px}
td.msg{max-width:380px}
.rulebadge{font-family:var(--mono);font-size:10px;padding:3px 7px;border-radius:6px;background:var(--panel-2);color:var(--ink);white-space:nowrap}
.empty{color:var(--faint);padding:24px;text-align:center;font-family:var(--mono);font-size:12px}
.pager{display:flex;justify-content:space-between;align-items:center;margin-top:14px;color:var(--muted);font-family:var(--mono);font-size:12px}
.pager button{background:var(--panel);border:1px solid var(--line);color:var(--ink);border-radius:8px;
  padding:7px 14px;cursor:pointer;font-family:var(--mono);font-size:12px}
.pager button:disabled{opacity:.35;cursor:not-allowed}
details.file{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden}
details.file>summary{padding:14px 18px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:16px;list-style:none}
details.file>summary::-webkit-details-marker{display:none}
details.file .fname{font-weight:600}
details.file .fmeta{font-family:var(--mono);font-size:11px;color:var(--muted);display:flex;gap:14px;align-items:center}
details.file .body{padding:0 18px 16px;border-top:1px solid var(--line)}
.pagerow{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--panel-2);font-size:12px}
.pagerow .pn{font-family:var(--mono);color:var(--muted)}
.caveat{background:rgba(255,204,102,.07);border:1px solid rgba(255,204,102,.25);border-radius:10px;
  padding:14px 16px;color:var(--ink);font-size:13px;margin-bottom:20px}
.caveat b{color:var(--warn)}
footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);color:var(--faint);
  font-family:var(--mono);font-size:11px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px}
.mini{font-variant-numeric:tabular-nums}
`;

export function renderHtmlReport(result: AuditResult): string {
  const adoptionPct = result.adoptionPct;
  const topFiles = [...result.files]
    .filter((f) => !f.error)
    .sort(
      (a, b) =>
        b.findings.length - a.findings.length || a.adoptionPct - b.adoptionPct,
    )
    .slice(0, 8);

  const heatCells = (Object.keys(RULE_LABELS) as RuleId[])
    .map((rule) => {
      const count = result.countsByRule[rule] ?? 0;
      const rel = RELIABILITY[rule];
      return `<div class="h"><div class="n"><span>${esc(
        RULE_LABELS[rule],
      )}</span><span class="tag ${rel}">${rel}</span></div><div class="c">${count}</div></div>`;
    })
    .join("");

  const topFileRows = topFiles
    .map((f) => {
      const link = `https://figma.com/file/${f.fileKey}`;
      return `<div class="pagerow"><span class="pn"><a href="${link}" target="_blank" rel="noopener">${esc(
        f.fileName,
      )}</a></span><span class="mini" style="color:${scoreColor(
        f.adoptionPct,
      )}">${f.adoptionPct}% adoption · ${f.findings.length} findings</span></div>`;
    })
    .join("");

  const fileDetails = result.files
    .map((f) => {
      const pageRows =
        f.pages
          .map(
            (p) =>
              `<div class="pagerow"><span class="pn">${esc(
                p.name,
              )}</span><span class="mini" style="color:${scoreColor(
                p.adoptionPct,
              )}">${p.adoptionPct}% · ${p.instanceCount} inst / ${
                p.rawCount
              } raw</span></div>`,
          )
          .join("") ||
        `<div class="pagerow"><span class="pn">${
          f.error ? esc(f.error) : "No pages"
        }</span></div>`;
      return `<details class="file"><summary><span class="fname">${esc(
        f.fileName,
      )}</span><span class="fmeta"><span style="color:${scoreColor(
        f.adoptionPct,
      )}">${f.adoptionPct}%</span><span>${
        f.findings.length
      } findings</span></span></summary><div class="body">${pageRows}</div></details>`;
    })
    .join("");

  // Findings embedded for the client-side table.
  const findingsJson = JSON.stringify(
    result.findings.map((f) => ({
      file: f.fileName,
      page: f.page,
      path: f.nodePath,
      rule: f.rule,
      ruleLabel: RULE_LABELS[f.rule],
      severity: f.severity,
      message: f.message,
      link: f.figmaDeepLink,
    })),
  );

  const totalFindings = result.findings.length;
  const sevCount = (s: Severity) => result.countsBySeverity[s] ?? 0;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Figma Component-Adoption Audit</title>
<link rel="preconnect" href="https://api.fontshare.com">
<link href="https://api.fontshare.com/v2/css?f[]=switzer@400,500,600&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style></head>
<body><div class="wrap">
<header class="top">
  <div>
    <div class="brand">figma-token-sync · audit</div>
    <h1>Component-Adoption Audit</h1>
    <div class="sub">${result.fileCount} file(s) · ${result.libraryComponentCount} published components · generated ${esc(
      result.generatedAt,
    )}</div>
  </div>
  <div style="text-align:right">
    <div class="card" style="min-width:170px;padding:16px 20px">
      <div class="k">Portfolio adoption</div>
      <div class="v" style="color:${scoreColor(adoptionPct)}">${adoptionPct}%</div>
      <div class="bar"><i style="width:${Math.min(
        100,
        adoptionPct,
      )}%;background:${scoreColor(adoptionPct)}"></i></div>
    </div>
  </div>
</header>

<div class="cards">
  <div class="card"><div class="k">Instances</div><div class="v">${result.instanceCount.toLocaleString()}</div><div class="meta">vs ${result.rawCount.toLocaleString()} raw nodes</div></div>
  <div class="card"><div class="k">Unbound values</div><div class="v" style="color:var(--warn)">${result.countsByRule["unbound-value"]}</div><div class="meta">off-token fills / strokes / effects</div></div>
  <div class="card"><div class="k">Ad-hoc text</div><div class="v" style="color:var(--warn)">${result.countsByRule["adhoc-text"]}</div><div class="meta">text with no shared style</div></div>
  <div class="card"><div class="k">Total findings</div><div class="v">${totalFindings}</div><div class="meta"><span class="sev error"></span>${sevCount(
    "error",
  )} · <span class="sev warning"></span>${sevCount(
    "warning",
  )} · <span class="sev info"></span>${sevCount("info")}</div></div>
</div>

<div class="caveat"><b>Read me first.</b> Adoption %, unbound values, ad-hoc text and local-vs-library component flags are
<b>reliable</b> REST signals. <b>Duplicate-component</b> and <b>detached-candidate</b> rows are <b>heuristics</b> —
the Figma REST API has no <code>wasInstance</code> flag, so these are <b>candidates flagged for human review</b>, not ground truth.</div>

<section>
  <h2>Severity heatmap by rule <span class="pill">findings per signal</span></h2>
  <div class="heat">${heatCells}</div>
</section>

<section>
  <h2>Top offending files</h2>
  ${topFileRows || '<div class="empty">No findings 🎉</div>'}
</section>

<section>
  <h2>Findings <span class="pill" id="resultCount"></span></h2>
  <div class="controls">
    <input type="search" id="q" placeholder="search file / page / path / message…">
    <select id="ruleFilter"><option value="">All rules</option>${(
      Object.keys(RULE_LABELS) as RuleId[]
    )
      .map((r) => `<option value="${r}">${esc(RULE_LABELS[r])}</option>`)
      .join("")}</select>
    <select id="sevFilter"><option value="">All severities</option><option value="error">error</option><option value="warning">warning</option><option value="info">info</option></select>
  </div>
  <table id="tbl">
    <thead><tr>
      <th data-k="severity">Sev<span class="arr">↕</span></th>
      <th data-k="ruleLabel">Rule<span class="arr">↕</span></th>
      <th data-k="file">File<span class="arr">↕</span></th>
      <th data-k="page">Page<span class="arr">↕</span></th>
      <th data-k="path">Node path<span class="arr">↕</span></th>
      <th data-k="message">Message<span class="arr">↕</span></th>
      <th>Link</th>
    </tr></thead>
    <tbody id="tbody"></tbody>
  </table>
  <div class="pager">
    <span id="pageInfo"></span>
    <span><button id="prev">‹ Prev</button> <button id="next">Next ›</button></span>
  </div>
</section>

<section>
  <h2>Per-file drill-down</h2>
  ${fileDetails || '<div class="empty">No files analysed.</div>'}
</section>

<footer>
  <span>figma-token-sync · audit — self-contained report</span>
  <span>Flags candidates for human review; it does not claim perfect detection.</span>
</footer>
</div>

<script>
const FINDINGS = ${findingsJson};
const PAGE_SIZE = 50;
let sortKey = 'severity', sortDir = 1, page = 0;
const SEV_ORDER = {error:0, warning:1, info:2};
const q = document.getElementById('q');
const ruleFilter = document.getElementById('ruleFilter');
const sevFilter = document.getElementById('sevFilter');
const tbody = document.getElementById('tbody');

function filtered(){
  const term = q.value.trim().toLowerCase();
  const rf = ruleFilter.value, sf = sevFilter.value;
  return FINDINGS.filter(f=>{
    if(rf && f.rule!==rf) return false;
    if(sf && f.severity!==sf) return false;
    if(term){
      const hay = (f.file+' '+f.page+' '+f.path+' '+f.message+' '+f.ruleLabel).toLowerCase();
      if(!hay.includes(term)) return false;
    }
    return true;
  });
}
function sorted(rows){
  return rows.slice().sort((a,b)=>{
    let av,bv;
    if(sortKey==='severity'){av=SEV_ORDER[a.severity];bv=SEV_ORDER[b.severity];}
    else {av=(a[sortKey]||'').toString().toLowerCase();bv=(b[sortKey]||'').toString().toLowerCase();}
    if(av<bv) return -1*sortDir; if(av>bv) return 1*sortDir; return 0;
  });
}
function esc(s){return (s||'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));}
function render(){
  const rows = sorted(filtered());
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total/PAGE_SIZE));
  if(page>=pages) page=pages-1; if(page<0) page=0;
  const slice = rows.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
  document.getElementById('resultCount').textContent = total + ' result' + (total===1?'':'s');
  if(slice.length===0){tbody.innerHTML='<tr><td colspan="7" class="empty">No matching findings.</td></tr>';}
  else{
    tbody.innerHTML = slice.map(f=>
      '<tr><td><span class="sev '+f.severity+'"></span>'+f.severity+'</td>'+
      '<td><span class="rulebadge">'+esc(f.ruleLabel)+'</span></td>'+
      '<td>'+esc(f.file)+'</td><td>'+esc(f.page)+'</td>'+
      '<td class="path">'+esc(f.path)+'</td><td class="msg">'+esc(f.message)+'</td>'+
      '<td><a href="'+f.link+'" target="_blank" rel="noopener">open ↗</a></td></tr>'
    ).join('');
  }
  document.getElementById('pageInfo').textContent = 'Page '+(page+1)+' / '+pages+' · '+total+' rows';
  document.getElementById('prev').disabled = page<=0;
  document.getElementById('next').disabled = page>=pages-1;
}
document.querySelectorAll('thead th[data-k]').forEach(th=>{
  th.addEventListener('click',()=>{
    const k=th.dataset.k;
    if(sortKey===k) sortDir*=-1; else {sortKey=k;sortDir=1;}
    render();
  });
});
[q,ruleFilter,sevFilter].forEach(el=>el.addEventListener('input',()=>{page=0;render();}));
document.getElementById('prev').addEventListener('click',()=>{page--;render();});
document.getElementById('next').addEventListener('click',()=>{page++;render();});
render();
</script>
</body></html>
`;
}

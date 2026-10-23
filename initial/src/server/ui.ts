/**
 * The dashboard page: one HTML document with inline CSS and JS, allowed by a per-response nonce.
 * Every value from the server is written with textContent, never as HTML.
 * The client script avoids template literals so this file can hold it in one string.
 */
export function dashboardHtml(nonce: string): string {
  return PAGE.replace(/__NONCE__/g, nonce);
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Private inbox triage</title>
<style nonce="__NONCE__">
:root {
  --bg: #faf9f6; --panel: #ffffff; --fg: #1f1e1c; --muted: #6b6a66; --line: #e4e2dc;
  --bad: #b3261e; --warn: #9a5b00; --ok: #2e6b3a; --accent: #33507a; --chip: #f3f2ee;
  --radius: 8px; --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --serif: "Iowan Old Style", Georgia, serif; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #1b1a18; --panel: #242320; --fg: #ecebe7; --muted: #a3a19b; --line: #3a3934;
    --bad: #f2867d; --warn: #e6b45c; --ok: #8fcf9b; --accent: #9db8e0; --chip: #2e2d29; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 var(--sans); }
.wrap { max-width: 1280px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font: 400 28px/1.2 var(--serif); margin: 0; }
.take { margin: 6px 0 0; min-height: 1.4em; }
.banner { display: inline-block; margin-top: 10px; padding: 2px 10px; border: 1px dashed var(--line); border-radius: 999px; color: var(--muted); font-size: 13px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr)); gap: 12px; margin-top: 20px; }
.card, .kpi { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
.kpi { padding: 12px 16px; }
.kpi .l, .muted { color: var(--muted); font-size: 13px; }
.kpi .v { font: 400 28px/1.2 var(--serif); margin: 4px 0; font-variant-numeric: tabular-nums; }
.kpi .v.bad { color: var(--bad); }
.setup { margin-top: 12px; padding: 10px 16px; font-size: 13px; }
.setup summary { cursor: pointer; }
.setup ul { margin: 8px 0 0; padding-left: 18px; }
.setup li.warn { color: var(--warn); } .setup li.fail { color: var(--bad); }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 20px 0 12px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.seg button { background: var(--bg); border: 0; border-right: 1px solid var(--line); padding: 4px 10px; font: inherit; font-size: 13px; color: var(--muted); cursor: pointer; }
.seg button:last-child { border-right: 0; }
.seg button[aria-pressed="true"] { background: var(--panel); color: var(--fg); font-weight: 600; }
select, .btn, textarea, input { font: inherit; color: var(--fg); }
select { font-size: 13px; padding: 4px 8px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg); }
.right { margin-left: auto; }
.split { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 12px; align-items: start; }
@media (max-width: 820px) { .split { grid-template-columns: minmax(0, 1fr); } .right { margin-left: 0; } }
.list { max-height: 46rem; overflow: auto; min-height: 16rem; }
.item { display: block; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--line); border-left: 3px solid transparent; padding: 10px 14px; font: inherit; color: inherit; cursor: pointer; }
.item:last-child { border-bottom: 0; }
.item[aria-selected="true"] { background: var(--bg); }
.u-urgent { border-left-color: var(--bad); } .u-today { border-left-color: var(--warn); } .u-week { border-left-color: var(--line); }
.top { display: flex; gap: 8px; font-size: 13px; color: var(--muted); }
.top .from { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
.ttl { font-weight: 600; margin-top: 2px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; margin-top: 6px; font-size: 12px; }
.pill { padding: 0 6px; border: 1px solid currentColor; border-radius: 999px; font-size: 12px; white-space: nowrap; }
.pill.u-urgent { color: var(--bad); } .pill.u-today { color: var(--warn); } .pill.u-week, .pill.u-fyi, .pill.u-none { color: var(--muted); }
.chip { padding: 0 6px; border-radius: 6px; background: var(--chip); border: 1px solid var(--line); font-size: 12px; white-space: nowrap; }
.chip.ok { color: var(--ok); background: none; border-color: currentColor; } .chip.warn { color: var(--warn); background: none; border-color: currentColor; } .chip.bad { color: var(--bad); background: none; border-color: currentColor; }
.detail { padding: 18px 20px; min-height: 16rem; }
.detail h2 { font-size: 18px; margin: 8px 0 2px; }
.blk { margin-top: 18px; }
.blk h3 { font-size: 12px; color: var(--muted); margin: 0 0 6px; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
.why { border-left: 3px solid var(--line); padding: 2px 12px; }
.why.u-urgent { border-left-color: var(--bad); } .why.u-today { border-left-color: var(--warn); }
dl.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 14px; margin: 8px 0 0; font-size: 13px; }
dl.facts dt { color: var(--muted); } dl.facts dd { margin: 0; }
.msg { margin: 0; padding: 10px 14px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); white-space: pre-wrap; overflow-wrap: anywhere; }
.path { font-family: var(--mono); font-size: 12px; word-break: break-all; }
pre.note { margin: 8px 0 0; padding: 10px 14px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); font: 12px/1.5 var(--mono); white-space: pre-wrap; max-height: 24rem; overflow: auto; }
.redirect, .assume { margin: 6px 0 0; font-size: 13px; color: var(--warn); }
textarea { width: 100%; min-height: 10rem; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); padding: 8px; resize: vertical; }
.ack { margin: 0; padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg); white-space: pre-wrap; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
.btn { font-size: 13px; padding: 4px 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg); cursor: pointer; text-decoration: none; display: inline-block; }
.btn:hover { border-color: var(--muted); }
.btn.p { background: var(--fg); color: var(--bg); border-color: var(--fg); font-weight: 600; }
.btn[disabled] { opacity: .45; cursor: not-allowed; }
.linkbtn { background: none; border: 0; padding: 0; color: var(--muted); text-decoration: underline; cursor: pointer; font-size: 13px; }
.empty { padding: 24px; color: var(--muted); text-align: center; margin: 0; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: var(--muted); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--line); }
td { padding: 6px 8px; border-bottom: 1px solid var(--line); } th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; }
.projects { margin-top: 24px; padding: 16px 20px; }
.toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 8px 14px; font-size: 13px; max-width: min(40rem, calc(100% - 32px)); }
.toast[hidden] { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Private inbox triage</h1>
    <p class="take" id="take">Loading…</p>
    <p class="banner">Phase 1: reading, triage and filing only. Nothing is sent from here; copy a reply and send it from Gmail.</p>
  </header>

  <div class="kpis">
    <div class="kpi"><div class="l">Urgent</div><div class="v" id="k-urgent">—</div><div class="muted">Open, needing your reply</div></div>
    <div class="kpi"><div class="l">Need your reply</div><div class="v" id="k-reply">—</div><div class="muted" id="k-reply-note">In scope, not yet answered</div></div>
    <div class="kpi"><div class="l">Oldest unanswered</div><div class="v"><span id="k-oldest">—</span><span class="muted"> h</span></div><div class="muted">Hours since it arrived</div></div>
    <div class="kpi"><div class="l">Urgent flags you agreed with</div><div class="v" id="k-agree">—</div><div class="muted" id="k-agree-note">Last 14 days</div></div>
  </div>

  <details class="card setup" id="setup"><summary id="setup-sum">Setup not checked yet. Run <code>npm run doctor</code> on the Mac mini.</summary><ul id="setup-list"></ul></details>

  <div class="toolbar">
    <div class="seg" role="group" aria-label="Show" id="view">
      <button type="button" data-v="open" aria-pressed="true">Needs action</button>
      <button type="button" data-v="done" aria-pressed="false">Done</button>
      <button type="button" data-v="all" aria-pressed="false">All</button>
    </div>
    <select id="project" aria-label="Project"><option value="">All projects</option></select>
    <button type="button" class="btn" id="refresh">Refresh</button>
    <span class="muted right" id="poll"></span>
  </div>

  <div class="split">
    <div class="card list" id="list" role="listbox" aria-label="Messages"></div>
    <article class="card detail" id="detail" aria-live="polite"><p class="empty">Select a message.</p></article>
  </div>

  <section class="card projects">
    <h3 class="muted">By project</h3>
    <table><thead><tr><th>Project</th><th>Obsidian folder</th><th class="n">Open</th><th class="n">Urgent</th></tr></thead><tbody id="projects"></tbody></table>
  </section>
</div>
<div class="toast" id="toast" role="status" hidden></div>

<script nonce="__NONCE__">
(function () {
  // One save timer per item, so switching messages never cancels a pending save of another draft.
  var S = { view: "open", project: "", items: [], sel: null, detail: null, summary: null, saveTimers: {} };
  var URG = { urgent: ["Urgent", 0, "u-urgent"], today: ["Today", 1, "u-today"], week: ["This week", 2, "u-week"], fyi: ["FYI", 3, "u-fyi"] };
  var STATUS = { pending_triage: "Triage pending", needs_reply: "Needs reply", needs_action: "Action needed", no_reply_needed: "No reply needed", replied: "Replied", done: "Done", triage_failed: "Triage failed" };
  var OPEN = { pending_triage: true, needs_reply: true, needs_action: true, triage_failed: true };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function api(method, path, body) {
    return fetch(path, { method: method, credentials: "same-origin", headers: body !== undefined || method !== "GET" ? { "content-type": "application/json", "x-inbox-triage": "1" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; }); });
  }
  var toastTimer;
  function toast(text) { var t = $("toast"); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 6000); }
  // Times are shown in the Mac mini's time zone, whatever the browser's, so a deadline reads the same everywhere.
  function tzOpt(o) { if (S.summary && S.summary.tz) o.timeZone = S.summary.tz; return o; }
  function when(iso) { if (!iso) return "—"; var d = new Date(iso); return isNaN(d) ? "—" : d.toLocaleString(undefined, tzOpt({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })); }
  function day(s) { if (!s) return "—"; var d = new Date(s + "T12:00:00Z"); return isNaN(d) ? "—" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }); }
  // Items triaged before deadlines were stored as instants have only the local text.
  function replyBy(utc, local) { return utc ? when(utc) : local ? local.replace("T", " ") : "—"; }
  function pill(u) { var x = URG[u] || ["Untriaged", 4, "u-none"]; return el("span", "pill " + x[2], x[0]); }
  function rank(i) { return (URG[i.urgency] || [0, 5])[1]; }
  function hasBrackets(t) { return /\[[^\]\n]{1,80}\]/.test(t); }

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    var ta = el("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } finally { document.body.removeChild(ta); }
    return Promise.resolve();
  }

  function loadSummary() {
    return api("GET", "/api/summary").then(function (s) {
      S.summary = s;
      $("k-urgent").textContent = String(s.urgentOpen);
      $("k-urgent").classList.toggle("bad", s.urgentOpen > 0);
      $("k-reply").textContent = String(s.needsReply);
      $("k-reply-note").textContent = s.needsAction ? "Plus " + s.needsAction + " task" + (s.needsAction === 1 ? "" : "s") + " without a reply" : "In scope, not yet answered";
      $("k-oldest").textContent = String(s.oldestUnansweredHours);
      var a = s.agreement;
      $("k-agree").textContent = a.agreementRate == null ? "—" : Math.round(a.agreementRate * 100) + "%";
      $("k-agree-note").textContent = a.rated
        ? "Last 14 days: " + a.rated + " of " + a.flaggedUrgent + " urgent flags rated, " + a.disagreed + " wrong" + (a.missedUrgent ? ", " + a.missedUrgent + " missed" : "")
        : "Rate urgent items to start the measure (" + a.flaggedUrgent + " flagged in 14 days)";
      $("take").textContent = s.urgentOpen ? (s.urgentOpen === 1 ? "1 urgent message needs your reply." : s.urgentOpen + " urgent messages need your reply.") : (s.needsReply ? "Nothing urgent. " + s.needsReply + " to answer." : "Nothing waiting on you.");
      if (s.triageFailed) $("take").textContent += " " + s.triageFailed + " could not be triaged; open them to retry.";
      $("poll").textContent = (s.lastPoll ? ((s.lastPoll.ok ? "Checked Gmail " : "Gmail check failed ") + when(s.lastPoll.at) + (s.lastPoll.ok ? "" : ": " + s.lastPoll.message)) : "Gmail not checked yet")
        + (s.tz && s.tz !== Intl.DateTimeFormat().resolvedOptions().timeZone ? " · times in " + s.tz : "");
      var sel = $("project"); if (sel.options.length === 1) s.projects.forEach(function (p) { sel.appendChild(new Option(p.name, p.id)); });
      renderSetup(s.doctor);
    });
  }

  function renderSetup(d) {
    if (!d) return;
    var counts = { ok: 0, warn: 0, fail: 0 };
    var list = $("setup-list"); list.replaceChildren();
    d.checks.forEach(function (c) { counts[c.level]++; var li = el("li", c.level, (c.level === "ok" ? "✓ " : c.level === "warn" ? "! " : "✗ ") + c.name + ": " + c.detail); list.appendChild(li); });
    $("setup-sum").textContent = "Setup checked " + when(d.at) + ": " + counts.ok + " ok, " + counts.warn + " to look at, " + counts.fail + " failing. Obsidian Sync encryption: " + d.syncEncryption + ".";
  }

  function visible() {
    return S.items.filter(function (i) { return !S.project || i.projectId === S.project; })
      .sort(function (a, b) { return rank(a) - rank(b) || String(a.replyByUtc || "9").localeCompare(String(b.replyByUtc || "9")) || b.receivedAt.localeCompare(a.receivedAt); });
  }

  function loadItems() {
    return api("GET", "/api/items?view=" + S.view).then(function (items) { S.items = items; renderList(); renderProjects(); });
  }

  function renderList() {
    var list = $("list"); list.replaceChildren();
    var vis = visible();
    if (!vis.length) { list.appendChild(el("p", "empty", S.view === "open" ? "Nothing waiting. Inbox clear." : "Nothing here.")); renderDetail(null); return; }
    if (!vis.some(function (i) { return i.id === S.sel; })) { S.sel = vis[0].id; loadDetail(S.sel); }
    vis.forEach(function (i) {
      var b = el("button", "item " + ((URG[i.urgency] || [0, 0, ""])[2])); b.type = "button"; b.setAttribute("role", "option"); b.setAttribute("aria-selected", String(i.id === S.sel));
      var top = el("div", "top"); top.appendChild(el("span", "from", i.fromName || i.fromEmail)); top.appendChild(el("span", "", when(i.receivedAt)));
      var meta = el("div", "meta"); meta.appendChild(pill(i.urgency)); meta.appendChild(el("span", "chip", i.projectName));
      if (i.senderVerified === false) meta.appendChild(el("span", "chip bad", "Unverified sender"));
      if (i.onlyCc) meta.appendChild(el("span", "chip", "cc"));
      if (i.reviewRequired) meta.appendChild(el("span", "chip warn", "Review required"));
      if (i.replyBy && i.status === "needs_reply") meta.appendChild(el("span", "muted", "Reply by " + replyBy(i.replyByUtc, i.replyBy)));
      if (i.status === "needs_action") meta.appendChild(el("span", "chip warn", STATUS[i.status]));
      else if (i.status !== "needs_reply") meta.appendChild(el("span", "chip " + (i.status === "triage_failed" ? "warn" : "ok"), STATUS[i.status] || i.status));
      b.appendChild(top); b.appendChild(el("div", "ttl", i.title)); b.appendChild(meta);
      b.addEventListener("click", function () { S.sel = i.id; renderList(); loadDetail(i.id); });
      list.appendChild(b);
    });
  }

  function renderProjects() {
    var by = {};
    (S.summary ? S.summary.projects : []).forEach(function (p) { by[p.id] = { name: p.name, folder: p.folder, open: 0, urgent: 0 }; });
    if (S.view === "open") S.items.forEach(function (i) { var p = by[i.projectId]; if (!p) return; p.open++; if (i.urgency === "urgent" && (i.status === "needs_reply" || i.status === "needs_action")) p.urgent++; });
    var tb = $("projects"); tb.replaceChildren();
    Object.keys(by).forEach(function (id) {
      var p = by[id], tr = el("tr");
      tr.appendChild(el("td", "", p.name)); tr.appendChild(el("td", "path", p.folder));
      tr.appendChild(el("td", "n", S.view === "open" ? String(p.open) : "—")); tr.appendChild(el("td", "n", S.view === "open" ? String(p.urgent) : "—"));
      tb.appendChild(tr);
    });
  }

  function loadDetail(id) {
    return api("GET", "/api/items/" + encodeURIComponent(id)).then(function (d) { if (S.sel === id) { S.detail = d; renderDetail(d); } }).catch(function (e) { toast(e.message); });
  }

  function blk(title) { var b = el("div", "blk"); b.appendChild(el("h3", "", title)); return b; }
  function btn(label, cls, fn, disabled, title) { var b = el("button", "btn" + (cls ? " " + cls : ""), label); b.type = "button"; if (disabled) b.disabled = true; if (title) b.title = title; if (fn) b.addEventListener("click", fn); return b; }

  function renderDetail(d) {
    var box = $("detail"); box.replaceChildren();
    if (!d) { box.appendChild(el("p", "empty", "Select a message.")); return; }
    var t = d.triage;
    var top = el("div", "meta");
    top.appendChild(el("span", "chip", "Gmail")); top.appendChild(pill(d.urgency)); top.appendChild(el("span", "muted", "Received " + when(d.receivedAt)));
    if (d.senderVerified === false) top.appendChild(el("span", "chip bad", "Unverified sender"));
    if (d.onlyCc) top.appendChild(el("span", "chip", "You were in cc"));
    if (d.reviewRequired) top.appendChild(el("span", "chip warn", "Review required"));
    top.appendChild(el("span", "chip " + (d.status === "triage_failed" || d.status === "needs_action" ? "warn" : d.status === "needs_reply" ? "" : "ok"), STATUS[d.status] || d.status));
    box.appendChild(top);
    box.appendChild(el("h2", "", d.title));
    if (t && t.title !== d.subject) box.appendChild(el("p", "muted", "Subject: " + d.subject));
    box.appendChild(el("p", "muted", (d.fromName ? d.fromName + " · " : "") + d.fromEmail + " · " + d.projectName));
    if (d.senderVerified === false) box.appendChild(el("p", "redirect", "Gmail could not verify that this came from " + d.fromEmail + ". The address may be forged: check it in Gmail before acting on anything it asks."));
    if (d.replyRedirected) box.appendChild(el("p", "redirect", "Your reply goes to " + d.replyToName + " (" + d.replyToEmail + "), your own lawyer, not to this sender."));
    var links = el("div", "row");
    if (d.link) { var a = el("a", "btn", "Open in Gmail ↗"); a.href = d.link; a.target = "_blank"; a.rel = "noopener noreferrer"; links.appendChild(a); }
    if (d.status === "triage_failed" || d.stuck) links.appendChild(btn("Retry triage", "", function () { retriage(d.id); }));
    box.appendChild(links);

    if (d.triageError) { var fb = blk("Triage failed"); fb.appendChild(el("p", "assume", d.triageError)); box.appendChild(fb); }

    if (t) {
      var why = blk("Why it is flagged"); var w = el("div", "why " + ((URG[t.urgency] || [0, 0, ""])[2]));
      w.appendChild(el("p", "", t.urgency_reason));
      var dl = el("dl", "facts");
      [["Summary", t.summary], ["Task", t.task || "—"], ["Due", day(t.due_date)], ["Reply by", replyBy(t.reply_by_utc, t.reply_by)], ["Urgency score", t.urgency_score + " of 100"]].forEach(function (f) { dl.appendChild(el("dt", "", f[0])); dl.appendChild(el("dd", "", f[1])); });
      w.appendChild(dl); why.appendChild(w);
      var fbRow = el("div", "row"); fbRow.appendChild(el("span", "muted", "Right urgency?"));
      var sel = el("select"); sel.setAttribute("aria-label", "Your urgency");
      // Not rated, an explicit yes (your rating equals Claude's), or a correction.
      sel.appendChild(new Option("Not rated yet", ""));
      sel.appendChild(new Option("Yes, " + (URG[t.urgency] || ["?"])[0].toLowerCase(), t.urgency));
      Object.keys(URG).forEach(function (k) { if (k !== t.urgency) sel.appendChild(new Option("No, it is " + URG[k][0].toLowerCase(), k)); });
      sel.value = d.userUrgency || "";
      sel.addEventListener("change", function () { api("POST", "/api/items/" + d.id + "/urgency", { urgency: sel.value || null }).then(function () { toast("Thanks. This counts toward the agreement rate."); loadSummary(); }).catch(function (e) { toast(e.message); }); });
      fbRow.appendChild(sel); why.appendChild(fbRow);
      box.appendChild(why);
    }

    var msg = blk("Message"); msg.appendChild(el("p", "msg", d.body));
    if (d.quoted) {
      var qp = el("p", "msg"); qp.hidden = true; qp.textContent = d.quoted;
      var qb = el("button", "linkbtn", "Show quoted or forwarded text"); qb.type = "button";
      qb.addEventListener("click", function () { qp.hidden = !qp.hidden; qb.textContent = qp.hidden ? "Show quoted or forwarded text" : "Hide quoted or forwarded text"; });
      var qr = el("div", "row"); qr.appendChild(qb); msg.appendChild(qr); msg.appendChild(qp);
    }
    box.appendChild(msg);

    if (d.attachments && d.attachments.length) {
      var at = blk("Attachments"); var ul = el("ul");
      d.attachments.forEach(function (x) { ul.appendChild(el("li", "path", x.inVault ? x.path : x.filename + " (over the Sync limit, on the Mac mini at " + x.path + ")")); });
      at.appendChild(ul); box.appendChild(at);
    }

    var ob = blk("Obsidian");
    if (d.notePath) {
      var r = el("div", "row"); r.appendChild(el("span", "chip ok", "Filed")); r.appendChild(el("code", "path", d.notePath));
      var pv = btn("Preview note", "", null); r.appendChild(pv); ob.appendChild(r);
      var pre = el("pre", "note"); pre.hidden = true; ob.appendChild(pre);
      pv.addEventListener("click", function () {
        if (!pre.hidden) { pre.hidden = true; pv.textContent = "Preview note"; return; }
        api("GET", "/api/items/" + d.id + "/note").then(function (n) { pre.textContent = n.content; pre.hidden = false; pv.textContent = "Hide note"; }).catch(function (e) { toast(e.message); });
      });
    } else ob.appendChild(el("p", "assume", "Not filed to Obsidian yet. Check the service log on the Mac mini."));
    box.appendChild(ob);

    if (t && t.suggested_reply) {
      var rp = blk(d.status === "needs_reply" ? "Suggested reply" : "Suggested reply (for reference)");
      if (t.draft_assumption) rp.appendChild(el("p", "assume", "Check: " + t.draft_assumption));
      var ta = el("textarea"); ta.value = d.draft != null ? d.draft : t.suggested_reply; ta.setAttribute("aria-label", "Reply");
      var state = el("span", "muted", d.draft != null && d.draft !== t.suggested_reply ? "Edited" : "");
      ta.addEventListener("input", function () {
        state.textContent = "Saving…"; clearTimeout(S.saveTimers[d.id]);
        var text = ta.value;
        S.saveTimers[d.id] = setTimeout(function () { delete S.saveTimers[d.id]; api("PUT", "/api/items/" + d.id + "/draft", { text: text }).then(function () { state.textContent = "Edited, saved"; }).catch(function (e) { state.textContent = ""; toast(e.message); }); }, 700);
      });
      rp.appendChild(ta);
      var row = el("div", "row");
      row.appendChild(btn("Copy reply", "p", function () {
        copy(ta.value).then(function () { toast(hasBrackets(ta.value) ? "Copied. It still has [brackets]: fill them in before you send it in Gmail." : "Copied. Paste it into your reply in Gmail."); });
      }));
      row.appendChild(btn("Send reply", "", null, true, "Sending arrives in phase 2"));
      row.appendChild(btn("Reset to suggestion", "", function () { ta.value = t.suggested_reply; api("PUT", "/api/items/" + d.id + "/draft", { text: null }).then(function () { state.textContent = ""; }); }));
      row.appendChild(state);
      rp.appendChild(row);
      if (d.reviewRequired) rp.appendChild(el("p", "muted", "Review required: from phase 2, sending to this matter's court or other side asks you to confirm twice."));
      box.appendChild(rp);
    }

    if (t && t.ack_reply) {
      var ak = blk("Or acknowledge now, reply later");
      ak.appendChild(el("p", "ack", t.ack_reply));
      var ar = el("div", "row"); ar.appendChild(btn("Copy acknowledgement", "", function () { copy(t.ack_reply).then(function () { toast("Copied."); }); }));
      ar.appendChild(btn("Send acknowledgement", "", null, true, "Sending arrives in phase 2")); ak.appendChild(ar);
      box.appendChild(ak);
    }

    var act = el("div", "row");
    if (d.status === "needs_action") act.appendChild(btn("Mark done", "p", function () { setStatus(d.id, "done"); }));
    if (d.status === "needs_reply" || d.status === "triage_failed" || d.status === "pending_triage" || d.status === "needs_action") act.appendChild(btn("No reply needed", "", function () { setStatus(d.id, "no_reply_needed"); }));
    else act.appendChild(btn("Back to the queue", "", function () { setStatus(d.id, "needs_reply"); }));
    act.appendChild(el("span", "muted", "Replies you send from Gmail or Superhuman close the item on the next check."));
    box.appendChild(act);
  }

  function setStatus(id, status) {
    api("POST", "/api/items/" + id + "/status", { status: status }).then(function () { toast(status === "no_reply_needed" ? "Marked as no reply needed. The note's task is ticked." : status === "done" ? "Done. The note's task is ticked." : "Back in the queue."); refresh(); }).catch(function (e) { toast(e.message); });
  }
  function retriage(id) {
    toast("Running triage again…");
    api("POST", "/api/items/" + id + "/retriage").then(function (r) { toast(r.ok ? "Triaged." : "Still failing: " + r.error); refresh(); loadDetail(id); }).catch(function (e) { toast(e.message); });
  }
  // Summary first: it carries the time zone the list is shown in.
  function refresh() { return loadSummary().then(loadItems).catch(function (e) { toast(e.message); }); }

  $("view").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-v]"); if (!b) return;
    S.view = b.dataset.v; Array.prototype.forEach.call($("view").querySelectorAll("button"), function (x) { x.setAttribute("aria-pressed", String(x === b)); });
    S.sel = null; loadItems();
  });
  $("project").addEventListener("change", function (e) { S.project = e.target.value; renderList(); });
  $("refresh").addEventListener("click", refresh);
  document.addEventListener("keydown", function (e) {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== "j" && e.key !== "k") return;
    var vis = visible(), i = vis.findIndex(function (x) { return x.id === S.sel; });
    var next = vis[Math.min(vis.length - 1, Math.max(0, i + (e.key === "j" ? 1 : -1)))];
    if (next) { e.preventDefault(); S.sel = next.id; renderList(); loadDetail(next.id); }
  });
  refresh();
  setInterval(function () { if (!document.hidden && !(document.activeElement && document.activeElement.tagName === "TEXTAREA")) refresh(); }, 60000);
})();
</script>
</body>
</html>`;

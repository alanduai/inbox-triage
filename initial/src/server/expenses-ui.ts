/**
 * The monthly expenses page: run the agent, follow it live, review what it found, and choose which
 * receipts go into the draft. Same rules as the inbox page: inline CSS and JS under a per-response
 * nonce, every server value written with textContent, no template literals in the client script.
 */
export function expensesHtml(nonce: string): string {
  return PAGE.replace(/__NONCE__/g, nonce);
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monthly expenses</title>
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
.wrap { max-width: 1180px; margin: 0 auto; padding: 24px 16px 64px; }
a { color: var(--accent); }
.back { font-size: 13px; color: var(--muted); text-decoration: none; }
h1 { font: 400 28px/1.2 var(--serif); margin: 6px 0 0; }
h2 { font-size: 18px; margin: 0 0 4px; }
h3 { font-size: 12px; color: var(--muted); margin: 0 0 8px; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
.take { margin: 6px 0 0; min-height: 1.4em; }
.banner { display: inline-block; margin-top: 10px; padding: 2px 10px; border: 1px dashed var(--line); border-radius: 999px; color: var(--muted); font-size: 13px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr)); gap: 12px; margin-top: 20px; }
.kpi { padding: 12px 16px; }
.kpi .l, .muted { color: var(--muted); font-size: 13px; }
.kpi .v { font: 400 28px/1.2 var(--serif); margin: 4px 0; font-variant-numeric: tabular-nums; }
.kpi .v.bad { color: var(--bad); } .kpi .v.warn { color: var(--warn); } .kpi .v.ok { color: var(--ok); }
.panel { margin-top: 16px; padding: 16px 20px; }
.row { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.btn { font: inherit; font-size: 13px; padding: 5px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-block; }
.btn:hover { border-color: var(--muted); }
.btn.p { background: var(--fg); color: var(--bg); border-color: var(--fg); font-weight: 600; }
.btn[disabled] { opacity: .45; cursor: not-allowed; }
.steps { margin: 12px 0 0; padding: 0; list-style: none; max-height: 16rem; overflow: auto; font-size: 13px; border-top: 1px solid var(--line); }
.steps li { padding: 4px 0; border-bottom: 1px solid var(--line); display: grid; grid-template-columns: 4.75rem minmax(0, 1fr); gap: 8px; }
.steps li .t { color: var(--muted); font-variant-numeric: tabular-nums; }
.steps li.warn .x { color: var(--warn); } .steps li.error .x { color: var(--bad); }
.setup summary { cursor: pointer; font-size: 13px; }
.setup ul { margin: 8px 0 0; padding-left: 18px; font-size: 13px; }
.setup li.warn { color: var(--warn); } .setup li.fail { color: var(--bad); }
dl.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 14px; margin: 10px 0 12px; font-size: 13px; }
dl.facts dt { color: var(--muted); } dl.facts dd { margin: 0; overflow-wrap: anywhere; }
.path { font-family: var(--mono); font-size: 12px; word-break: break-all; }
.alert { margin: 8px 0 0; font-size: 13px; color: var(--warn); }
.alert.bad { color: var(--bad); }
.tablewrap { overflow-x: auto; margin-top: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: var(--muted); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
td.d { white-space: nowrap; }
th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.chip { padding: 0 7px; border-radius: 999px; border: 1px solid currentColor; font-size: 12px; white-space: nowrap; display: inline-block; }
.chip.ok { color: var(--ok); } .chip.warn { color: var(--warn); } .chip.bad { color: var(--bad); } .chip.muted { color: var(--muted); }
.files { margin: 0; padding: 0; list-style: none; }
.files li { font-family: var(--mono); font-size: 11.5px; word-break: break-all; }
tr.hist { cursor: pointer; } tr.hist:hover td { background: var(--bg); } tr.hist[aria-selected="true"] td { background: var(--bg); font-weight: 600; }
.empty { padding: 18px 0 6px; color: var(--muted); margin: 0; }
.toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 8px 14px; font-size: 13px; max-width: min(40rem, calc(100% - 32px)); }
.toast[hidden] { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <a class="back" href="/">← Inbox triage</a>
    <h1 id="h1">Monthly expenses</h1>
    <p class="take" id="take">Loading…</p>
    <p class="banner">Reads Gmail, saves receipts to the month folder, and saves the reply as a Gmail draft. Nothing is sent from here.</p>
  </header>

  <div class="kpis">
    <div class="card kpi"><div class="l">Receipts in the draft</div><div class="v" id="k-att">—</div><div class="muted" id="k-att-n">Latest run</div></div>
    <div class="card kpi"><div class="l">To review</div><div class="v" id="k-rev">—</div><div class="muted">Found, but not attached yet</div></div>
    <div class="card kpi"><div class="l">Still missing</div><div class="v" id="k-miss">—</div><div class="muted">Not in Gmail or on the portals</div></div>
    <div class="card kpi"><div class="l">Last run</div><div class="v" id="k-last">—</div><div class="muted" id="k-last-n">&nbsp;</div></div>
  </div>

  <section class="card panel">
    <div class="row">
      <button type="button" class="btn p" id="run">Run reconciliation</button>
      <span class="muted" id="runstate"></span>
    </div>
    <ol class="steps" id="steps" aria-live="polite"></ol>
  </section>

  <details class="card panel setup" id="setup"><summary id="setup-sum">Setup</summary><ul id="setup-list"></ul></details>

  <section class="card panel" id="result" hidden>
    <h2 id="r-title"></h2>
    <p class="muted" id="r-summary"></p>
    <dl class="facts" id="r-facts"></dl>
    <div id="r-alerts"></div>
    <div class="row" id="r-actions"></div>
    <div class="tablewrap">
      <table>
        <thead><tr><th class="n">#</th><th>Expense</th><th>Date</th><th class="n">Amount</th><th>Status</th><th>Receipt</th><th>In draft</th></tr></thead>
        <tbody id="lines"></tbody>
      </table>
    </div>
  </section>

  <section class="card panel">
    <h3>Runs</h3>
    <div class="tablewrap">
      <table>
        <thead><tr><th>Started</th><th>Month</th><th>Status</th><th class="n">Attached</th><th class="n">Review</th><th class="n">Missing</th></tr></thead>
        <tbody id="history"></tbody>
      </table>
    </div>
  </section>
</div>
<div class="toast" id="toast" role="status" hidden></div>

<script nonce="__NONCE__">
(function () {
  var S = { state: null, run: null, sel: null, timer: null, watching: null };
  var STATUS = {
    pending: ["Looking…", "muted"], found_gmail: ["Found in Gmail", "ok"], found_portal: ["Downloaded", "ok"], needs_review: ["Check this", "warn"],
    not_found: ["Missing", "bad"], login_required: ["Sign in needed", "bad"], error: ["Error", "bad"]
  };
  var RUN = { running: ["Running", "warn"], completed: ["Complete", "ok"], completed_with_gaps: ["Gaps", "warn"], no_request: ["No email found", "muted"], failed: ["Failed", "bad"] };
  var PORTAL = { amazon: "Amazon.de", claude: "Claude", openai: "OpenAI" };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function api(method, path, body) {
    return fetch(path, { method: method, credentials: "same-origin", headers: method !== "GET" ? { "content-type": "application/json", "x-inbox-triage": "1" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j; }); });
  }
  var toastTimer;
  function toast(t) { var x = $("toast"); x.textContent = t; x.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { x.hidden = true; }, 6000); }
  function tzOpt(o) { if (S.state && S.state.tz) o.timeZone = S.state.tz; return o; }
  function when(iso) { if (!iso) return "—"; var d = new Date(iso); return isNaN(d) ? "—" : d.toLocaleString(undefined, tzOpt({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })); }
  function clock(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString(undefined, tzOpt({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })); }
  function day(s) { if (!s) return "—"; var d = new Date(s + "T12:00:00Z"); return isNaN(d) ? s : d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }); }
  function month(p) { if (!p) return "—"; var d = new Date(p + "-15T12:00:00Z"); return isNaN(d) ? p : d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }); }
  function money(a, c) { return a == null ? "—" : a.toFixed(2) + (c ? " " + c : ""); }
  function chip(pair) { return el("span", "chip " + pair[1], pair[0]); }
  function link(text, href) { var a = el("a", "btn", text); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; }
  function counts(run) {
    var attached = {}, att = 0, rev = 0, miss = 0;
    ((run.draft && run.draft.attached) || []).forEach(function (f) { attached[f] = true; });
    run.lines.forEach(function (l) {
      var inDraft = l.files.some(function (f) { return attached[f.filename]; });
      if (inDraft) att++; else if (l.status === "needs_review" || ((l.status === "found_gmail" || l.status === "found_portal") && !l.include)) rev++; else miss++;
    });
    return { att: att, rev: rev, miss: miss, total: run.lines.length, attached: attached };
  }

  function loadState() {
    return api("GET", "/api/expenses/state").then(function (s) {
      var wasRunning = S.state && S.state.runningId;
      S.state = s;
      $("h1").textContent = "Monthly expenses" + (s.company ? " · " + s.company : "");
      renderSetup(s.checks);
      renderHistory(s.runs);
      var btn = $("run");
      btn.disabled = !s.enabled || Boolean(s.runningId) || s.checks.some(function (c) { return c.level === "fail"; });
      btn.textContent = s.runningId ? "Running…" : "Run reconciliation";
      $("runstate").textContent = s.runningId ? "Working: this takes a few minutes. You can leave this page." : !s.enabled ? "Not set up yet." : btn.disabled ? "Fix the setup items marked ✗ first." : "Looks for " + s.accountant + "'s latest expenses email and the receipts she is missing.";
      var target = S.sel || s.runningId || (s.runs[0] && s.runs[0].id);
      if (wasRunning && !s.runningId) finished(wasRunning);
      if (target) return loadRun(target);
      renderRun(null);
    }).catch(function (e) { toast(e.message); }).then(schedule);
  }
  function schedule() { clearTimeout(S.timer); S.timer = setTimeout(loadState, S.state && S.state.runningId ? 2000 : 60000); }

  function finished(id) {
    api("GET", "/api/expenses/runs/" + encodeURIComponent(id)).then(function (r) {
      toast(r.summary || "The run finished.");
      if (window.Notification && Notification.permission === "granted") { try { new Notification("Expenses " + (r.period || ""), { body: r.summary || "The run finished." }); } catch (e) { /* not available */ } }
    }).catch(function () {});
  }

  function loadRun(id) {
    return api("GET", "/api/expenses/runs/" + encodeURIComponent(id)).then(function (r) { S.run = r; renderRun(r); renderHistory(S.state.runs); });
  }

  function renderSetup(checks) {
    var n = { ok: 0, warn: 0, fail: 0 }, ul = $("setup-list"); ul.replaceChildren();
    checks.forEach(function (c) { n[c.level]++; ul.appendChild(el("li", c.level, (c.level === "ok" ? "✓ " : c.level === "warn" ? "! " : "✗ ") + c.name + ": " + c.detail)); });
    $("setup-sum").textContent = "Setup: " + n.ok + " ok" + (n.warn ? ", " + n.warn + " to look at" : "") + (n.fail ? ", " + n.fail + " to fix" : "");
    $("setup").open = n.fail > 0;
  }

  function renderHistory(runs) {
    var tb = $("history"); tb.replaceChildren();
    if (!runs.length) { var tr0 = el("tr"); var td0 = el("td", "muted", "No runs yet."); td0.colSpan = 6; tr0.appendChild(td0); tb.appendChild(tr0); return; }
    runs.forEach(function (r) {
      var tr = el("tr", "hist"); tr.setAttribute("aria-selected", String(S.run && S.run.id === r.id));
      tr.appendChild(el("td", "", when(r.startedAt)));
      tr.appendChild(el("td", "", month(r.period)));
      var td = el("td"); td.appendChild(chip(RUN[r.status] || [r.status, "muted"])); tr.appendChild(td);
      tr.appendChild(el("td", "n", r.total ? r.attached + " of " + r.total : "—"));
      tr.appendChild(el("td", "n", String(r.review)));
      tr.appendChild(el("td", "n", String(r.missing)));
      tr.addEventListener("click", function () { S.sel = r.id; loadRun(r.id); });
      tb.appendChild(tr);
    });
  }

  function renderRun(r) {
    var steps = $("steps"); steps.replaceChildren();
    if (!r) {
      $("result").hidden = true;
      ["k-att", "k-rev", "k-miss", "k-last"].forEach(function (k) { $(k).textContent = "—"; });
      $("take").textContent = S.state && S.state.enabled ? "No run yet. Press Run reconciliation after " + S.state.accountant + " sends this month's list." : "The expenses agent is not set up yet.";
      return;
    }
    r.steps.forEach(function (s) { var li = el("li", s.level); li.appendChild(el("span", "t", clock(s.at))); li.appendChild(el("span", "x", s.text)); steps.appendChild(li); });
    steps.scrollTop = steps.scrollHeight;
    var c = counts(r);
    $("k-att").textContent = r.lines.length ? c.att + " of " + c.total : "—"; $("k-att").className = "v" + (r.lines.length && c.att === c.total ? " ok" : "");
    $("k-rev").textContent = String(c.rev); $("k-rev").className = "v" + (c.rev ? " warn" : "");
    $("k-miss").textContent = String(c.miss); $("k-miss").className = "v" + (c.miss ? " bad" : "");
    $("k-last").textContent = (RUN[r.status] || [r.status])[0]; $("k-last-n").textContent = when(r.finishedAt || r.startedAt);
    $("take").textContent = r.status === "running" ? "Working on " + (r.period ? month(r.period) : "the latest request") + "…" : (r.summary || "");

    $("result").hidden = r.status === "running" && !r.lines.length;
    $("r-title").textContent = r.period ? month(r.period) : "No request found";
    $("r-summary").textContent = r.error ? r.error : (r.status === "running" ? "In progress." : r.summary);
    var dl = $("r-facts"); dl.replaceChildren();
    function fact(k, v, cls) { dl.appendChild(el("dt", "", k)); dl.appendChild(el("dd", cls || "", v)); }
    if (r.request) {
      fact("Request", '"' + r.request.subject + '" from ' + (r.request.fromName ? r.request.fromName + " · " : "") + r.request.fromEmail + ", " + when(r.request.receivedAt));
      if (r.request.otherRequests) fact("She also asks", r.request.otherRequests);
    }
    if (r.folder) fact("Folder", r.folder, "path");
    if (r.draft) fact("Draft", r.draft.attached.length + " attachment" + (r.draft.attached.length === 1 ? "" : "s") + ", " + (r.draft.bytes / 1e6).toFixed(1) + " MB, saved " + when(r.draft.updatedAt));
    var al = $("r-alerts"); al.replaceChildren();
    if (r.request && r.request.alreadyAnswered) al.appendChild(el("p", "alert", "You already replied to this email. Check that this draft is still needed before sending it."));
    if (r.request && r.request.unreadAttachments.length) al.appendChild(el("p", "alert", "Not read by the agent, check yourself: " + r.request.unreadAttachments.join(", ")));
    if (r.draft && r.draft.leftOut.length) al.appendChild(el("p", "alert", "Left out of the draft (size limit): " + r.draft.leftOut.join(", ") + ". They are in the folder."));
    if (r.draftOutdated) al.appendChild(el("p", "alert", "You changed what goes into the draft. Press Update draft to rewrite it in Gmail."));
    if (r.status === "failed") al.appendChild(el("p", "alert bad", r.error));

    var act = $("r-actions"); act.replaceChildren();
    if (r.request && /^https:\/\/mail\.google\.com\//.test(r.request.link)) act.appendChild(link("Open her email in Gmail ↗", r.request.link));
    if (r.draft && S.state.draftsLink) act.appendChild(link("Gmail drafts ↗", S.state.draftsLink));
    if (r.folder) { var cp = el("button", "btn", "Copy folder path"); cp.type = "button"; cp.addEventListener("click", function () { copy(r.folder); }); act.appendChild(cp); }
    if (r.request && r.status !== "running") {
      var up = el("button", "btn" + (r.draftOutdated ? " p" : ""), r.draft ? "Update draft" : "Save draft"); up.type = "button";
      up.disabled = !r.draftOutdated && Boolean(r.draft);
      up.addEventListener("click", function () { up.disabled = true; api("POST", "/api/expenses/runs/" + r.id + "/redraft").then(function (x) { toast(x.draft ? "Draft updated in Gmail." : "Nothing to attach, so no draft."); loadState(); }).catch(function (e) { up.disabled = false; toast(e.message); }); });
      act.appendChild(up);
    }

    var tb = $("lines"); tb.replaceChildren();
    if (!r.lines.length) { var tr0 = el("tr"); var td0 = el("td", "muted", r.status === "running" ? "Reading her email…" : "No expenses."); td0.colSpan = 7; tr0.appendChild(td0); tb.appendChild(tr0); }
    r.lines.forEach(function (l) {
      var tr = el("tr");
      tr.appendChild(el("td", "n", String(l.n)));
      var ex = el("td"); ex.appendChild(el("div", "", l.vendor)); var sub = [l.vendorName !== l.vendor ? l.vendorName : "", l.description].filter(Boolean).join(" · "); if (sub) ex.appendChild(el("div", "sub", sub)); tr.appendChild(ex);
      tr.appendChild(el("td", "d", day(l.date)));
      var am = el("td", "n", money(l.amount, l.currency)); if (l.receipt && l.receipt.amount != null && (l.receipt.currency !== l.currency || l.receipt.amount !== l.amount)) am.appendChild(el("div", "sub", "receipt " + money(l.receipt.amount, l.receipt.currency))); tr.appendChild(am);
      var st = el("td"); st.appendChild(chip(STATUS[l.status] || [l.status, "muted"])); if (l.note) st.appendChild(el("div", "sub", l.note)); tr.appendChild(st);
      var src = el("td");
      if (l.source && l.source.kind === "gmail") { src.appendChild(el("div", "", l.source.subject)); src.appendChild(el("div", "sub", l.source.from + " · " + when(l.source.date))); }
      else if (l.source && l.source.kind === "portal") src.appendChild(el("div", "", PORTAL[l.source.portal] || l.source.portal));
      if (l.files.length) { var ul = el("ul", "files"); l.files.forEach(function (f) { ul.appendChild(el("li", "", f.filename)); }); src.appendChild(ul); }
      if (!l.source && !l.files.length) src.appendChild(el("span", "muted", "—"));
      tr.appendChild(src);
      var inc = el("td");
      if (l.files.length && r.status !== "running") {
        var cb = el("input"); cb.type = "checkbox"; cb.checked = l.include; cb.setAttribute("aria-label", "Include " + l.vendor + " in the draft");
        cb.addEventListener("change", function () { api("POST", "/api/expenses/runs/" + r.id + "/lines/" + l.n, { include: cb.checked }).then(function () { loadRun(r.id); }).catch(function (e) { cb.checked = !cb.checked; toast(e.message); }); });
        inc.appendChild(cb); if (c.attached && l.files.some(function (f) { return c.attached[f.filename]; })) inc.appendChild(el("span", "muted", " attached"));
      } else inc.appendChild(el("span", "muted", "—"));
      tr.appendChild(inc);
      tb.appendChild(tr);
    });
  }

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(function () { toast("Copied."); });
    var ta = el("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied."); } finally { document.body.removeChild(ta); }
  }

  $("run").addEventListener("click", function () {
    var who = S.state ? S.state.accountant : "the accountant";
    if (!window.confirm("Run the expenses reconciliation now?\n\nIt reads Gmail, may open Amazon.de, Claude and OpenAI in the Mac mini's browser, saves receipts to the month folder and saves a reply to " + who + " as a Gmail draft. Nothing is sent.")) return;
    if (window.Notification && Notification.permission === "default") { try { Notification.requestPermission(); } catch (e) { /* ignore */ } }
    $("run").disabled = true;
    api("POST", "/api/expenses/run").then(function (x) { S.sel = x.runId; toast("Started."); loadState(); }).catch(function (e) { $("run").disabled = false; toast(e.message); });
  });
  loadState();
})();
</script>
</body>
</html>`;

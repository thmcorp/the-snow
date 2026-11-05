/* THM Snow – crew salt log and storm clearing checklist.
   Talks to Supabase through one database function, api(name, pin, action, data).
   Taps are saved to an outbox first, so nothing is lost when a truck has no signal. */
"use strict";

const CFG = window.THM_CONFIG || {};
const POLL_MS = 8000;
const GPS_RADIUS_M = 120;
const YARDS_BULK = ["Cranston", "Lincoln", "Providence"];
const YARDS_BAGS = ["Cranston", "Lincoln", "Providence", "EG"];

// ---------- local storage helpers ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem("thm:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("thm:" + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem("thm:" + k); } catch (e) {} }
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));

// ---------- state ----------
let AUTH = LS.get("auth", null);            // {name, pin, role, session}
let DATA = LS.get("data", null);            // last server state
let OUTBOX = LS.get("outbox", []);          // pending writes [{action, data}]
const UI = { tab: LS.get("tab", "home"), here: LS.get("here", null), from: "", to: "", allFeed: false,
  report: null, online: true, ownerData: null, gps: { status: "off", pos: null }, lastAuto: null, flushing: false };

// ---------- formatting ----------
const pad = n => String(n).padStart(2, "0");
const md = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
const hm = t => { const d = new Date(t); return pad(d.getHours()) + pad(d.getMinutes()); };
const amtTxt = a => (+a >= 1 ? "" : " " + String(+a).replace(/^0/, ""));
const amtWord = a => (+a >= 1 ? "full" : +a === 0.5 ? "half" : String(+a).replace(/^0/, ""));
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtWhen = t => new Date(t).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const localDate = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowIso = () => new Date().toISOString();

// ---------- properties / routes ----------
let ROUTES = [], PROPS = {};
function buildRoutes() {
  ROUTES = []; PROPS = {};
  const byRoute = {};
  ((DATA && DATA.properties) || []).forEach(p => {
    const m = p.label.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    const o = { id: p.id, label: p.label, addr: m ? m[1] : p.label, client: m ? m[2] : "", walks: !!p.walks,
      route: p.route_id, lat: p.lat, lng: p.lng };
    PROPS[o.id] = o;
    if (!byRoute[p.route_id]) { byRoute[p.route_id] = { id: p.route_id, name: p.route_name, props: [] }; ROUTES.push(byRoute[p.route_id]); }
    byRoute[p.route_id].props.push(o);
  });
}
const allProps = () => ROUTES.flatMap(r => r.props);
const saltOnly = p => /salt only/i.test(p.label || "");
const clearable = () => allProps().filter(p => !saltOnly(p));

// ---------- server ----------
async function rpc(action, data, fn) {
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) throw { code: "config" };
  let res;
  try {
    res = await fetch(CFG.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/rpc/" + (fn || "api"), {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY, Authorization: "Bearer " + CFG.SUPABASE_ANON_KEY },
      body: JSON.stringify({ p_name: AUTH && AUTH.name, p_pin: AUTH && AUTH.pin, p_action: action, p_data: data || {} })
    });
  } catch (e) { throw { code: "network" }; }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw { code: (body && body.message) || ("http_" + res.status), status: res.status };
  return body;
}

// Apply a write to local data right away (also re-applied after each refresh until it is sent).
function applyLocal(item) {
  if (!DATA) return;
  const d = item.data;
  switch (item.action) {
    case "start_run": DATA.run = { id: d.id, crew: AUTH.name, started: d.ts, ended: null }; DATA.entries = []; break;
    case "finish_run": if (DATA.run && DATA.run.id === d.id) { DATA.run = null; DATA.entries = []; } break;
    case "salt": if (!DATA.entries.some(e => e.id === d.id)) DATA.entries.push({ ...d, crew: AUTH.name }); break;
    case "salt_edit": DATA.entries.forEach(e => { if (e.id === d.id) Object.assign(e, d); }); break;
    case "salt_delete": DATA.entries = DATA.entries.filter(e => e.id !== d.id); break;
    case "fill": if (!DATA.fills.some(f => f.id === d.id)) DATA.fills.push({ ...d, crew: AUTH.name }); break;
    case "fill_delete": DATA.fills = DATA.fills.filter(f => f.id !== d.id); break;
    case "clear":
      DATA.clears = (DATA.clears || []).filter(c => !(c.prop_id === d.prop_id && c.part === d.part));
      if (d.checked) DATA.clears.push({ storm_id: d.storm_id, prop_id: d.prop_id, part: d.part, crew: AUTH.name, ts: d.ts, note: d.note || "" });
      break;
    case "storm_end": DATA.storm = null; DATA.clears = []; break;
  }
}
function send(action, data) {
  const item = { action, data: { ...data } };
  OUTBOX.push(item); LS.set("outbox", OUTBOX);
  applyLocal(item); LS.set("data", DATA);
  render(); flush();
}
async function flush() {
  if (UI.flushing) return; UI.flushing = true;
  try {
    while (OUTBOX.length) {
      const item = OUTBOX[0];
      try { await rpc(item.action, item.data); setOnline(true); }
      catch (e) {
        if (e.code === "network" || e.code === "config" || (e.status && e.status >= 500)) { setOnline(false); break; }
        if (e.code === "bad_pin") { signOutLocal("Your PIN changed. Sign in again."); break; }
        toast(e.code === "no_storm" ? "That storm was ended, so the check wasn't saved." : "One change couldn't be saved (" + e.code + ").");
      }
      OUTBOX.shift(); LS.set("outbox", OUTBOX);
    }
  } finally { UI.flushing = false; }
  if (!OUTBOX.length) refresh();
}
async function refresh() {
  if (!AUTH) return;
  try {
    const st = await rpc("state", { session: AUTH.session, here: UI.here || null });
    DATA = st; OUTBOX.forEach(applyLocal); LS.set("data", DATA);
    if (AUTH.role !== st.role) { AUTH.role = st.role; LS.set("auth", AUTH); }
    setOnline(true);
    if (AUTH.role === "owner" && UI.tab === "logs") await loadOwnerData();
  } catch (e) {
    if (e.code === "bad_pin") { signOutLocal("Your PIN changed. Sign in again."); return; }
    setOnline(false);
  }
  buildRoutes();
  if (!document.getElementById("modal").innerHTML && !isTyping()) render();
}
async function loadOwnerData() {
  try { UI.ownerData = await rpc("owner_data", { from: UI.from || null, to: UI.to || null }); }
  catch (e) { if (!UI.ownerData) UI.ownerData = { entries: [], fills: [], clear_log: [] }; }
}
const isTyping = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "SELECT") && a.closest("#app"); };
function setOnline(on) {
  UI.online = on;
  const b = document.getElementById("banner");
  const pending = OUTBOX.length;
  if (!on || pending) {
    b.hidden = false;
    b.textContent = !on ? `No signal. ${pending ? pending + " tap" + (pending > 1 ? "s" : "") + " saved on this phone and will send automatically." : "Showing the last saved data."}` : `Sending ${pending} saved tap${pending > 1 ? "s" : ""}…`;
  } else b.hidden = true;
}
setInterval(() => { if (AUTH) { if (OUTBOX.length) flush(); else refresh(); } }, POLL_MS);
window.addEventListener("online", () => flush());
document.addEventListener("visibilitychange", () => { if (!document.hidden && AUTH) flush(); });

// ---------- excel log (same layout as the hand log) ----------
function cellText(list) {
  const s = [...list].sort((a, b) => a.ts.localeCompare(b.ts)); let prev = "";
  return s.map(e => { const day = md(e.ts); const t = (day === prev ? "" : day + " ") + hm(e.ts) + amtTxt(e.amt) + (e.note ? " " + e.note : ""); prev = day; return t; }).join(", ");
}
function sheetRows(entries) {
  const rows = []; const cut = new Date(Date.now() - 15 * 60000).toISOString();
  ROUTES.forEach(r => {
    rows.push({ heading: r.name });
    r.props.forEach(p => {
      const mine = entries.filter(a => a.prop_id === p.id);
      const fr = area => mine.some(a => a.area === area && a.ts >= cut);
      rows.push({ prop: p.label, drives: cellText(mine.filter(a => a.area === "drives")), walks: cellText(mine.filter(a => a.area === "walks")),
        fd: fr("drives"), fw: fr("walks"), nowalk: !p.walks });
    });
  });
  return rows;
}
function tableHTML(entries) {
  return `<div class="tbl-wrap"><table class="log"><thead><tr><th>Property</th><th>Salt Parking Lots</th><th>Salt Walks</th></tr></thead><tbody>${
    sheetRows(entries).map(r => r.heading ? `<tr class="rh"><td colspan="3">${esc(r.heading)}</td></tr>` :
      `<tr><td>${esc(r.prop)}</td><td class="t${r.fd ? " fresh" : ""}">${esc(r.drives)}</td>${r.nowalk ? `<td class="nowalk" title="No walkway salting"></td>` : `<td class="t${r.fw ? " fresh" : ""}">${esc(r.walks)}</td>`}</tr>`).join("")}</tbody></table></div>`;
}
function dataRows(od) {
  const salt = od.entries.map(a => ({ ts: a.ts, crew: a.crew, type: "Salt", prop: a.prop_id, area: a.area, detail: amtWord(a.amt) + (a.note ? " · " + a.note : "") }));
  const clr = od.clear_log.map(c => ({ ts: c.ts, crew: c.crew, type: "Clearing", prop: c.prop_id, area: c.part, detail: (c.checked ? (c.note ? "Checked, not fully cleared: " + c.note : "Checked cleared") : "Unchecked") + (c.storm_name ? " · " + c.storm_name : "") }));
  return [...salt, ...clr].sort((a, b) => a.ts.localeCompare(b.ts));
}
const fillWord = x => x.kind === "bulk" ? `Bulk${x.yard ? " · " + x.yard : ""}` : `Bags · ${x.bags || "?"}${x.yard ? " · " + x.yard : ""}`;
const areaWord = r => r.area === "walks" ? "Walkways" : "Parking lots";
const clearWord = a => a === "drives" ? "Parking lots" : "Walkways";
const propName = id => (PROPS[id] ? PROPS[id].addr : id);
function rangeName(od) {
  const ts = [...od.entries, ...od.fills, ...od.clear_log].map(a => a.ts).sort();
  if (!ts.length) return "Salt log";
  const f = t => { const d = new Date(t); return `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(2)}`; };
  const a = f(ts[0]), b = f(ts[ts.length - 1]); return a === b ? a : `${a} - ${b}`;
}
function exportXlsx(od) {
  if (typeof XLSX === "undefined") { toast("Excel export didn't load. Check your connection and try again."); return; }
  const aoa = [["Property", "", "Salt Parking Lots", "Salt Walks"], []];
  sheetRows(od.entries).forEach(r => { if (r.heading) { if (aoa.length > 2) aoa.push([]); aoa.push([r.heading]); aoa.push([]); } else aoa.push([r.prop, "", r.drives, r.nowalk ? "" : r.walks]); });
  const ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = [{ wch: 60 }, { wch: 2 }, { wch: 70 }, { wch: 55 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Main log");
  const fl = [["Date", "Time", "Driver", "Filled with", "Bags", "Yard"], ...od.fills.map(x => [md(x.ts), hm(x.ts), x.crew, x.kind === "bulk" ? "Bulk" : "Bags", x.bags || "", x.yard || ""])];
  const ws3 = XLSX.utils.aoa_to_sheet(fl); ws3["!cols"] = [{ wch: 7 }, { wch: 6 }, { wch: 14 }, { wch: 11 }, { wch: 6 }, { wch: 12 }]; XLSX.utils.book_append_sheet(wb, ws3, "Salt fill-ups");
  const det = [["Date", "Time", "Driver", "Type", "Property", "Area", "Detail"], ...dataRows(od).map(r => [md(r.ts), hm(r.ts), r.crew, r.type, PROPS[r.prop] ? PROPS[r.prop].label : r.prop, areaWord(r), r.detail])];
  const ws2 = XLSX.utils.aoa_to_sheet(det); ws2["!cols"] = [{ wch: 7 }, { wch: 6 }, { wch: 14 }, { wch: 10 }, { wch: 60 }, { wch: 12 }, { wch: 30 }]; XLSX.utils.book_append_sheet(wb, ws2, "Log data");
  XLSX.writeFile(wb, rangeName(od) + ".xlsx");
}

// ---------- GPS ----------
let gpsWatch = null;
function distM(a, b, c, d) { const R = 6371000, t = x => x * Math.PI / 180; const dl = t(c - a), dn = t(d - b);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
function startGps() {
  if (gpsWatch != null || !navigator.geolocation) { if (!navigator.geolocation) UI.gps.status = "none"; return; }
  UI.gps.status = "waiting";
  gpsWatch = navigator.geolocation.watchPosition(pos => {
    UI.gps.status = "on"; UI.gps.pos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
    let best = null, bd = Infinity;
    allProps().forEach(p => { if (p.lat == null) return; const dd = distM(pos.coords.latitude, pos.coords.longitude, p.lat, p.lng); if (dd < bd) { bd = dd; best = p; } });
    if (best && bd <= GPS_RADIUS_M) {
      if (best.id !== UI.here && best.id !== UI.lastAuto && AUTH && UI.tab === "run") { UI.lastAuto = best.id; arriveAt(best.id, true); }
    } else if (UI.lastAuto && bd > GPS_RADIUS_M * 2) UI.lastAuto = null;
  }, err => { UI.gps.status = err.code === 1 ? "denied" : "error"; if (UI.tab === "run") render(); },
  { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
}
function gpsLine(onSite) {
  const n = allProps().filter(p => p.lat != null).length;
  if (onSite) return `<div class="gps"><span class="dot"></span>You're on site</div>`;
  const msg = UI.gps.status === "denied" ? "GPS is blocked. Allow location for this app in your phone settings, or pick a property below."
    : UI.gps.status === "none" ? "This phone has no GPS. Pick a property below."
    : !n ? "Property locations aren't set up yet. Pick a property below."
    : "The next stop opens by itself when the truck pulls onto a property.";
  return `<div class="gps"><span class="dot off"></span>GPS: ${UI.gps.status === "on" ? "driving" : UI.gps.status === "waiting" ? "finding you…" : "off"}</div><div class="muted">${msg}</div>`;
}

// ---------- views ----------
function propSelect() {
  const done = new Set((DATA.entries || []).map(a => a.prop_id));
  return `<label class="f bigpick" for="pick-prop">Or choose a property<select id="pick-prop"><option value="">Select a property…</option>${ROUTES.map(r => `<optgroup label="${esc(r.name)}">${r.props.map(p => `<option value="${p.id}" ${p.id === UI.here ? "selected" : ""}>${done.has(p.id) ? "✓ " : ""}${esc(p.addr)}</option>`).join("")}</optgroup>`).join("")}</select></label>`;
}
function fillCard() {
  const mine = DATA.run ? (DATA.fills || []).filter(x => new Date(x.ts) >= new Date(DATA.run.started) - 1000).sort((a, b) => a.ts.localeCompare(b.ts)) : [];
  return `<section class="arrive fillcard"><div class="gps">Salt fill-up</div>
    <div class="muted small">Tap when you load the truck.</div>
    <div class="acts"><button class="btn salt huge" data-fill="bulk">Filled bulk</button><button class="btn walk huge" data-fill="bags">Filled bags</button></div>
    ${mine.length ? `<div class="done-line">✓ Logged</div><div class="logged">${mine.map(x => `<button class="entry" data-fillfix="${x.id}">${esc(fillWord(x))}</button>`).join("")}</div>` : ""}
  </section>`;
}
function myLogCard() {
  const mine = (DATA.run && DATA.entries) || []; if (!mine.length) return "";
  const g = []; mine.slice().sort((a, b) => a.ts.localeCompare(b.ts)).forEach(e => { let x = g.find(y => y.id === e.prop_id); if (!x) g.push(x = { id: e.prop_id, items: [] }); x.items.push(e); });
  return `<section class="panel"><h2>Your log this shift</h2><div class="muted small">${g.length} propert${g.length === 1 ? "y" : "ies"} salted · tap a property to see its log, then tap an entry to fix it</div>
    <div class="proplist">${g.map(x => `<details class="propitem"${UI.openLog === x.id ? " open" : ""} data-log="${x.id}"><summary><span>${esc(propName(x.id))}</span><span class="muted small">${x.items.length} entr${x.items.length === 1 ? "y" : "ies"}</span></summary>
      <div class="logged">${x.items.map(e => `<button class="entry" data-entry="${e.id}">${e.area === "drives" ? "Parking lots" : "Walks"} · ${amtWord(e.amt)}</button>`).join("")}</div></details>`).join("")}</div></section>`;
}
function viewRun() {
  const run = DATA.run;
  const here = UI.here ? PROPS[UI.here] : null;
  if (!run && !here) {
    return `<section class="arrive waiting">${gpsLine(false)}<div class="muted small">Clock in on Home. If you forget, you're clocked in automatically when you log your first salting.</div>${propSelect()}</section>${fillCard()}`;
  }
  const mine = DATA.entries || [];
  const stops = new Set(mine.map(a => a.prop_id)).size, total = allProps().length;
  const hereLogged = here ? mine.filter(a => a.prop_id === here.id).sort((a, b) => a.ts.localeCompare(b.ts)) : [];
  const owner = AUTH.role === "owner";
  const arrival = here ? `<section class="arrive">
      ${gpsLine(true)}
      <div><div class="addr-big">${esc(here.addr)}</div>${here.client ? `<div class="client">${esc(here.client)}</div>` : ""}</div>
      ${hereLogged.length ? `<div class="done-line">✓ Logged</div>
        <div class="logged">${hereLogged.map(e => `<button class="entry" data-entry="${e.id}">${e.area === "drives" ? "Parking lots" : "Walks"} · ${amtWord(e.amt)}</button>`).join("")}</div>` : ""}
      <div class="acts" style="${here.walks ? "" : "grid-template-columns:1fr"}">
        <button class="btn salt huge" data-salted="drives">Salted Parking Lots</button>
        ${here.walks ? `<button class="btn walk huge" data-salted="walks">Salted Walkways</button>` : ""}
      </div>
      ${owner ? `<button class="linkbtn" id="save-spot" style="align-self:flex-start">${here.lat != null ? "Update" : "Save"} GPS location for this property (stand on the lot)</button>` : ""}
    </section>` : `<section class="arrive waiting">${gpsLine(false)}</section>`;
  return `${run ? `<section class="panel"><div class="runbar"><div><h2>${esc(run.crew)}</h2><div class="muted small">Clocked in ${fmtWhen(run.started)} · ${stops} of ${total} stop${total === 1 ? "" : "s"} salted</div></div></div></section>` : ""}
    ${arrival}
    <section class="panel">${propSelect()}</section>
    ${fillCard()}${myLogCard()}`;
}
const dur = ms => { const m = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m`; };
function viewStart() {
  if (UI.report) return viewReport(UI.report);
  const run = DATA.run, owner = AUTH.role === "owner";
  const mine = DATA.entries || [], stops = new Set(mine.map(a => a.prop_id)).size;
  const shift = run
    ? `<section class="arrive shift"><div class="gps"><span class="dot"></span>On the clock</div>
        <div class="clock" id="elapsed" data-since="${esc(run.started)}">${dur(Date.now() - new Date(run.started))}</div>
        <div class="muted small">Clocked in ${fmtWhen(run.started)}</div>
        <button class="btn bad block huge" id="finish">End</button></section>`
    : `<section class="arrive waiting shift"><div class="gps"><span class="dot off"></span>Off the clock</div>
        <div class="muted small">Tap Start when you get in the truck. Tap End when you're done.</div>
        <button class="btn yes block huge" id="start-run">Start</button></section>`;
  let storm = `<div class="muted small">No storm right now</div>`;
  if (DATA.storm) {
    const cm = {}; (DATA.clears || []).forEach(c => { (cm[c.prop_id] = cm[c.prop_id] || {})[c.part] = c; });
    const all = clearable(); const done = all.filter(p => (p.walks ? ["drives", "walks"] : ["drives"]).every(a => (cm[p.id] || {})[a])).length;
    storm = `<div class="small" style="font-weight:600">${esc(DATA.storm.name)}</div><div class="muted small">${done} of ${all.length} cleared</div>`;
  }
  const tiles = `<div class="tiles">
    <button class="tile salt-tile" data-go="run"><span class="tile-h">Salt</span><span class="muted small">${run ? `${stops} stop${stops === 1 ? "" : "s"} salted` : "Log salting"}</span></button>
    <button class="tile clear-tile" data-go="clear"><span class="tile-h">Clearing</span>${storm}</button></div>`;
  const out = owner && (DATA.active_runs || []).length ? `<section class="panel"><h2>On the clock now</h2><div class="small">${DATA.active_runs.map(r => `<b>${esc(r.crew)}</b> · ${dur(Date.now() - new Date(r.started))} since ${hm(r.started)} · ${r.stops} stop${r.stops === 1 ? "" : "s"}`).join("<br>")}</div></section>` : "";
  return `<section class="panel"><h2 style="margin:0">Hi, ${esc(AUTH.name)}</h2></section>${shift}${tiles}${out}`;
}
setInterval(() => { const e = document.getElementById("elapsed"); if (e) e.textContent = dur(Date.now() - new Date(e.dataset.since)); }, 20000);
function viewReport(r) {
  const byProp = []; (r.entries || []).forEach(e => { let g = byProp.find(x => x.id === e.prop_id); if (!g) byProp.push(g = { id: e.prop_id, items: [] }); g.items.push(e); });
  const rows = byProp.map(g => `<div class="sumrow"><div style="font-weight:700">${esc(propName(g.id))}</div><div class="logged">${g.items.map(e => `<span class="entry">${e.area === "drives" ? "Parking lots" : "Walks"} · ${amtWord(e.amt)}${e.note ? " (" + esc(e.note) + ")" : ""}</span>`).join("")}</div></div>`).join("");
  return `<section class="arrive shift"><div class="gps"><span class="dot off"></span>Clocked out</div>
    <div class="muted small" style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Time worked</div>
    <div class="clock">${esc(r.time || "")}</div>
    ${r.started ? `<div class="muted small">${hm(r.started)} to ${hm(r.ended)}</div>` : ""}
    <button class="btn salt block" id="new-run">Done</button></section>
    <section class="panel"><h2>Your log</h2>
      ${rows ? `<div class="muted small">${byProp.length} propert${byProp.length === 1 ? "y" : "ies"} salted</div><div class="sumlist">${rows}</div>` : `<p class="muted" style="margin:0">No salting logged this shift.</p>`}
      ${r.storm ? (() => { const g = []; (r.clears || []).forEach(c => { let x = g.find(y => y.id === c.prop_id); if (!x) g.push(x = { id: c.prop_id, items: [] }); x.items.push(c); });
        return `<h3 style="margin:14px 0 6px">Clearing · ${esc(r.storm)}</h3>` + (g.length ? `<div class="sumlist">${g.map(x => `<div class="sumrow"><div style="font-weight:700">${esc(propName(x.id))}</div><div class="logged">${x.items.map(c => `<span class="entry${c.note ? " badchip" : ""}">${clearWord(c.part)} · ${c.note ? "not fully cleared: " + esc(c.note) : "cleared"}</span>`).join("")}</div></div>`).join("")}</div>` : `<p class="muted" style="margin:0">Nothing checked off.</p>`); })() : ""}
      ${(r.fills || []).length ? `<h3 style="margin:14px 0 6px">Salt fill-ups</h3><div class="logged">${r.fills.map(f => `<span class="entry">${esc(fillWord(f))}</span>`).join("")}</div>` : ""}
    </section>`;
}
function pastStorms() {
  if (AUTH.role !== "owner") return "";
  const list = DATA.past_storms || [];
  const all = clearable(); const parts = p => p.walks ? ["drives", "walks"] : ["drives"];
  return `<section class="panel"><h2>Past storms</h2>${list.length ? list.map(st => {
    const cm = {}; (st.clears || []).forEach(c => { (cm[c.prop_id] = cm[c.prop_id] || {})[c.part] = c; });
    const ok = p => parts(p).every(a => (cm[p.id] || {})[a]); const n = all.filter(ok).length;
    const cell = (p, a) => { if (a === "walks" && !p.walks) return `<td class="nowalk"></td>`; const c = (cm[p.id] || {})[a]; return c ? `<td class="t${c.note ? " badcell" : ""}">${c.note ? "✗" : "✓"} ${md(c.ts)} ${hm(c.ts)} · ${esc(c.crew)}${c.note ? ` · ${esc(c.note)}` : ""}</td>` : `<td class="t muted" style="font-weight:600">Not checked</td>`; };
    return `<details class="storm"><summary><b>${esc(st.name)}</b><span class="muted small">${fmtWhen(st.started)} to ${fmtWhen(st.ended)} · ${n}/${all.length} fully cleared</span></summary>
      <div class="tbl-wrap"><table class="log"><thead><tr><th>Property</th><th>Parking lots</th><th>Walkways</th></tr></thead><tbody>${ROUTES.map(r => `<tr class="rh"><td colspan="3">${esc(r.name)}</td></tr>` + r.props.map(p => `<tr><td>${esc(p.addr)}</td>${saltOnly(p) ? `<td colspan="2" class="muted small">Salt only, no clearing</td>` : cell(p, "drives") + cell(p, "walks")}</tr>`).join("")).join("")}</tbody></table></div></details>`;
  }).join("") : `<p class="muted" style="margin:0">When you end a storm, its checklist is saved here.</p>`}</section>`;
}
function viewClear() {
  const owner = AUTH.role === "owner";
  if (!DATA.storm) return owner ? `<section class="panel"><h2>Storm clearing checklist</h2>
    <p class="muted" style="margin:0">Start a storm and every crew's phone gets the checklist. Crews check off parking lots and walkways at each property as they're cleared.</p>
    <label class="f" for="storm-name">Storm name<input type="text" id="storm-name" placeholder="e.g. Dec 12 storm"></label>
    <button class="btn block" id="storm-start">Start storm</button></section>` + pastStorms()
    : `<section class="arrive waiting"><h2>No storm in progress</h2><div class="muted">The clearing checklist shows up here when a storm is started.</div></section>`;
  const cm = {}; (DATA.clears || []).forEach(c => { (cm[c.prop_id] = cm[c.prop_id] || {})[c.part] = c; });
  const all = clearable(); const parts = p => p.walks ? ["drives", "walks"] : ["drives"];
  const isDone = p => parts(p).every(a => (cm[p.id] || {})[a]); const done = all.filter(isDone).length;
  const box = (p, a) => { const c = (cm[p.id] || {})[a]; return `<label class="ck${c ? " on" : ""}${c && c.note ? " bad" : ""}" for="clr-${p.id}-${a}"><input type="checkbox" id="clr-${p.id}-${a}" data-clear="${p.id}" data-part="${a}" ${c ? "checked" : ""}><span><b>${clearWord(a)}</b>${c ? `<small>${hm(c.ts)} · ${esc(c.crew)}${c.note ? ` · ${esc(c.note)}` : ""}</small>` : ""}</span></label>`; };
  return `<section class="panel"><div class="runbar"><div><h2>${esc(DATA.storm.name)}</h2><div class="muted small">${done} of ${all.length} properties fully cleared · updates live</div></div>${owner ? `<button class="btn ghost" id="storm-end">End storm</button>` : ""}</div>
    <div class="progress"><i style="width:${all.length ? Math.round(done / all.length * 100) : 0}%"></i></div></section>
    ${ROUTES.map(r => `<h3 class="route-h">${esc(r.name)} · ${r.props.filter(p => !saltOnly(p) && isDone(p)).length}/${r.props.filter(p => !saltOnly(p)).length}</h3>` + r.props.map(p => saltOnly(p)
      ? `<div class="clear saltonly"><div style="flex:1;min-width:0"><div style="font-weight:700">${esc(p.addr)}</div>${p.client ? `<div class="muted small">${esc(p.client)}</div>` : ""}<div class="small" style="font-weight:600;margin-top:6px">Salt only · no clearing</div></div></div>`
      : `<div class="clear${isDone(p) ? " done" : ""}${parts(p).some(a => ((cm[p.id] || {})[a] || {}).note) ? " bad" : ""}"><div style="flex:1;min-width:0"><div style="font-weight:700">${esc(p.addr)}</div>${p.client ? `<div class="muted small">${esc(p.client)}</div>` : ""}
        <div class="cks">${parts(p).map(a => box(p, a)).join("")}</div></div></div>`).join("")).join("")}${pastStorms()}`;
}
function viewLogs() {
  const od = UI.ownerData;
  if (!od) { loadOwnerData().then(render); return `<section class="panel"><h2>Main salt log</h2><p class="muted">Loading…</p></section>`; }
  const last = [...od.entries].sort((a, b) => b.ts.localeCompare(a.ts))[0];
  const active = DATA.active_runs || [];
  const rows = dataRows(od).reverse();
  const any = od.entries.length || od.fills.length || od.clear_log.length;
  return `<section class="panel"><div class="runbar"><div><h2>Main salt log</h2><div class="gps" style="margin-top:4px"><span class="dot"></span>Live${last ? ` · last entry ${fmtWhen(last.ts)} by ${esc(last.crew)}` : ""}</div></div></div>
    ${active.length ? `<div class="small">${active.map(r => `<b>${esc(r.crew)}</b> is on the clock · since ${hm(r.started)} · ${r.stops} stop${r.stops === 1 ? "" : "s"} so far`).join("<br>")}</div>` : `<div class="muted small">Nobody is on the clock right now.</div>`}
    <div class="muted small">New entries show up here within a few seconds of a driver tapping Salted. Entries from the last 15 minutes are highlighted.</div>
    <div class="row"><label class="f" for="from">From<input type="date" id="from" value="${UI.from}"></label><label class="f" for="to">To<input type="date" id="to" value="${UI.to}"></label></div>
    <button class="btn salt" id="dl-range" ${any ? "" : "disabled"}>Download Excel log (${od.entries.length} entries)</button></section>
    ${tableHTML(od.entries)}
    <section class="panel"><h2>Salt fill-ups</h2><div class="muted small">When drivers loaded their trucks, newest first.</div>
    ${od.fills.length ? `<div class="tbl-wrap"><table class="log" style="min-width:360px"><thead><tr><th>When</th><th>Driver</th><th>Filled with</th></tr></thead><tbody>${[...od.fills].reverse().map(x => `<tr><td class="t">${md(x.ts)} ${hm(x.ts)}</td><td><b>${esc(x.crew)}</b></td><td>${esc(fillWord(x))}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted" style="margin:0">No fill-ups logged yet.</p>`}</section>
    <section class="panel"><h2>Log data</h2><div class="muted small">Every salt entry and clearing check-off with who did it, newest first.</div>
    ${rows.length ? `<div class="tbl-wrap"><table class="log" style="min-width:600px"><thead><tr><th>When</th><th>Driver</th><th>Type</th><th>Property</th><th>Area</th><th>Detail</th></tr></thead><tbody>${
      rows.slice(0, UI.allFeed ? 99999 : 15).map(r => `<tr><td class="t">${md(r.ts)} ${hm(r.ts)}</td><td><b>${esc(r.crew)}</b></td><td>${r.type}</td><td>${esc(propName(r.prop))}</td><td>${areaWord(r)}</td><td class="t">${esc(r.detail)}</td></tr>`).join("")}</tbody></table></div>
      ${rows.length > 15 && !UI.allFeed ? `<button class="btn ghost" id="all-feed">Show all ${rows.length} entries</button>` : ""}` : `<p class="muted" style="margin:0">Nothing logged yet.</p>`}</section>`;
}
function viewCrew() {
  const ss = DATA.sessions || []; const runs = DATA.active_runs || [];
  const stale = x => Date.now() - new Date(x.last_seen).getTime() > 12 * 3600e3;
  const live = x => !x.signed_out && !stale(x);
  // One box per person: keep their most recent session, preferring one that is still signed in.
  const people = {}; ss.forEach(x => { const k = x.name.trim().toLowerCase(), cur = people[k];
    if (!cur || (live(x) && !live(cur)) || (live(x) === live(cur) && x.last_seen > cur.last_seen)) people[k] = x; });
  const list = Object.values(people).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  const on = list.filter(live), off = list.filter(x => !live(x)).slice(0, 20);
  const row = x => { const run = runs.find(r => r.crew.trim().toLowerCase() === x.name.trim().toLowerCase()); const here = x.here && PROPS[x.here] ? PROPS[x.here].addr : null;
    const isOn = live(x);
    return `<div class="runitem" data-crew="${esc(x.name)}" role="button" tabindex="0"><div style="min-width:0"><b>${esc(x.name)}</b>${x.role === "owner" ? ' <span class="muted small">owner</span>' : ""}
      <div class="muted small">Signed in ${fmtWhen(x.signed_in)}${x.signed_out ? ` · signed out ${fmtWhen(x.signed_out)}` : ` · last seen ${fmtWhen(x.last_seen)}`}</div>
      ${run && isOn ? `<div class="small" style="color:var(--ok);font-weight:600">On the clock · ${run.stops} stop${run.stops === 1 ? "" : "s"}${here ? ` · at ${esc(here)}` : ""}</div>` : ""}</div>
      </div><span class="chev">${isOn ? '<span class="dot"></span>' : ""}›</span></div>`; };
  const located = allProps().filter(p => p.lat != null).length;
  return `<section class="panel"><h2>Signed in now</h2><div class="muted small">${on.length} ${on.length === 1 ? "person" : "people"} signed in</div><div class="runs">${on.map(row).join("") || '<p class="muted">Nobody is signed in.</p>'}</div></section>
    <section class="panel"><h2>Signed out</h2><div class="runs">${off.map(row).join("") || '<p class="muted" style="margin:0">Nobody yet.</p>'}</div></section>
    <section class="panel"><h2>Property GPS locations</h2><div class="muted small">${located} of ${allProps().length} properties have a GPS location. The app uses these to open a stop by itself when a truck pulls in.</div>
      <button class="btn ghost" id="geocode">Find missing locations from addresses</button>
      <div class="muted small">For a spot-on location, stand on the lot, pick the property on the Salt tab and tap "Save GPS location for this property".</div></section>`;
}
function viewHome() {
  const cfgMissing = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
  return `<section class="home">
    <div class="brand">THM Snow</div>
    <div class="muted">Salt and clearing log</div>
    <section class="panel" style="width:100%;text-align:left">
      <label class="f" for="login-name">Your name<input type="text" id="login-name" placeholder="Type your name" autocomplete="name" value="${esc(LS.get("lastName", ""))}"></label>
      <label class="f" for="login-pin">PIN<input type="password" id="login-pin" inputmode="numeric" autocomplete="current-password" placeholder="Crew PIN"></label>
      <button class="btn salt block huge" id="login">Sign in</button>
      ${cfgMissing ? `<div class="err small">This app isn't connected to its database yet.</div>` : ""}
    </section>
  </section>`;
}
function render() {
  const app = document.getElementById("app");
  const tabs = document.querySelector(".tabs"), who = document.getElementById("who-bar");
  if (!AUTH || !DATA) { tabs.hidden = true; who.innerHTML = ""; app.innerHTML = viewHome(); return; }
  buildRoutes();
  tabs.hidden = false;
  who.innerHTML = `<span class="small"><b>${esc(AUTH.name)}</b>${AUTH.role === "owner" ? " · owner" : ""}</span><button class="linkbtn" id="logout">Sign out</button>`;
  const owner = AUTH.role === "owner"; if (!owner && (UI.tab === "logs" || UI.tab === "crew")) UI.tab = "home";
  document.getElementById("tab-logs").hidden = !owner; document.getElementById("tab-crew").hidden = !owner;
  document.querySelector(".tabs .wrap").style.gridTemplateColumns = owner ? "repeat(5,1fr)" : "repeat(3,1fr)";
  app.innerHTML = UI.tab === "home" ? viewStart() : UI.tab === "clear" ? viewClear() : UI.tab === "logs" ? viewLogs() : UI.tab === "crew" ? viewCrew() : viewRun();
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === UI.tab));
  setOnline(UI.online);
}

// ---------- actions ----------
function toast(msg) { const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2800); }
function arriveAt(pid, auto) {
  UI.here = pid; LS.set("here", pid);
  render(); window.scrollTo(0, 0);
  if (auto && navigator.vibrate) navigator.vibrate(200);
  refresh();
}
function modal(html, onClick) { const m = document.getElementById("modal"); m.innerHTML = `<div class="sheet-bg" id="sbg"><div class="sheet" role="dialog">${html}</div></div>`;
  m.onclick = ev => { const t = ev.target; if (t.id === "sbg" || t.id === "cancel") { m.innerHTML = ""; return; } onClick(t, () => { m.innerHTML = ""; }); }; }
function confirmBox(title, body, okLabel, onOk) {
  modal(`<h2>${esc(title)}</h2>${body ? `<p class="muted" style="margin:0">${esc(body)}</p>` : ""}<button class="btn salt block" id="ok">${esc(okLabel)}</button><button class="btn ghost block" id="cancel">Cancel</button>`,
    (t, close) => { if (t.id === "ok") { close(); onOk(); } });
}
async function openCrewHistory(name) {
  modal(`<h2>${esc(name)}</h2><p class="muted" style="margin:0">Loading…</p><button class="btn ghost block" id="cancel">Close</button>`, () => {});
  let h; try { h = await rpc("history", { crew: name }, "crew_history"); } catch (e) { modal(`<h2>${esc(name)}</h2><p class="err">Couldn't load. Check your signal.</p><button class="btn ghost block" id="cancel">Close</button>`, () => {}); return; }
  const shifts = h.shifts || [];
  const total = shifts.filter(r => r.ended && Date.now() - new Date(r.started) < 7 * 864e5).reduce((t, r) => t + (new Date(r.ended) - new Date(r.started)), 0);
  const row = r => `<div class="shiftrow"><div><b>${md(r.started)}</b> · in ${hm(r.started)} · ${r.ended ? "out " + hm(r.ended) : '<b style="color:var(--ok)">on now</b>'}</div><div class="muted small">${dur((r.ended ? new Date(r.ended) : Date.now()) - new Date(r.started))} worked · ${r.stops} stop${r.stops === 1 ? "" : "s"} salted</div></div>`;
  modal(`<h2>${esc(name)}</h2><div class="muted small" style="margin-top:-8px">Time worked, last 7 days: <b>${dur(total)}</b></div>
    <h3 style="margin:4px 0 0">Clock in / out</h3>
    ${shifts.length ? `<div class="shiftlist">${shifts.map(row).join("")}</div>` : `<p class="muted" style="margin:0">No clock-ins yet.</p>`}
    <details><summary class="muted small">App sign-ins (${(h.sessions || []).length})</summary><div class="small" style="margin-top:6px">${(h.sessions || []).map(x => `${fmtWhen(x.signed_in)} to ${x.signed_out ? fmtWhen(x.signed_out) : "still signed in"}`).join("<br>")}</div></details>
    <button class="btn ghost block" id="cancel">Close</button>`, () => {});
}
function openClearCheck(pid, part) {
  const p = PROPS[pid], storm = DATA.storm; if (!p || !storm) return;
  const ask = part === "drives" ? "Make sure the whole parking lot is clear." : "Make sure all doors, walks, and the dumpster area are fully cleared.";
  modal(`<div class="muted small" style="text-transform:uppercase;letter-spacing:.08em;font-weight:700">${clearWord(part)}</div><h2 style="margin-top:-8px">Fully cleared?</h2><div class="muted small" style="margin-top:-8px">${esc(p.addr)}</div>
    <p style="margin:0;font-weight:600">${ask}</p>
    <div class="clgrid"><button class="btn yes huge" id="cl-yes">Yes, fully cleared</button><button class="btn bad huge" id="cl-no">Couldn't fully clear</button></div>
    <div id="cl-note-wrap" class="notewrap" hidden><label class="f" for="cl-note">What couldn't be cleared?<textarea id="cl-note" rows="3" placeholder="e.g. cars parked in back row, dumpster blocked"></textarea></label>
      <button class="btn salt block" id="cl-save">Check off with note</button></div>
    <button class="btn ghost block" id="cancel">Cancel</button>`, (x, close) => {
    const go = note => { close(); if (!DATA.storm || DATA.storm.id !== storm.id) return;
      if (!DATA.run) send("start_run", { id: uuid(), ts: nowIso() });
      send("clear", { storm_id: storm.id, prop_id: pid, part, checked: true, note, ts: nowIso() }); toast(note ? "Checked off with note" : "Checked off"); };
    if (x.id === "cl-yes") go("");
    else if (x.id === "cl-no") { document.getElementById("cl-note-wrap").hidden = false; document.getElementById("cl-note").focus(); }
    else if (x.id === "cl-save") { const n = document.getElementById("cl-note").value.trim(); if (!n) { toast("Add a note about what couldn't be cleared"); return; } go(n); }
  });
}
function openQuick(pid, area) {
  const p = PROPS[pid];
  modal(`<div class="muted small" style="text-transform:uppercase;letter-spacing:.08em;font-weight:700">${area === "drives" ? "Parking lots" : "Walkways"}</div><h2 style="margin-top:-8px">How much?</h2><div class="muted small" style="margin-top:-8px">${esc(p.addr)}</div>
    <div class="qgrid"><button class="btn salt huge" data-q="1">Full</button><button class="btn salt huge" data-q="0.5">Half</button><button class="btn ghost huge" data-q="custom">Custom</button></div>
    <div id="custom-wrap" hidden><div class="row"><label class="f" for="q-other">Fraction<input type="number" id="q-other" step="0.05" min="0.05" max="1" placeholder=".3" inputmode="decimal"></label><button class="btn salt" id="q-log" style="align-self:end">Log it</button></div></div>
    <details><summary class="muted small">Add a note</summary><input type="text" id="q-note" placeholder="e.g. back, extra removal time" style="margin-top:8px"></details>
    <button class="btn ghost block" id="cancel">Cancel</button>`, (t, close) => {
    const log = amt => { const note = (document.getElementById("q-note").value || "").trim(); close();
      if (!DATA.run) send("start_run", { id: uuid(), ts: nowIso() });
      send("salt", { id: uuid(), run_id: DATA.run ? DATA.run.id : null, prop_id: p.id, area, amt, note, ts: nowIso() });
      toast(`Logged ${area === "drives" ? "parking lots" : "walkways"} · ${amtWord(amt)}`); };
    const q = t.closest("[data-q]");
    if (q) { if (q.dataset.q === "custom") { document.getElementById("custom-wrap").hidden = false; document.getElementById("q-other").focus(); } else log(+q.dataset.q); return; }
    if (t.id === "q-log") { const v = parseFloat(document.getElementById("q-other").value); if (!(v > 0 && v <= 1)) { toast("Enter a fraction between .05 and 1"); return; } log(v); }
  });
}
function openEdit(e) {
  const p = PROPS[e.prop_id]; let amt = +e.amt; const presets = [[1, "Full"], [0.5, "Half"]];
  const isPreset = presets.some(x => x[0] === amt);
  modal(`<div class="muted small" style="text-transform:uppercase;letter-spacing:.08em;font-weight:700">Fix ${e.area === "drives" ? "parking lots" : "walkways"}</div><h2>${esc(p ? p.addr : e.prop_id)}</h2>
    <div class="amts" style="grid-template-columns:repeat(3,1fr)">${presets.map(([v, l]) => `<button class="amt${amt === v ? " on" : ""}" data-amt="${v}">${l}</button>`).join("")}<button class="amt${isPreset ? "" : " on"}" data-amt="other">Custom</button></div>
    <label class="f" for="amt-other" id="other-wrap" ${isPreset ? "hidden" : ""}>Fraction<input type="number" id="amt-other" step="0.05" min="0.05" max="1" value="${isPreset ? "" : amt}" inputmode="decimal"></label>
    <label class="f" for="note">Note<input type="text" id="note" value="${esc(e.note || "")}"></label>
    <button class="btn salt block" id="save-entry">Save changes</button>
    <div class="row"><button class="btn ghost" id="del-entry">Remove entry</button><button class="btn ghost" id="cancel">Cancel</button></div>`, (t, close) => {
    const ab = t.closest("[data-amt]");
    if (ab) { document.querySelectorAll(".amt").forEach(x => x.classList.toggle("on", x === ab)); const o = ab.dataset.amt === "other"; document.getElementById("other-wrap").hidden = !o; if (!o) amt = +ab.dataset.amt; return; }
    if (t.id === "del-entry") { close(); send("salt_delete", { id: e.id }); toast("Entry removed"); return; }
    if (t.id === "save-entry") {
      if (!document.getElementById("other-wrap").hidden) { const v = parseFloat(document.getElementById("amt-other").value); if (!(v > 0 && v <= 1)) { toast("Enter a fraction between .05 and 1"); return; } amt = v; }
      close(); send("salt_edit", { id: e.id, amt, note: document.getElementById("note").value.trim(), ts: e.ts }); toast("Entry updated");
    }
  });
}
function logFill(kind, bags, yard) {
  if (!DATA.run) send("start_run", { id: uuid(), ts: nowIso() });
  send("fill", { id: uuid(), kind, bags: bags || null, yard, run_id: DATA.run ? DATA.run.id : null, ts: nowIso() });
  toast(kind === "bulk" ? `Logged bulk · ${yard}` : `Logged ${bags} bags · ${yard}`);
}
async function signIn() {
  const name = document.getElementById("login-name").value.trim(), pin = document.getElementById("login-pin").value.trim();
  if (!name) { toast("Type your name first"); return; }
  if (!pin) { toast("Enter your PIN"); return; }
  const btn = document.getElementById("login"); btn.disabled = true; btn.textContent = "Signing in…";
  AUTH = { name, pin, session: uuid() };
  try {
    const r = await rpc("login", { session: AUTH.session }); AUTH.role = r.role;
    DATA = await rpc("state", { session: AUTH.session });
    LS.set("auth", AUTH); LS.set("data", DATA); LS.set("lastName", name);
    UI.tab = "home"; LS.set("tab", "home"); UI.here = null; LS.del("here"); buildRoutes(); render(); startGps();
  } catch (e) {
    AUTH = null; btn.disabled = false; btn.textContent = "Sign in";
    toast(e.code === "bad_pin" ? "That PIN isn't right." : e.code === "network" ? "No signal. Try again when you have service." : e.code === "config" ? "The app isn't connected to its database yet." : "Couldn't sign in (" + e.code + ").");
  }
}
function signOutLocal(msg) { AUTH = null; DATA = null; OUTBOX = []; LS.del("auth"); LS.del("data"); LS.set("outbox", []); LS.del("here"); UI.here = null; UI.ownerData = null; render(); if (msg) toast(msg); }
async function geocodeMissing(btn) {
  const missing = allProps().filter(p => p.lat == null); if (!missing.length) { toast("Every property already has a location."); return; }
  btn.disabled = true; let found = 0;
  for (let i = 0; i < missing.length; i++) {
    const p = missing[i]; btn.textContent = `Looking up ${i + 1} of ${missing.length}…`;
    const q = p.addr.replace(/Smtihfield/i, "Smithfield").replace(/\bGW\b/, "George Washington Hwy");
    try {
      const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=" + encodeURIComponent(q + (/RI\b|MA\b/.test(q) ? "" : ", RI")));
      const j = await r.json();
      if (j[0]) { await rpc("set_coords", { prop_id: p.id, lat: +j[0].lat, lng: +j[0].lon }); found++; }
    } catch (e) {}
    await new Promise(res => setTimeout(res, 1100)); // free lookup service allows 1 per second
  }
  toast(`Found ${found} of ${missing.length}. Save the rest on site.`); await refresh();
}

// ---------- events ----------
document.getElementById("who-bar").addEventListener("click", ev => {
  if (ev.target.id !== "logout") return;
  if (DATA && DATA.run) { UI.tab = "home"; LS.set("tab", "home"); UI.report = null; render(); window.scrollTo(0, 0); toast("Clock out first: tap End");
    const e = document.getElementById("finish"); if (e) { e.classList.add("pulse"); setTimeout(() => e.classList.remove("pulse"), 2400); } return; }
  confirmBox("Sign out?", "You'll need your name and PIN to sign back in.", "Sign out", async () => {
    try { await rpc("logout", { session: AUTH.session }); } catch (e) {}
    signOutLocal();
  });
});
document.querySelector(".tabs").addEventListener("click", ev => { const b = ev.target.closest("[data-tab]"); if (!b) return; UI.tab = b.dataset.tab; LS.set("tab", UI.tab); if (UI.tab === "logs") UI.ownerData = UI.ownerData; render(); window.scrollTo(0, 0); if (UI.tab === "logs") loadOwnerData().then(render); });
const app = document.getElementById("app");
app.addEventListener("keydown", ev => { if (ev.key === "Enter" && (ev.target.id === "login-name" || ev.target.id === "login-pin")) signIn(); });
app.addEventListener("change", ev => {
  const t = ev.target;
  if (t.id === "pick-prop" && t.value) { arriveAt(t.value); return; }
  if (t.id === "from" || t.id === "to") { UI[t.id] = t.value; UI.ownerData = null; render(); return; }
  if (t.dataset.clear) {
    if (!DATA.storm) return;
    if (!t.checked) { send("clear", { storm_id: DATA.storm.id, prop_id: t.dataset.clear, part: t.dataset.part, checked: false, ts: nowIso() }); return; }
    t.checked = false; openClearCheck(t.dataset.clear, t.dataset.part);
  }
});
app.addEventListener("toggle", ev => { const d = ev.target; if (d.dataset && d.dataset.log) { if (d.open) UI.openLog = d.dataset.log; else if (UI.openLog === d.dataset.log) UI.openLog = null; } }, true);
app.addEventListener("pointerdown", ev => { const b = ev.target.closest(".btn,.tile"); if (!b) return; b.classList.add("pressed"); if (navigator.vibrate && b.closest(".shift,.tiles")) navigator.vibrate(15); setTimeout(() => b.classList.remove("pressed"), 160); });
app.addEventListener("click", ev => {
  const cr = ev.target.closest("[data-crew]"); if (cr) { openCrewHistory(cr.dataset.crew); return; }
  const t = ev.target.closest("button"); if (!t) return;
  if (t.id === "login") { signIn(); return; }
  if (t.dataset.salted) { openQuick(UI.here, t.dataset.salted); return; }
  if (t.dataset.entry) { const e = DATA.entries.find(a => a.id === t.dataset.entry); if (e) openEdit(e); return; }
  if (t.id === "finish") { confirmBox("End your shift?", "", "End", () => {
      const mine = DATA.entries || [];
      UI.report = { time: dur(Date.now() - new Date(DATA.run.started)), started: DATA.run.started, ended: nowIso(), crew: DATA.run.crew, entries: mine.slice().sort((a, b) => a.ts.localeCompare(b.ts)),
        fills: (DATA.fills || []).filter(f => new Date(f.ts) >= new Date(DATA.run.started) - 1000).sort((a, b) => a.ts.localeCompare(b.ts)),
        storm: DATA.storm ? DATA.storm.name : null,
        clears: DATA.storm ? (DATA.clears || []).filter(c => c.crew.trim().toLowerCase() === AUTH.name.trim().toLowerCase()).sort((a, b) => a.ts.localeCompare(b.ts)) : [] };
      send("finish_run", { id: DATA.run.id, ts: nowIso() }); UI.here = null; LS.del("here"); render(); window.scrollTo(0, 0); }); return; }
  if (t.id === "new-run") { UI.report = null; render(); return; }
  if (t.id === "start-run") { if (!DATA.run) send("start_run", { id: uuid(), ts: nowIso() }); startGps(); render(); toast("You're on the clock"); return; }
  if (t.dataset.go) { setTimeout(() => { UI.tab = t.dataset.go; LS.set("tab", UI.tab); render(); window.scrollTo(0, 0); }, 140); return; }
  if (t.id === "save-spot") {
    const pos = UI.gps.pos; if (!pos) { toast("Waiting for GPS. Make sure location is allowed."); startGps(); return; }
    rpc("set_coords", { prop_id: UI.here, lat: pos.lat, lng: pos.lng }).then(() => { toast("Location saved for this property"); refresh(); }).catch(() => toast("Couldn't save the location. Try again with signal."));
    return;
  }
  if (t.id === "dl-range") { exportXlsx(UI.ownerData); return; }
  if (t.id === "all-feed") { UI.allFeed = true; render(); return; }
  if (t.id === "geocode") { geocodeMissing(t); return; }
  if (t.id === "storm-start") { const n = document.getElementById("storm-name").value.trim();
    rpc("storm_start", { name: n }).then(() => { toast("Storm started. Crews can see the checklist now."); refresh(); }).catch(() => toast("Couldn't start the storm. Check your signal.")); return; }
  if (t.id === "storm-end") { confirmBox("End this storm?", "Its checklist is saved under Past storms, and a fresh one is ready for the next storm.", "End storm",
    () => rpc("storm_end", {}).then(() => { toast("Storm ended"); refresh(); }).catch(() => toast("Couldn't end the storm. Check your signal."))); return; }
  if (t.dataset.fill === "bulk") {
    modal(`<h2>Filled bulk</h2><div class="muted small" style="margin-top:-8px">Which yard?</div>
      <div class="locs">${YARDS_BULK.map(l => `<button class="btn salt huge" data-loc="${l}">${l}</button>`).join("")}</div>
      <button class="btn ghost block" id="cancel">Cancel</button>`, (x, close) => { const l = x.closest("[data-loc]"); if (l) { close(); logFill("bulk", null, l.dataset.loc); } });
    return;
  }
  if (t.dataset.fill === "bags") {
    modal(`<h2>Filled bags</h2>
      <label class="f" for="bag-count">How many bags?<select id="bag-count"><option value="">Select…</option>${Array.from({ length: 50 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}</select></label>
      <div class="muted small" style="font-weight:600">Which yard?</div>
      <div class="locs">${YARDS_BAGS.map(l => `<button class="btn walk huge" data-bagloc="${l}">${l}</button>`).join("")}</div>
      <button class="btn ghost block" id="cancel">Cancel</button>`, (x, close) => {
      const bl = x.closest("[data-bagloc]"); if (!bl) return;
      const n = +document.getElementById("bag-count").value; if (!n) { toast("Pick how many bags first"); return; }
      close(); logFill("bags", n, bl.dataset.bagloc);
    });
    return;
  }
  if (t.dataset.fillfix) { const x = DATA.fills.find(f => f.id === t.dataset.fillfix); if (!x) return;
    confirmBox("Remove this fill-up?", `${fillWord(x)} at ${hm(x.ts)}. Remove it if it was tapped by mistake.`, "Remove", () => { send("fill_delete", { id: x.id }); toast("Fill-up removed"); }); }
});

// ---------- start ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
if (AUTH) { startGps(); flush(); }

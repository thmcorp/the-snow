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
  report: null, maps: null, online: true, ownerData: null, gps: { status: "off", pos: null }, lastAuto: null, flushing: false };

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
    case "fill": case "empty": if (!DATA.fills.some(f => f.id === d.id)) DATA.fills.push({ ...d, crew: AUTH.name }); break;
    case "fill_edit": DATA.fills.forEach(f => { if (f.id === d.id) { if (d.yard) f.yard = d.yard; if (d.bags != null) f.bags = d.bags; } }); break;
    case "fill_delete": DATA.fills = DATA.fills.filter(f => f.id !== d.id); break;
    case "clear":
      { const old = (DATA.clears || []).find(c => c.prop_id === d.prop_id && c.part === d.part);
      DATA.clears = (DATA.clears || []).filter(c => !(c.prop_id === d.prop_id && c.part === d.part));
      if (d.checked) { const x = { storm_id: d.storm_id, prop_id: d.prop_id, part: d.part, crew: AUTH.name, ts: d.ts, note: d.note || "" };
        if (!x.note && old && (old.note || old.was_note)) { x.was_note = old.note || old.was_note; x.was_ts = old.note ? old.ts : old.was_ts; x.was_crew = old.note ? old.crew : old.was_crew; }
        DATA.clears.push(x); } }
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
      try { await rpc(item.action, item.data, item.action === "empty" ? "log_empty" : item.action === "shift_note" ? "shift_note" : item.action === "fill_edit" ? "fill_edit" : undefined); setOnline(true); }
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
function loadMaps() { rpc("list", {}, "site_map").then(l => { const k = JSON.stringify(l || []); if (k !== JSON.stringify(UI.maps || [])) { UI.maps = l || []; LS.set("maps", UI.maps); render(); } }).catch(() => {}); }
async function refresh() {
  if (!AUTH) return;
  try {
    const st = await rpc("state", { session: AUTH.session, here: UI.here || null });
    DATA = st; OUTBOX.forEach(applyLocal); LS.set("data", DATA);
    loadMaps();
    if (AUTH.role !== st.role) { AUTH.role = st.role; LS.set("auth", AUTH); }
    setOnline(true);
    if (AUTH.role === "owner" && UI.tab === "logs") await loadOwnerData();
  } catch (e) {
    if (e.code === "bad_pin") { signOutLocal("Your PIN changed. Sign in again."); return; }
    if (e.code === "signed_out_by_owner") { signOutLocal("You were clocked out and signed out by the owner."); return; }
    setOnline(false);
  }
  buildRoutes();
  if (!document.getElementById("modal").innerHTML && !isTyping()) render();
}
async function loadOwnerData() {
  try { const od = await rpc("owner_data", { from: UI.from || null, to: UI.to || null });
    try { od.notes = await rpc("list", { from: UI.from || null, to: UI.to || null }, "shift_note"); } catch (e) { od.notes = (UI.ownerData && UI.ownerData.notes) || []; }
    UI.ownerData = od; }
  catch (e) { if (!UI.ownerData) UI.ownerData = { entries: [], fills: [], clear_log: [], notes: [] }; }
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
  return `<div class="tbl-wrap"><table class="log"><thead><tr><th>Property</th><th>Salt Parking Lot(s)</th><th>Salt Walks</th></tr></thead><tbody>${
    sheetRows(entries).map(r => r.heading ? `<tr class="rh"><td colspan="3">${esc(r.heading)}</td></tr>` :
      `<tr><td>${esc(r.prop)}</td><td class="t${r.fd ? " fresh" : ""}">${esc(r.drives)}</td>${r.nowalk ? `<td class="nowalk" title="No walkway salting"></td>` : `<td class="t${r.fw ? " fresh" : ""}">${esc(r.walks)}</td>`}</tr>`).join("")}</tbody></table></div>`;
}
function dataRows(od) {
  const salt = od.entries.map(a => ({ ts: a.ts, crew: a.crew, type: "Salt", prop: a.prop_id, area: a.area, detail: amtWord(a.amt) + (a.note ? " · " + a.note : "") }));
  const clr = od.clear_log.map(c => ({ ts: c.ts, crew: c.crew, type: "Clearing", prop: c.prop_id, area: c.part, detail: (c.checked ? (c.note ? "Checked, not fully cleared: " + c.note : c.was_note ? `RETURN TRIP: fully cleared (not fully cleared at ${hm(c.was_ts)}${c.was_crew ? " by " + c.was_crew : ""}: ${c.was_note})` : "Checked cleared") : "Unchecked") + (c.storm_name ? " · " + c.storm_name : "") }));
  const nt = (od.notes || []).map(n => ({ ts: n.ts, crew: n.crew, type: "Shift note", prop: "", area: "", detail: n.note }));
  return [...salt, ...clr, ...nt].sort((a, b) => a.ts.localeCompare(b.ts));
}
const fillWord = x => x.kind && x.kind.startsWith("left") ? `Left on truck · ${x.kind === "left_bulk" ? "sander" : "bags"}${x.note ? " · " + x.note : ""}` : x.kind && x.kind.startsWith("empty") ? `Emptied ${x.kind === "empty_bulk" ? "sander" : "bags"}${x.yard ? " · " + x.yard : ""}${x.note ? " · " + x.note : ""}` : x.kind === "bulk" ? `Sander${x.yard ? " · " + x.yard : ""}` : `Bags · ${x.bags || "?"}${x.yard ? " · " + x.yard : ""}`;
const areaWord = r => r.area === "walks" ? "Walkways" : r.area === "" ? "" : "Parking Lot(s)";
const clearWord = a => a === "drives" ? "Parking Lot(s)" : "Walkways";
const propName = id => (PROPS[id] ? PROPS[id].addr : id);
function rangeName(od) {
  const ts = [...od.entries, ...od.fills, ...od.clear_log].map(a => a.ts).sort();
  if (!ts.length) return "Salt log";
  const f = t => { const d = new Date(t); return `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(2)}`; };
  const a = f(ts[0]), b = f(ts[ts.length - 1]); return a === b ? a : `${a} - ${b}`;
}
function exportXlsx(od) {
  if (typeof XLSX === "undefined") { toast("Excel export didn't load. Check your connection and try again."); return; }
  const aoa = [["Property", "", "Salt Parking Lot(s)", "Salt Walks"], []];
  sheetRows(od.entries).forEach(r => { if (r.heading) { if (aoa.length > 2) aoa.push([]); aoa.push([r.heading]); aoa.push([]); } else aoa.push([r.prop, "", r.drives, r.nowalk ? "" : r.walks]); });
  const ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = [{ wch: 60 }, { wch: 2 }, { wch: 70 }, { wch: 55 }];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Main log");
  const fl = [["Date", "Time", "Driver", "Filled with", "Bags", "Yard", "Notes"], ...od.fills.map(x => [md(x.ts), hm(x.ts), x.crew, x.kind === "bulk" ? "Sander" : x.kind === "bags" ? "Bags" : x.kind === "empty_bulk" ? "Emptied sander" : x.kind === "empty_bags" ? "Emptied bags" : x.kind === "left_bulk" ? "Left on truck (sander)" : "Left on truck (bags)", x.bags || "", x.yard || "", x.note || ""])];
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
  return `<section class="arrive fillcard"><div class="gps fillhead">Salt fill-up</div>
    <div class="muted small" style="font-weight:600">Tap when you load the truck.</div>
    <div class="acts"><button class="btn salt huge" data-fill="bulk">Sander</button><button class="btn walk huge" data-fill="bags">Bags</button></div>
    ${mine.length ? `<div class="muted small" style="font-weight:600">Fill-ups this shift (tap to fix)</div><div class="logged">${mine.map(x => `<button class="entry" data-fillfix="${x.id}">${esc(fillWord(x).replace(/^(Sander|Bags)/, m => m + " · " + hm(x.ts)))}</button>`).join("")}</div>` : ""}
  </section>`;
}
const mapsQ = p => p.lat != null ? `${p.lat},${p.lng}` : p.addr.replace(/Smtihfield/i, "Smithfield").replace(/\bGW\b/, "George Washington Hwy");
const mapsBtns = p => { const q = encodeURIComponent(mapsQ(p)), a = encodeURIComponent(p.addr.replace(/Smtihfield/i, "Smithfield"));
  const ua = navigator.userAgent, ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1), android = /Android/.test(ua);
  const href = ios ? `https://maps.apple.com/?daddr=${q}&q=${a}` : android ? `geo:0,0?q=${q}` : `https://www.google.com/maps/dir/?api=1&destination=${q}`;
  return `<a class="btn yes huge"${android ? "" : ' target="_blank" rel="noopener"'} href="${href}">Go</a>`; };
const hasMap = id => (UI.maps || LS.get("maps") || []).includes(id);
const siteBtns = p => `<div class="sitebtns"><button class="btn yes sm" data-maps="${p.id}">Directions</button>${hasMap(p.id) ? `<button class="btn walk sm" data-sitemap="${p.id}">Site Map</button>` : ""}</div>`;
async function openSiteMap(pid) {
  const p = PROPS[pid]; if (!p) return;
  modal(`<h2>Site Map</h2><div style="font-weight:600;margin-top:-8px">${esc(p.addr)}</div><p class="muted" style="margin:0">Loading…</p><button class="btn ghost block" id="cancel">Close</button>`, () => {});
  let r; try { r = await rpc("get", { prop_id: pid }, "site_map"); } catch (e) { r = null; }
  if (!r || !r.img) { modal(`<h2>Site Map</h2><p class="err">Couldn't load the site map. Check your signal.</p><button class="btn ghost block" id="cancel">Close</button>`, () => {}); return; }
  const v = document.createElement("div"); v.className = "mapview";
  v.innerHTML = `<div class="mapbar"><div><b>${esc(p.addr)}</b><div class="small">Pinch to zoom</div></div><button class="btn ghost sm" id="mapclose">Close</button></div><div class="mapscroll"><img alt="Site map for ${esc(p.addr)}" src="${r.img}"></div>`;
  document.getElementById("modal").innerHTML = ""; document.body.appendChild(v);
  v.querySelector("#mapclose").onclick = () => v.remove();
}
function pickSiteMap(pid) {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
  inp.onchange = () => { const f = inp.files[0]; if (!f) return; const img = new Image(); const url = URL.createObjectURL(f);
    img.onload = async () => { const max = 2200, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      const data = c.toDataURL("image/jpeg", 0.82); toast("Uploading site map…");
      try { await rpc("save", { prop_id: pid, img: data }, "site_map"); UI.maps = [...new Set([...(UI.maps || []), pid])]; LS.set("maps", UI.maps); toast("Site map saved"); render(); }
      catch (e) { toast("Couldn't upload. Check your signal and try again."); } };
    img.onerror = () => toast("That file isn't a picture. Send a photo or screenshot of the site map.");
    img.src = url; };
  inp.click();
}
function openMaps(pid) {
  const p = PROPS[pid]; if (!p) return;
  modal(`<h2>Directions</h2><div style="font-weight:600;margin-top:-8px">${esc(p.addr)}</div><div class="gogrid">${mapsBtns(p)}</div><button class="btn ghost block" id="cancel">Cancel</button>`, (t, close) => { if (t.closest("a")) setTimeout(close, 300); });
}
function clockBar() {
  const run = DATA && DATA.run; if (!run) return "";
  return `<section class="panel clockbar"><div><h2 style="margin:0">${esc(run.crew)}</h2><div class="muted small">Clocked in ${fmtWhen(run.started)}</div></div><div class="clock-sm elapsed" data-since="${esc(run.started)}">${dur(Date.now() - new Date(run.started))}</div></section>`;
}
function myLogCard() {
  const mine = (DATA.run && DATA.entries) || []; if (!mine.length) return "";
  const g = []; mine.slice().sort((a, b) => a.ts.localeCompare(b.ts)).forEach(e => { let x = g.find(y => y.id === e.prop_id); if (!x) g.push(x = { id: e.prop_id, items: [] }); x.items.push(e); });
  return `<section class="panel"><h2>Shift Log</h2><div class="muted small">${g.length} propert${g.length === 1 ? "y" : "ies"} salted · tap a property to see its log, then tap an entry to fix it</div>
    <div class="proplist">${g.map(x => `<details class="propitem"${UI.openLog === x.id ? " open" : ""} data-log="${x.id}"><summary><span>${esc(propName(x.id))}</span><span class="muted small">${x.items.length} entr${x.items.length === 1 ? "y" : "ies"}</span></summary>
      <div class="logged">${x.items.map(e => `<button class="entry" data-entry="${e.id}">${e.area === "drives" ? "Parking Lot(s)" : "Walks"} · ${hm(e.ts)} · ${amtWord(e.amt)}${e.note ? " · " + esc(e.note) : ""}</button>`).join("")}</div>
      <button class="btn ghost block" data-lognote="${x.id}" style="margin-top:8px">${x.items.some(e => e.note) ? "Edit note" : "Add note"}</button></details>`).join("")}</div></section>`;
}
function viewRun() {
  const run = DATA.run;
  const here = UI.here ? PROPS[UI.here] : null;
  if (!run && !here) {
    return `<section class="arrive waiting saltcard"><div class="apphead">Salt Applications</div>${gpsLine(false)}<div class="muted small">Clock in on Home. If you forget, you're clocked in automatically when you log your first salting.</div>${propSelect()}</section>${fillCard()}`;
  }
  const mine = DATA.entries || [];
  const stops = new Set(mine.map(a => a.prop_id)).size, total = allProps().length;
  const hereLogged = here ? mine.filter(a => a.prop_id === here.id).sort((a, b) => a.ts.localeCompare(b.ts)) : [];
  const owner = AUTH.role === "owner";
  const arrival = here ? `<section class="arrive saltcard"><div class="apphead">Salt Applications</div>
      ${gpsLine(true)}
      <div><div class="addr-big">${esc(here.addr)}</div>${here.client ? `<div class="client">${esc(here.client)}</div>` : ""}</div>
      ${hereLogged.length ? `<div class="logged">${hereLogged.map(e => `<button class="entry" data-entry="${e.id}">${e.area === "drives" ? "Parking Lot(s)" : "Walks"} · ${hm(e.ts)} · ${amtWord(e.amt)}</button>`).join("")}</div>` : ""}
      <div class="acts" style="${here.walks ? "" : "grid-template-columns:1fr"}">
        <button class="btn salt huge" data-salted="drives">Salted Parking Lot(s)</button>
        ${here.walks ? `<button class="btn walk huge" data-salted="walks">Salted Walkways</button>` : ""}
      </div>
      ${owner ? `<button class="linkbtn" id="save-spot" style="align-self:flex-start">${here.lat != null ? "Update" : "Save"} GPS location for this property (stand on the lot)</button>` : ""}
    </section>` : `<section class="arrive waiting saltcard"><div class="apphead">Salt Applications</div>${gpsLine(false)}</section>`;
  return `${clockBar()}
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
        <div class="clock elapsed" data-since="${esc(run.started)}">${dur(Date.now() - new Date(run.started))}</div>
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
  const dp = UI.dirProp && PROPS[UI.dirProp];
  const dir = `<section class="panel"><h2>Directions</h2><label class="f bigpick" for="dir-prop">Pick a property<select id="dir-prop"><option value="">Select a property…</option>${ROUTES.map(r => `<optgroup label="${esc(r.name)}">${r.props.map(p => `<option value="${p.id}" ${p.id === UI.dirProp ? "selected" : ""}>${esc(p.addr)}</option>`).join("")}</optgroup>`).join("")}</select></label>${dp ? (hasMap(dp.id) ? `<div class="gogrid stack">${mapsBtns(dp)}<button class="btn walk huge" data-sitemap="${dp.id}">Site Map</button></div>` : `<div class="gogrid">${mapsBtns(dp)}</div>`) + (owner ? `<div class="row"><button class="btn ghost" data-mapup="${dp.id}">${hasMap(dp.id) ? "Replace site map" : "Upload site map"}</button>${hasMap(dp.id) ? `<button class="btn ghost" data-maprm="${dp.id}">Remove</button>` : ""}</div>` : "") : ""}</section>`;
  return `<section class="panel"><h2 style="margin:0">Hi, ${esc(AUTH.name)}</h2></section>${shift}${tiles}${dir}${out}`;
}
setInterval(() => document.querySelectorAll(".elapsed").forEach(e => { e.textContent = dur(Date.now() - new Date(e.dataset.since)); }), 20000);
function viewReport(r) {
  const byProp = []; (r.entries || []).forEach(e => { let g = byProp.find(x => x.id === e.prop_id); if (!g) byProp.push(g = { id: e.prop_id, items: [] }); g.items.push(e); });
  const rows = byProp.map(g => `<div class="sumrow"><div style="font-weight:700">${esc(propName(g.id))}</div><div class="logged">${g.items.map(e => `<span class="entry">${e.area === "drives" ? "Parking Lot(s)" : "Walks"} · ${amtWord(e.amt)}${e.note ? " (" + esc(e.note) + ")" : ""}</span>`).join("")}</div></div>`).join("");
  return `<section class="arrive shift"><div class="gps"><span class="dot off"></span>Clocked out</div>
    <div class="muted small" style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Time worked</div>
    <div class="clock">${esc(r.time || "")}</div>
    ${r.started ? `<div class="muted small">${hm(r.started)} to ${hm(r.ended)}</div>` : ""}
    <button class="btn salt block" id="new-run">Done</button></section>
    <section class="panel"><h2>Your log</h2>
      ${rows ? `<div class="muted small">${byProp.length} propert${byProp.length === 1 ? "y" : "ies"} salted</div><div class="sumlist">${rows}</div>` : `<p class="muted" style="margin:0">No salting logged this shift.</p>`}
      ${r.storm ? (() => { const g = []; (r.clears || []).forEach(c => { let x = g.find(y => y.id === c.prop_id); if (!x) g.push(x = { id: c.prop_id, items: [] }); x.items.push(c); });
        return `<h3 style="margin:14px 0 6px">Clearing · ${esc(r.storm)}</h3>` + (g.length ? `<div class="sumlist">${g.map(x => `<div class="sumrow"><div style="font-weight:700">${esc(propName(x.id))}</div><div class="logged">${x.items.map(c => `<span class="entry${c.note ? " badchip" : ""}">${clearWord(c.part)} · ${c.note ? "not fully cleared: " + esc(c.note) : "cleared"}</span>`).join("")}</div></div>`).join("")}</div>` : `<p class="muted" style="margin:0">Nothing checked off.</p>`); })() : ""}
      ${r.note ? `<h3 style="margin:14px 0 6px">Your notes</h3><p style="margin:0;white-space:pre-wrap">${esc(r.note)}</p>` : ""}
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
    const cell = (p, a) => { if (a === "walks" && !p.walks) return `<td class="nowalk"></td>`; const c = (cm[p.id] || {})[a]; return c ? `<td class="t${c.note ? " badcell" : ""}">${c.note ? "✗" : "✓"} ${md(c.ts)} ${hm(c.ts)} · ${esc(c.crew)}${c.note ? ` · ${esc(c.note)}` : ""}${c.was_note ? `<div class="rtrip">✗ Not fully cleared ${md(c.was_ts)} ${hm(c.was_ts)}${c.was_crew ? " · " + esc(c.was_crew) : ""} · ${esc(c.was_note)} · RETURN TRIP</div>` : ""}</td>` : `<td class="t muted" style="font-weight:600">Not checked</td>`; };
    return `<details class="storm"><summary><b>${esc(st.name)}</b><span class="muted small">${fmtWhen(st.started)} to ${fmtWhen(st.ended)} · ${n}/${all.length} fully cleared</span></summary>
      <div class="tbl-wrap"><table class="log"><thead><tr><th>Property</th><th>Parking Lot(s)</th><th>Walkways</th></tr></thead><tbody>${ROUTES.map(r => `<tr class="rh"><td colspan="3">${esc(r.name)}</td></tr>` + r.props.map(p => `<tr><td>${esc(p.addr)}</td>${saltOnly(p) ? `<td colspan="2" class="muted small">Salt only, no clearing</td>` : cell(p, "drives") + cell(p, "walks")}</tr>`).join("")).join("")}</tbody></table></div></details>`;
  }).join("") : `<p class="muted" style="margin:0">When you end a storm, its checklist is saved here.</p>`}</section>`;
}
function viewClear() {
  const owner = AUTH.role === "owner";
  if (!DATA.storm) return clockBar() + (owner ? `<section class="panel"><h2>Storm clearing checklist</h2>
    <p class="muted" style="margin:0">Start a storm and every crew's phone gets the checklist. Crews check off parking lot(s) and walkways at each property as they're cleared.</p>
    <label class="f" for="storm-name">Storm name<input type="text" id="storm-name" placeholder="e.g. Dec 12 storm"></label>
    <button class="btn block" id="storm-start">Start storm</button></section>` + pastStorms()
    : `<section class="arrive waiting"><h2>No storm in progress</h2><div class="muted">The clearing checklist shows up here when a storm is started.</div></section>`);
  const cm = {}; (DATA.clears || []).forEach(c => { (cm[c.prop_id] = cm[c.prop_id] || {})[c.part] = c; });
  const all = clearable(); const parts = p => p.walks ? ["drives", "walks"] : ["drives"];
  const isDone = p => parts(p).every(a => (cm[p.id] || {})[a]); const done = all.filter(isDone).length;
  const box = (p, a) => { const c = (cm[p.id] || {})[a];
    if (c && c.note) return `<button class="ck on bad" data-clearfix="${p.id}" data-part="${a}"><span class="xmark">✗</span><span><b>${clearWord(a)}</b><small>Not fully cleared · ${hm(c.ts)} · ${esc(c.crew)} · ${esc(c.note)}</small></span></button>`;
    return `<label class="ck${c ? " on" : ""}" for="clr-${p.id}-${a}"><input type="checkbox" id="clr-${p.id}-${a}" data-clear="${p.id}" data-part="${a}" ${c ? "checked" : ""}><span><b>${clearWord(a)}</b>${c ? (c.was_note ? `<small class="rtrip">✗ Not fully cleared · ${hm(c.was_ts)}${c.was_crew ? " · " + esc(c.was_crew) : ""} · ${esc(c.was_note)}</small><small>✓ Fully cleared · ${hm(c.ts)} · ${esc(c.crew)}</small><small class="rtrip">Return trip</small>` : `<small>${hm(c.ts)} · ${esc(c.crew)}</small>`) : ""}</span></label>`; };
  return `${clockBar()}<section class="panel"><div class="runbar"><div><h2>${esc(DATA.storm.name)}</h2><div class="muted small">${done} of ${all.length} properties fully cleared · updates live</div></div>${owner ? `<button class="btn ghost" id="storm-end">End storm</button>` : ""}</div>
    <div class="progress"><i style="width:${all.length ? Math.round(done / all.length * 100) : 0}%"></i></div></section>
    ${ROUTES.map(r => `<h3 class="route-h">${esc(r.name)} · ${r.props.filter(p => !saltOnly(p) && isDone(p)).length}/${r.props.filter(p => !saltOnly(p)).length}</h3>` + r.props.map(p => saltOnly(p)
      ? `<div class="clear saltonly"><div style="flex:1;min-width:0"><div style="font-weight:700">${esc(p.addr)}</div>${p.client ? `<div class="muted small">${esc(p.client)}</div>` : ""}${siteBtns(p)}<div class="small" style="font-weight:600;margin-top:6px">Salt only · no clearing</div></div></div>`
      : `<div class="clear${isDone(p) ? " done" : ""}${parts(p).some(a => ((cm[p.id] || {})[a] || {}).note) ? " bad" : ""}"><div style="flex:1;min-width:0"><div style="font-weight:700">${esc(p.addr)}</div>${p.client ? `<div class="muted small">${esc(p.client)}</div>` : ""}${siteBtns(p)}
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
    <div class="daterow"><label class="f" for="from">From<input type="date" id="from" value="${UI.from}"></label><label class="f" for="to">To<input type="date" id="to" value="${UI.to}"></label></div>
    <button class="btn salt" id="dl-range" ${any ? "" : "disabled"}>Download Excel log (${od.entries.length} entries)</button></section>
    ${tableHTML(od.entries)}
    <section class="panel"><h2>Salt fill-ups</h2><div class="muted small">When drivers loaded their trucks, newest first.</div>
    ${od.fills.length ? `<div class="tbl-wrap"><table class="log" style="min-width:360px"><thead><tr><th>When</th><th>Driver</th><th>Filled with</th></tr></thead><tbody>${[...od.fills].reverse().map(x => `<tr><td class="t">${md(x.ts)} ${hm(x.ts)}</td><td><b>${esc(x.crew)}</b></td><td>${esc(fillWord(x))}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted" style="margin:0">No fill-ups logged yet.</p>`}</section>
    <section class="panel"><h2>Shift notes</h2><div class="muted small">Notes drivers left when clocking out, newest first.</div>
    ${(od.notes || []).length ? `<div class="shiftlist">${[...od.notes].reverse().map(n => `<div class="shiftrow"><div><b>${esc(n.crew)}</b> · ${md(n.ts)} ${hm(n.ts)}</div><div style="white-space:pre-wrap">${esc(n.note)}</div></div>`).join("")}</div>` : `<p class="muted" style="margin:0">No shift notes yet.</p>`}</section>
    <section class="panel"><h2>Log data</h2><div class="muted small">Every salt entry and clearing check-off with who did it, newest first.</div>
    ${rows.length ? `<div class="tbl-wrap"><table class="log" style="min-width:600px"><thead><tr><th>When</th><th>Driver</th><th>Type</th><th>Property</th><th>Area</th><th>Detail</th></tr></thead><tbody>${
      rows.slice(0, UI.allFeed ? 99999 : 15).map(r => `<tr><td class="t">${md(r.ts)} ${hm(r.ts)}</td><td><b>${esc(r.crew)}</b></td><td>${r.type}</td><td>${esc(propName(r.prop))}</td><td>${areaWord(r)}</td><td class="t">${esc(r.detail)}</td></tr>`).join("")}</tbody></table></div>
      ${rows.length > 15 && !UI.allFeed ? `<button class="btn ghost" id="all-feed">Show all ${rows.length} entries</button>` : ""}` : `<p class="muted" style="margin:0">Nothing logged yet.</p>`}</section>`;
}
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function weekRange() { const d = new Date(); d.setHours(0, 0, 0, 0); const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); return [ymd(mon), ymd(sun)]; }
async function loadMine() {
  if (!UI.myFrom) [UI.myFrom, UI.myTo] = weekRange();
  try { UI.mine = await rpc("shifts", { from: UI.myFrom || null, to: UI.myTo || null }, "my_logs"); } catch (e) { if (!UI.mine) UI.mine = null; UI.mineErr = true; }
}
function viewMine() {
  if (!UI.myFrom) [UI.myFrom, UI.myTo] = weekRange();
  if (!UI.mine) { if (!UI.mineErr) loadMine().then(render); return `${clockBar()}<section class="panel"><h2>My Logs</h2>${UI.mineErr ? `<p class="err" style="margin:0">Couldn't load. Check your signal.</p><button class="btn ghost" id="my-week">Try again</button>` : `<p class="muted" style="margin:0">Loading…</p>`}</section>`; }
  const list = UI.mine, ms = r => (r.ended ? new Date(r.ended) : Date.now()) - new Date(r.started);
  const total = list.reduce((t, r) => t + ms(r), 0); const live = list.some(r => !r.ended);
  const [wf, wt] = weekRange(); const isWeek = UI.myFrom === wf && UI.myTo === wt;
  const nice = v => { const [y, m, d] = v.split("-"); return `${+m}/${+d}`; };
  return `${clockBar()}<section class="arrive shift"><div class="muted small" style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Total hours${isWeek ? " · this week" : ""}</div>
    <div class="clock">${dur(total)}</div>
    <div class="muted small">${UI.myFrom ? nice(UI.myFrom) : "…"} to ${UI.myTo ? nice(UI.myTo) : "…"} · ${list.length} shift${list.length === 1 ? "" : "s"}${live ? " · includes your shift in progress" : ""}</div>
    <div class="daterow"><label class="f" for="my-from">From<input type="date" id="my-from" value="${UI.myFrom || ""}"></label><label class="f" for="my-to">To<input type="date" id="my-to" value="${UI.myTo || ""}"></label></div>
    ${isWeek ? "" : `<button class="btn ghost" id="my-week">Back to this week</button>`}</section>
    <button class="tile myshifts-tile" id="my-shifts"><span class="tile-h">My Shifts &amp; Logs</span><span class="muted" style="font-size:17px;font-weight:600">${list.length ? `${list.length} shift${list.length === 1 ? "" : "s"} · tap to see logs and fix entries` : "No shifts in these dates"}</span></button>`;
}
function myShiftRow(r) { const ms = (r.ended ? new Date(r.ended) : Date.now()) - new Date(r.started);
  return `<div class="shiftrow" data-myshift="${r.id}" role="button" tabindex="0"><div><b>${md(r.started)}</b> · in ${hm(r.started)} · ${r.ended ? "out " + hm(r.ended) : '<b style="color:var(--ok)">on now</b>'}</div><div class="small">Time worked: <b>${dur(ms)}</b></div>${r.note ? `<div class="small" style="white-space:pre-wrap">Note: ${esc(r.note)}</div>` : ""}<div class="small" style="font-weight:700;color:var(--accent)">View log ›</div></div>`; }
function openMyShifts() {
  const list = UI.mine || [];
  modal(`<h2>My Shifts &amp; Logs</h2><div class="muted small" style="margin-top:-8px">Tap a shift to see its log and fix an entry.</div>
    ${list.length ? `<div class="shiftlist flat">${list.map(myShiftRow).join("")}</div>` : `<p class="muted" style="margin:0">No shifts in these dates.</p>`}
    <button class="btn ghost block" id="cancel">Close</button>`, t => { const r = t.closest("[data-myshift]"); if (r) openShiftLog(AUTH.name, r.dataset.myshift, true, openMyShifts); });
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
    return `<div class="runitem" data-crew="${esc(x.name)}" role="button" tabindex="0"><div style="min-width:0"><b>${esc(x.name)}</b>
      <div class="muted small">Signed in ${fmtWhen(x.signed_in)}${x.signed_out ? ` · signed out ${fmtWhen(x.signed_out)}` : ` · last seen ${fmtWhen(x.last_seen)}`}</div>
      ${run && isOn ? `<div class="small" style="color:var(--ok);font-weight:600">On the clock · ${run.stops} stop${run.stops === 1 ? "" : "s"}${here ? ` · at ${esc(here)}` : ""}</div>` : ""}</div>
      <span class="chev">${isOn ? '<span class="dot"></span>' : ""}›</span></div>`; };
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
    <div class="muted">Salt &amp; Clearing Log</div>
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
  who.innerHTML = `<span class="small"><b>${esc(AUTH.name)}</b></span><button class="linkbtn" id="logout">Sign out</button>`;
  const owner = AUTH.role === "owner"; if (!owner && (UI.tab === "logs" || UI.tab === "crew")) UI.tab = "home";
  document.getElementById("tab-logs").hidden = !owner; document.getElementById("tab-crew").hidden = !owner; document.getElementById("tab-mine").hidden = false;
  document.querySelector(".tabs .wrap").style.gridTemplateColumns = owner ? "repeat(6,1fr)" : "repeat(4,1fr)"; tabs.classList.toggle("six", owner);
  app.innerHTML = UI.tab === "home" ? viewStart() : UI.tab === "clear" ? viewClear() : UI.tab === "logs" ? viewLogs() : UI.tab === "crew" ? viewCrew() : UI.tab === "mine" ? viewMine() : viewRun();
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === UI.tab));
  setOnline(UI.online);
}

// ---------- actions ----------
function toast(msg) { const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2800); }
function arriveAt(pid, auto) {
  UI.here = pid; LS.set("here", pid);
  render(); toTop();
  if (auto && navigator.vibrate) navigator.vibrate(200);
  refresh();
}
function modal(html, onClick) { const m = document.getElementById("modal"); m.innerHTML = `<div class="sheet-bg" id="sbg"><div class="sheet" role="dialog">${html}</div></div>`;
  m.onclick = ev => { const t = ev.target; if (t.id === "sbg" || t.id === "cancel") { m.innerHTML = ""; return; } onClick(t, () => { m.innerHTML = ""; }); }; }
// Lock the page behind any open pop-up so only the pop-up scrolls (iPhone-safe).
let modalY = 0; const toTop = () => { modalY = 0; window.scrollTo(0, 0); };
(() => { const m = document.getElementById("modal"); if (!m) return; let locked = false;
  new MutationObserver(() => { const open = !!m.querySelector(".sheet");
    if (open && !locked) { modalY = window.scrollY; locked = true; document.body.style.top = -modalY + "px"; document.body.classList.add("locked"); }
    else if (!open && locked) { locked = false; document.body.classList.remove("locked"); document.body.style.top = ""; window.scrollTo(0, modalY); } }).observe(m, { childList: true }); })();
function confirmBox(title, body, okLabel, onOk) {
  modal(`<h2>${esc(title)}</h2>${body ? `<p class="muted" style="margin:0">${esc(body)}</p>` : ""}<button class="btn salt block" id="ok">${esc(okLabel)}</button><button class="btn ghost block" id="cancel">Cancel</button>`,
    (t, close) => { if (t.id === "ok") { close(); onOk(); } });
}
async function openShiftLog(name, id, mine, backTo) {
  const back = mine && !backTo ? `<button class="btn ghost block" id="cancel">Close</button>` : `<div class="row"><button class="btn ghost" id="shift-back">‹ Back</button><button class="btn ghost" id="cancel">Close</button></div>`;
  let h;
  const show = () => {
    const r = h.run, g = []; (h.entries || []).forEach(e => { let x = g.find(y => y.id === e.prop_id); if (!x) g.push(x = { id: e.prop_id, items: [] }); x.items.push(e); });
    const cg = []; (h.clears || []).filter(c => c.checked).forEach(c => { let x = cg.find(y => y.id === c.prop_id); if (!x) cg.push(x = { id: c.prop_id, items: [] }); x.items.push(c); });
    const tag = mine ? "button" : "span";
    const salt = g.length ? `<div class="sumlist">${g.map(x => `<div class="sumrow"><div style="font-weight:700">${esc(propName(x.id))}</div><div class="logged">${x.items.map(e => `<${tag} class="entry"${mine ? ` data-myentry="${e.id}"` : ""}>${e.area === "drives" ? "Parking Lot(s)" : "Walks"} · ${hm(e.ts)} · ${amtWord(e.amt)}${e.note ? " · " + esc(e.note) : ""}</${tag}>`).join("")}</div></div>`).join("")}</div>` : `<p class="muted" style="margin:0">No salting logged.</p>`;
    const clr = cg.length ? `<h3 style="margin:6px 0 0">Clearing</h3><div class="sumlist">${cg.map(x => `<div class="sumrow"><div style="font-weight:700">${esc(propName(x.id))}</div><div class="logged">${x.items.map(c => `<span class="entry${c.note ? " badchip" : ""}">${clearWord(c.part)} · ${hm(c.ts)} · ${c.note ? "not fully cleared: " + esc(c.note) : "cleared"}</span>`).join("")}</div></div>`).join("")}</div>` : "";
    const fl = (h.fills || []).length ? `<h3 style="margin:6px 0 0">Salt fill-ups</h3><div class="logged">${h.fills.map(f => `<${tag} class="entry"${mine ? ` data-myfill="${f.id}"` : ""}>${esc(fillWord(f).replace(/^(Sander|Bags)/, m => m + " · " + hm(f.ts)))}</${tag}>`).join("")}</div>` : "";
    const nt = r.note ? `<h3 style="margin:6px 0 0">Shift notes</h3><p style="margin:0;white-space:pre-wrap">${esc(r.note)}</p>` : "";
    modal(`<h2>${mine ? "Shift log" : esc(name)}</h2><div class="muted small" style="margin-top:-8px"><b>${md(r.started)}</b> · in ${hm(r.started)} · ${r.ended ? "out " + hm(r.ended) : "on now"} · ${dur((r.ended ? new Date(r.ended) : Date.now()) - new Date(r.started))} worked</div>
      ${mine ? `<div class="muted small">Tap an entry or fill-up to fix it.</div>` : ""}
      <h3 style="margin:6px 0 0">Salt log</h3>${g.length ? `<div class="muted small">${g.length} propert${g.length === 1 ? "y" : "ies"} salted</div>` : ""}${salt}${clr}${fl}${nt}${back}`, onB);
  };
  const onB = t => {
    if (t.id === "shift-back") { if (backTo) backTo(); else openCrewHistory(name); return; }
    const en = t.closest("[data-myentry]");
    if (en) { const e = h.entries.find(x => x.id === en.dataset.myentry); if (e) openEdit(e, (act, d) => { if (act === "delete") h.entries = h.entries.filter(x => x.id !== e.id); else Object.assign(e, d); show(); }, show); return; }
    const fi = t.closest("[data-myfill]");
    if (fi) { const f = h.fills.find(x => x.id === fi.dataset.myfill); if (!f) return;
      openFillEdit(f, (act, d) => { if (act === "delete") h.fills = h.fills.filter(x => x.id !== f.id); else { if (d.yard) f.yard = d.yard; if (d.bags != null) f.bags = d.bags; } show(); }, show); }
  };
  modal(`<h2>${mine ? "Shift log" : esc(name)}</h2><p class="muted" style="margin:0">Loading…</p>${back}`, onB);
  try { h = await rpc("shift", { id }, mine ? "my_logs" : "crew_history"); } catch (e) { h = null; }
  if (!h || !h.run) { modal(`<h2>${mine ? "Shift log" : esc(name)}</h2><p class="err">Couldn't load this shift. Check your signal.</p>${back}`, onB); return; }
  show();
}
function kickCrew(name) {
  confirmBox(`Clock out & sign out ${name}?`, `Ends their shift now and signs them out of the app on their phone. Use this if they forgot to clock out.`, "Clock out & sign out", async () => {
    try { const r = await rpc("sign_out", { crew: name }, "crew_admin"); toast(`${name} signed out${r && r.runs_ended ? " and clocked out" : ""}`); await refresh(); render(); }
    catch (e) { toast("Couldn't sign them out. Check your signal."); } });
}
async function openCrewHistory(name) {
  modal(`<h2>${esc(name)}</h2><p class="muted" style="margin:0">Loading…</p><button class="btn ghost block" id="cancel">Close</button>`, () => {});
  let h; try { h = await rpc("history", { crew: name }, "crew_history"); } catch (e) { modal(`<h2>${esc(name)}</h2><p class="err">Couldn't load. Check your signal.</p><button class="btn ghost block" id="cancel">Close</button>`, () => {}); return; }
  const shifts = h.shifts || [];
  const total = shifts.filter(r => r.ended && Date.now() - new Date(r.started) < 7 * 864e5).reduce((t, r) => t + (new Date(r.ended) - new Date(r.started)), 0);
  const row = r => `<div class="shiftrow" data-shift="${r.id}" role="button" tabindex="0"><div><b>${md(r.started)}</b> · in ${hm(r.started)} · ${r.ended ? "out " + hm(r.ended) : '<b style="color:var(--ok)">on now</b>'}</div><div class="small">Time worked: <b>${dur((r.ended ? new Date(r.ended) : Date.now()) - new Date(r.started))}</b></div>${r.note ? `<div class="small" style="white-space:pre-wrap">Note: ${esc(r.note)}</div>` : ""}<div class="small" style="font-weight:700;color:var(--accent)">View log ›</div></div>`;
  modal(`<h2>${esc(name)}</h2><div class="muted small" style="margin-top:-8px">Time worked, last 7 days: <b>${dur(total)}</b></div>
    <h3 style="margin:4px 0 0">Clock in / out</h3>
    ${shifts.length ? `<div class="shiftlist">${shifts.map(row).join("")}</div>` : `<p class="muted" style="margin:0">No clock-ins yet.</p>`}
    <details><summary class="muted small">App sign-ins (${(h.sessions || []).length})</summary><div class="small" style="margin-top:6px">${(h.sessions || []).map(x => `${fmtWhen(x.signed_in)} to ${x.signed_out ? fmtWhen(x.signed_out) : "still signed in"}`).join("<br>")}</div></details>
    ${(DATA.sessions || []).some(x => x.name.trim().toLowerCase() === name.trim().toLowerCase() && !x.signed_out) || shifts.some(r => !r.ended) ? `<button class="btn bad block" id="kick">Clock out &amp; sign out ${esc(name)}</button>` : ""}
    <button class="btn ghost block" id="cancel">Close</button>`, t => { if (t.id === "kick") { kickCrew(name); return; } const r = t.closest("[data-shift]"); if (r) openShiftLog(name, r.dataset.shift); });
}
function endShift(note) {
  if (!DATA.run) return;
  const mine = DATA.entries || [];
  UI.report = { time: dur(Date.now() - new Date(DATA.run.started)), started: DATA.run.started, ended: nowIso(), crew: DATA.run.crew, entries: mine.slice().sort((a, b) => a.ts.localeCompare(b.ts)),
    fills: (DATA.fills || []).filter(f => new Date(f.ts) >= new Date(DATA.run.started) - 1000).sort((a, b) => a.ts.localeCompare(b.ts)),
    storm: DATA.storm ? DATA.storm.name : null, note: note || "",
    clears: DATA.storm ? (DATA.clears || []).filter(c => c.crew.trim().toLowerCase() === AUTH.name.trim().toLowerCase()).sort((a, b) => a.ts.localeCompare(b.ts)) : [] };
  send("finish_run", { id: DATA.run.id, ts: nowIso() }); UI.here = null; LS.del("here"); UI.tab = "home"; LS.set("tab", "home"); render(); toTop();
}
function openEndShift() {
  if (!DATA.run) return;
  const E = {};
  const step1 = () => modal(`<h2>End your shift</h2><p style="margin:0;font-weight:600">Was all salt emptied out of the truck?</p>
    <div class="clgrid"><button class="btn yes huge" id="em-yes">Yes</button><button class="btn bad huge" id="em-no">No</button></div>
    <button class="btn ghost block" id="cancel">Cancel</button>`, x => {
      if (x.id === "em-no") stepLeft();
      else if (x.id === "em-yes") step2(); });
  const stepUsed = () => modal(`<h2>Was all salt in the truck used during shift?</h2><p class="muted" style="margin:-6px 0 0;font-weight:600">Must answer before clock out</p>
    <div class="clgrid"><button class="btn yes huge" id="used-yes">Yes</button><button class="btn bad huge" id="used-no">No</button></div>
    <button class="btn ghost block" id="cancel">Cancel</button>`, x => {
      if (x.id === "used-yes") stepNotes();
      else if (x.id === "used-no") step1(); });
  const stepLeft = () => modal(`<h2>Salt left on the truck</h2><p style="margin:0;font-weight:600">Is it in the sander or bags?</p>
    <div class="clgrid"><button class="btn salt huge" id="left-sander">Sander</button><button class="btn walk huge" id="left-bags">Bags</button></div>
    <button class="btn ghost block" id="cancel">Cancel</button>`, x => {
      if (x.id === "left-sander") modal(`<div class="redbox">PLEASE EMPTY SANDER BEFORE CLOCK OUT</div>
        <button class="btn ghost block" id="cancel">OK</button>`, () => {});
      else if (x.id === "left-bags") stepBags(); });
  const stepBags = () => { modal(`<h2>Bags left on the truck</h2>
    <div class="notewrap"><label class="f" for="left-note">About how many bags are on the truck?<textarea id="left-note" rows="2" placeholder="e.g. 5 bags"></textarea></label>
    <button class="btn bad block huge" id="left-done">Next</button></div>
    <button class="btn ghost block" id="cancel">Cancel</button>`, x => {
      if (x.id !== "left-done") return;
      const n = document.getElementById("left-note").value.trim(); if (!n) { toast("Write about how many bags are on the truck"); return; }
      stepNotes(() => send("empty", { id: uuid(), kind: "left_bags", yard: null, note: n, run_id: DATA.run.id, ts: nowIso() })); });
    document.getElementById("left-note").focus(); };
  const step2 = () => modal(`<h2>Salt emptied out</h2><div class="muted small" style="margin-top:-8px">At what Storage Facility was it emptied?</div>
    <div class="locs small-locs">${YARDS_BAGS.map(l => `<button class="btn walk" data-emloc="${l}">${l}</button>`).join("")}</div>
    <button class="btn ghost block" id="cancel">Cancel</button>`, x => { const l = x.closest("[data-emloc]"); if (l) { E.yard = l.dataset.emloc; step3(); } });
  const step3 = () => modal(`<h2>Salt emptied out</h2><div class="muted small" style="margin-top:-8px">${esc(E.yard)} · Was it sander or bags?</div>
    <div class="clgrid"><button class="btn salt huge" data-emkind="empty_bulk">Sander</button><button class="btn walk huge" data-emkind="empty_bags">Bags</button></div>
    <button class="btn ghost block" id="cancel">Cancel</button>`, x => { const k = x.closest("[data-emkind]"); if (k) { E.kind = k.dataset.emkind; step4(); } });
  const step4 = () => { modal(`<h2>Salt emptied out</h2><div class="muted small" style="margin-top:-8px">${esc(E.yard)} · ${E.kind === "empty_bulk" ? "Sander" : "Bags"}</div>
    <div class="notewrap"><label class="f" for="em-note">About how much?<textarea id="em-note" rows="3" placeholder="e.g. half a sander, about 10 bags"></textarea></label>
    <button class="btn bad block huge" id="em-done">Next</button></div>
    <button class="btn ghost block" id="cancel">Cancel</button>`, x => {
      if (x.id !== "em-done") return;
      const n = document.getElementById("em-note").value.trim(); if (!n) { toast("Write about how much was emptied"); return; }
      const k = E.kind, y = E.yard; stepNotes(() => send("empty", { id: uuid(), kind: k, yard: y, note: n, run_id: DATA.run.id, ts: nowIso() })); });
    document.getElementById("em-note").focus(); };
  const stepNotes = pre => { modal(`<h2>Shift Notes</h2><p style="margin:-6px 0 0;font-size:18px;font-weight:600;line-height:1.35">Anything broken or damaged Tyler should know about. If nothing, leave blank</p>
    <div class="notewrap"><label class="f" for="shift-note">Notes<textarea id="shift-note" rows="4" placeholder="e.g. shovel handle broke, snowblower won't start"></textarea></label>
    <button class="btn bad block huge" id="shift-done">Clock out</button></div>
    <button class="btn ghost block" id="cancel">Cancel</button>`, x => {
      if (x.id !== "shift-done") return;
      const n = document.getElementById("shift-note").value.trim();
      document.getElementById("modal").innerHTML = "";
      if (pre) pre();
      if (n) send("shift_note", { id: DATA.run.id, note: n });
      endShift(n); });
    document.getElementById("shift-note").focus(); };
  stepUsed();
}
function confirmUncheck(pid, part) {
  const p = PROPS[pid]; if (!p || !DATA.storm) return; const sid = DATA.storm.id;
  modal(`<div class="muted small" style="text-transform:uppercase;letter-spacing:.08em;font-weight:700">${clearWord(part)}</div><h2 style="margin-top:-8px">Uncheck this?</h2><div class="muted small" style="margin-top:-8px">${esc(p.addr)}</div>
    <p style="margin:0;font-weight:600">Only uncheck if it was checked off by mistake.</p>
    <div class="clgrid"><button class="btn bad huge" id="unc-yes">Yes, uncheck</button><button class="btn ghost huge" id="cancel">Keep checked</button></div>`, (t, close) => {
    if (t.id === "unc-yes") { close(); if (!DATA.storm || DATA.storm.id !== sid) return; send("clear", { storm_id: sid, prop_id: pid, part, checked: false, ts: nowIso() }); toast("Unchecked"); } });
}
function openClearFix(pid, part) {
  const p = PROPS[pid], c = ((DATA.clears || []).find(x => x.prop_id === pid && x.part === part)); if (!p || !c || !DATA.storm) return; const sid = DATA.storm.id;
  modal(`<div class="muted small" style="text-transform:uppercase;letter-spacing:.08em;font-weight:700">${clearWord(part)} · return trip</div><h2 style="margin-top:-8px">Fully cleared now?</h2><div class="muted small" style="margin-top:-8px">${esc(p.addr)}</div>
    <div class="redsoft">✗ Not fully cleared at ${hm(c.ts)} by ${esc(c.crew)}: ${esc(c.note)}</div>
    <p style="margin:0;font-weight:600">${part === "drives" ? "Make sure the whole parking lot is clear." : "Make sure all doors, walks, and the dumpster area are fully cleared."}</p>
    <button class="btn yes block huge" id="fix-yes">Yes, fully cleared now</button>
    <div class="row"><button class="btn ghost" id="fix-uncheck">Uncheck</button><button class="btn ghost" id="cancel">Cancel</button></div>`, (t, close) => {
    if (t.id === "fix-yes") { close(); if (!DATA.storm || DATA.storm.id !== sid) return; if (!DATA.run) send("start_run", { id: uuid(), ts: nowIso() });
      send("clear", { storm_id: sid, prop_id: pid, part, checked: true, note: "", ts: nowIso() }); toast("Checked off · return trip logged"); }
    else if (t.id === "fix-uncheck") confirmUncheck(pid, part); });
}
function openClearCheck(pid, part) {
  const p = PROPS[pid], storm = DATA.storm; if (!p || !storm) return;
  const ask = part === "drives" ? "Make sure the whole parking lot is clear." : "Make sure all doors, walks, and the dumpster area are fully cleared.";
  modal(`<div class="muted small" style="text-transform:uppercase;letter-spacing:.08em;font-weight:700">${clearWord(part)}</div><h2 style="margin-top:-8px">Fully cleared?</h2><div class="muted small" style="margin-top:-8px">${esc(p.addr)}</div>
    <p style="margin:0;font-weight:600">${ask}</p>
    <div class="clgrid"><button class="btn yes huge" id="cl-yes">Yes, fully cleared</button><button class="btn bad huge" id="cl-no">Couldn't fully clear</button></div>
    <div id="cl-note-wrap" class="notewrap" hidden><label class="f" for="cl-note">What couldn't be cleared?<textarea id="cl-note" rows="3" placeholder="e.g. cars parked in back row, dumpster blocked"></textarea></label>
      <button class="btn bad block" id="cl-save">Check Off with Note</button></div>
    <button class="btn ghost block" id="cancel">Cancel</button>`, (x, close) => {
    const go = note => { close(); if (!DATA.storm || DATA.storm.id !== storm.id) return;
      if (!DATA.run) send("start_run", { id: uuid(), ts: nowIso() });
      send("clear", { storm_id: storm.id, prop_id: pid, part, checked: true, note, ts: nowIso() }); toast(note ? "Checked off with note" : "Checked off"); };
    if (x.id === "cl-yes") go("");
    else if (x.id === "cl-no") { const y = document.getElementById("cl-yes"); y.disabled = true; y.classList.add("dimmed"); x.classList.add("picked"); x.textContent = "✗ Couldn't fully clear";
      document.getElementById("cl-note-wrap").hidden = false; document.getElementById("cl-note").focus(); }
    else if (x.id === "cl-save") { const n = document.getElementById("cl-note").value.trim(); if (!n) { toast("Add a note about what couldn't be cleared"); return; } go(n); }
  });
}
function openQuick(pid, area) {
  const p = PROPS[pid];
  modal(`<div class="muted small" style="text-transform:uppercase;letter-spacing:.08em;font-weight:700">${area === "drives" ? "Parking Lot(s)" : "Walkways"}</div><h2 style="margin-top:-8px">How much?</h2><div class="muted small" style="margin-top:-8px">${esc(p.addr)}</div>
    <div class="qgrid"><button class="btn salt huge" data-q="1">Full</button><button class="btn salt huge" data-q="0.5">Half</button><button class="btn ghost huge" data-q="custom">Custom</button></div>
    <div id="custom-wrap" hidden><div class="row"><label class="f" for="q-other">Fraction<input type="number" id="q-other" step="0.05" min="0.05" max="1" placeholder=".3" inputmode="decimal"></label><button class="btn salt" id="q-log" style="align-self:end">Log it</button></div></div>
    <details><summary class="muted small">Add a note</summary><input type="text" id="q-note" placeholder="e.g. back, extra removal time" style="margin-top:8px"></details>
    <button class="btn ghost block" id="cancel">Cancel</button>`, (t, close) => {
    const log = amt => { const note = (document.getElementById("q-note").value || "").trim(); close();
      if (!DATA.run) send("start_run", { id: uuid(), ts: nowIso() });
      send("salt", { id: uuid(), run_id: DATA.run ? DATA.run.id : null, prop_id: p.id, area, amt, note, ts: nowIso() });
      toast(`Logged ${area === "drives" ? "parking lot(s)" : "walkways"} · ${amtWord(amt)}`); };
    const q = t.closest("[data-q]");
    if (q) { if (q.dataset.q === "custom") { document.getElementById("custom-wrap").hidden = false; document.getElementById("q-other").focus(); } else log(+q.dataset.q); return; }
    if (t.id === "q-log") { const v = parseFloat(document.getElementById("q-other").value); if (!(v > 0 && v <= 1)) { toast("Enter a fraction between .05 and 1"); return; } log(v); }
  });
}
function openLogNote(pid) {
  const items = (DATA.entries || []).filter(e => e.prop_id === pid).sort((a, b) => a.ts.localeCompare(b.ts)); if (!items.length) return;
  const last = items[items.length - 1]; const cur = items.map(e => e.note).filter(Boolean).pop() || "";
  modal(`<h2>Note</h2><div class="muted small" style="margin-top:-8px">${esc(propName(pid))}</div>
    <div class="notewrap"><label class="f" for="log-note">Anything to note at this property?<textarea id="log-note" rows="3" placeholder="e.g. extra removal time, came back at 1115">${esc(cur)}</textarea></label>
    <button class="btn salt block" id="log-note-save">Save note</button></div>
    <button class="btn ghost block" id="cancel">Cancel</button>`, (t, close) => {
    if (t.id !== "log-note-save") return;
    const n = document.getElementById("log-note").value.trim(); const tgt = items.filter(e => e.note).pop() || last;
    close(); send("salt_edit", { id: tgt.id, amt: tgt.amt, note: n, ts: tgt.ts }); toast(n ? "Note saved" : "Note removed"); });
  document.getElementById("log-note").focus();
}
function openFillEdit(f, onDone, onCancel) {
  if (f.kind !== "bulk" && f.kind !== "bags") { confirmBox("Remove this entry?", `${fillWord(f)} at ${hm(f.ts)}.`, "Remove", () => { send("fill_delete", { id: f.id }); toast("Removed"); if (onDone) onDone("delete"); }); return; }
  const bags = f.kind === "bags"; let yard = f.yard, n = f.bags;
  const yards = bags ? YARDS_BAGS : YARDS_BULK;
  const draw = () => modal(`<div class="muted small" style="text-transform:uppercase;letter-spacing:.08em;font-weight:700">${bags ? "Bags" : "Sander"} · ${md(f.ts)} ${hm(f.ts)}</div><h2>Edit this fill-up</h2>
    ${bags ? `<label class="f" for="fe-bags">How many bags?<select id="fe-bags">${Array.from({ length: 50 }, (_, i) => i + 1).map(i => `<option value="${i}" ${i === +n ? "selected" : ""}>${i}</option>`).join("")}</select></label>` : ""}
    <div class="muted small" style="font-weight:600">From which Storage Facility?</div>
    <div class="locs small-locs">${yards.map(l => `<button class="btn walk${l === yard ? " picked" : ""}" data-feyard="${l}">${l}</button>`).join("")}</div>
    <button class="btn salt block" id="fe-save">Save changes</button>
    <div class="row"><button class="btn ghost" id="fe-del">Remove fill-up</button><button class="btn ghost" id="${onCancel ? "fe-cancel" : "cancel"}">Cancel</button></div>`, (t, close) => {
      const y = t.closest("[data-feyard]"); if (y) { if (bags) n = document.getElementById("fe-bags").value; yard = y.dataset.feyard; draw(); return; }
      if (t.id === "fe-cancel") { onCancel(); return; }
      if (t.id === "fe-del") { close(); send("fill_delete", { id: f.id }); toast("Fill-up removed"); if (onDone) onDone("delete"); return; }
      if (t.id === "fe-save") { const d = { id: f.id, yard }; if (bags) d.bags = +document.getElementById("fe-bags").value;
        close(); send("fill_edit", d); toast("Fill-up updated"); if (onDone) onDone("edit", d); }
    });
  draw();
}
function openEdit(e, onDone, onCancel) {
  const p = PROPS[e.prop_id]; let amt = +e.amt; const presets = [[1, "Full"], [0.5, "Half"]];
  const isPreset = presets.some(x => x[0] === amt);
  modal(`<div class="muted small" style="text-transform:uppercase;letter-spacing:.08em;font-weight:700">Fix ${e.area === "drives" ? "parking lot(s)" : "walkways"}</div><h2>${esc(p ? p.addr : e.prop_id)}</h2>
    <div class="amts" style="grid-template-columns:repeat(3,1fr)">${presets.map(([v, l]) => `<button class="amt${amt === v ? " on" : ""}" data-amt="${v}">${l}</button>`).join("")}<button class="amt${isPreset ? "" : " on"}" data-amt="other">Custom</button></div>
    <label class="f" for="amt-other" id="other-wrap" ${isPreset ? "hidden" : ""}>Fraction<input type="number" id="amt-other" step="0.05" min="0.05" max="1" value="${isPreset ? "" : amt}" inputmode="decimal"></label>
    <label class="f" for="note">Note<input type="text" id="note" value="${esc(e.note || "")}"></label>
    <button class="btn salt block" id="save-entry">Save changes</button>
    <div class="row"><button class="btn ghost" id="del-entry">Remove entry</button><button class="btn ghost" id="${onCancel ? "edit-cancel" : "cancel"}">Cancel</button></div>`, (t, close) => {
    if (t.id === "edit-cancel") { onCancel(); return; }
    const ab = t.closest("[data-amt]");
    if (ab) { document.querySelectorAll(".amt").forEach(x => x.classList.toggle("on", x === ab)); const o = ab.dataset.amt === "other"; document.getElementById("other-wrap").hidden = !o; if (!o) amt = +ab.dataset.amt; return; }
    if (t.id === "del-entry") { close(); send("salt_delete", { id: e.id }); toast("Entry removed"); if (onDone) onDone("delete"); return; }
    if (t.id === "save-entry") {
      if (!document.getElementById("other-wrap").hidden) { const v = parseFloat(document.getElementById("amt-other").value); if (!(v > 0 && v <= 1)) { toast("Enter a fraction between .05 and 1"); return; } amt = v; }
      const nd = { id: e.id, amt, note: document.getElementById("note").value.trim(), ts: e.ts }; close(); send("salt_edit", nd); toast("Entry updated"); if (onDone) onDone("edit", nd);
    }
  });
}
function logFill(kind, bags, yard) {
  if (!DATA.run) send("start_run", { id: uuid(), ts: nowIso() });
  send("fill", { id: uuid(), kind, bags: bags || null, yard, run_id: DATA.run ? DATA.run.id : null, ts: nowIso() });
  toast(kind === "bulk" ? `Logged sander · ${yard}` : `Logged ${bags} bags · ${yard}`);
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
    UI.tab = "home"; LS.set("tab", "home"); UI.here = null; LS.del("here"); buildRoutes(); render(); startGps(); loadMaps();
  } catch (e) {
    AUTH = null; btn.disabled = false; btn.textContent = "Sign in";
    toast(e.code === "bad_pin" ? "That PIN isn't right." : e.code === "network" ? "No signal. Try again when you have service." : e.code === "config" ? "The app isn't connected to its database yet." : "Couldn't sign in (" + e.code + ").");
  }
}
function signOutLocal(msg) { AUTH = null; DATA = null; OUTBOX = []; LS.del("auth"); LS.del("data"); LS.set("outbox", []); LS.del("here"); UI.here = null; UI.ownerData = null; UI.mine = null; UI.myFrom = null; render(); setOnline(UI.online); if (msg) toast(msg); }
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
  if (DATA && DATA.run) { UI.tab = "home"; LS.set("tab", "home"); UI.report = null; render(); toTop();
    modal(`<h2>Clock out first</h2><p class="muted" style="margin:0">You're still on the clock. Tap End before signing out.</p><button class="btn salt block" id="cancel">OK</button>`, () => {});
    const e = document.getElementById("finish"); if (e) { e.classList.add("pulse"); setTimeout(() => e.classList.remove("pulse"), 3200); } return; }
  confirmBox("Sign out?", "You'll need your name and PIN to sign back in.", "Sign out", async () => {
    try { await rpc("logout", { session: AUTH.session }); } catch (e) {}
    signOutLocal();
  });
});
document.querySelector(".tabs").addEventListener("click", ev => { const b = ev.target.closest("[data-tab]"); if (!b) return; UI.tab = b.dataset.tab; LS.set("tab", UI.tab); if (UI.tab === "logs") UI.ownerData = UI.ownerData; render(); toTop(); if (UI.tab === "logs") loadOwnerData().then(render); if (UI.tab === "mine") { UI.mineErr = false; loadMine().then(render); } });
const app = document.getElementById("app");
app.addEventListener("keydown", ev => { if (ev.key === "Enter" && (ev.target.id === "login-name" || ev.target.id === "login-pin")) signIn(); });
app.addEventListener("change", ev => {
  const t = ev.target;
  if (t.id === "pick-prop" && t.value) { arriveAt(t.value); return; }
  if (t.id === "dir-prop") { UI.dirProp = t.value || null; render(); return; }
  if (t.id === "my-from" || t.id === "my-to") { UI[t.id === "my-from" ? "myFrom" : "myTo"] = t.value; UI.mine = null; UI.mineErr = false; render(); return; }
  if (t.id === "from" || t.id === "to") { UI[t.id] = t.value; UI.ownerData = null; render(); return; }
  if (t.dataset.clear) {
    if (!DATA.storm) return;
    if (!t.checked) { t.checked = true; confirmUncheck(t.dataset.clear, t.dataset.part); return; }
    t.checked = false; openClearCheck(t.dataset.clear, t.dataset.part);
  }
});
app.addEventListener("toggle", ev => { const d = ev.target; if (d.dataset && d.dataset.log) { if (d.open) UI.openLog = d.dataset.log; else if (UI.openLog === d.dataset.log) UI.openLog = null; } }, true);
app.addEventListener("pointerdown", ev => { const b = ev.target.closest(".btn,.tile"); if (!b) return; b.classList.add("pressed"); if (navigator.vibrate && b.closest(".shift,.tiles")) navigator.vibrate(15); setTimeout(() => b.classList.remove("pressed"), 160); });
app.addEventListener("click", ev => {
  const cr = ev.target.closest("[data-crew]"); if (cr) { openCrewHistory(cr.dataset.crew); return; }
  if (ev.target.closest("#my-shifts")) { openMyShifts(); return; }
  if (ev.target.id === "my-week") { [UI.myFrom, UI.myTo] = weekRange(); UI.mine = null; UI.mineErr = false; render(); return; }
  const t = ev.target.closest("button"); if (!t) return;
  if (t.id === "login") { signIn(); return; }
  if (t.dataset.salted) { openQuick(UI.here, t.dataset.salted); return; }
  if (t.dataset.clearfix) { openClearFix(t.dataset.clearfix, t.dataset.part); return; }
  if (t.dataset.sitemap) { openSiteMap(t.dataset.sitemap); return; }
  if (t.dataset.mapup) { pickSiteMap(t.dataset.mapup); return; }
  if (t.dataset.maprm) { const id = t.dataset.maprm; confirmBox("Remove this site map?", "Crews will no longer see it.", "Remove", () => rpc("remove", { prop_id: id }, "site_map").then(() => { UI.maps = (UI.maps || []).filter(x => x !== id); LS.set("maps", UI.maps); toast("Site map removed"); render(); }).catch(() => toast("Couldn't remove. Check your signal."))); return; }
  if (t.closest && t.closest("[data-maps]")) { openMaps(t.closest("[data-maps]").dataset.maps); return; }
  if (t.dataset.lognote) { openLogNote(t.dataset.lognote); return; }
  if (t.dataset.entry) { const e = DATA.entries.find(a => a.id === t.dataset.entry); if (e) openEdit(e); return; }
  if (t.id === "finish") { openEndShift(); return; }
  if (t.id === "new-run") { UI.report = null; render(); return; }
  if (t.id === "start-run") { if (!DATA.run) send("start_run", { id: uuid(), ts: nowIso() }); startGps(); render(); toast("You're on the clock"); return; }
  if (t.dataset.go) { setTimeout(() => { UI.tab = t.dataset.go; LS.set("tab", UI.tab); render(); toTop(); }, 140); return; }
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
    modal(`<h2>Sander</h2><div class="muted small" style="margin-top:-8px">From which Storage Facility?</div>
      <div class="locs">${YARDS_BULK.map(l => `<button class="btn salt huge" data-loc="${l}">${l}</button>`).join("")}</div>
      <button class="btn ghost block" id="cancel">Cancel</button>`, (x, close) => { const l = x.closest("[data-loc]"); if (l) { close(); logFill("bulk", null, l.dataset.loc); } });
    return;
  }
  if (t.dataset.fill === "bags") {
    modal(`<h2>Bags</h2>
      <label class="f" for="bag-count">1. How many bags?<select id="bag-count"><option value="">Select…</option>${Array.from({ length: 50 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}</select></label>
      <div class="muted small" style="font-weight:600" id="yard-h">2. From which Storage Facility? <span id="yard-hint">(pick the number of bags first)</span></div>
      <div class="locs small-locs">${YARDS_BAGS.map(l => `<button class="btn walk" data-bagloc="${l}" disabled>${l}</button>`).join("")}</div>
      <button class="btn ghost block" id="cancel">Cancel</button>`, (x, close) => {
      const bl = x.closest("[data-bagloc]"); if (!bl) return;
      const n = +document.getElementById("bag-count").value; if (!n) { toast("Pick how many bags first"); return; }
      close(); logFill("bags", n, bl.dataset.bagloc);
    });
    document.getElementById("bag-count").onchange = ev => { const on = !!ev.target.value;
      document.querySelectorAll("[data-bagloc]").forEach(b => b.disabled = !on); document.getElementById("yard-hint").hidden = on; };
    return;
  }
  if (t.dataset.fillfix) { const x = DATA.fills.find(f => f.id === t.dataset.fillfix); if (!x) return;
    openFillEdit(x); }
});

// ---------- start ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
if (AUTH) { startGps(); flush(); }

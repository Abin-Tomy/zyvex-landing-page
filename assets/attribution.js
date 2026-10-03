/* ─────────────────────────────────────────────────────────────
   Zyvex Tech — persistent first-touch / latest-touch attribution.

   Loaded on every page of the journey (landing pages, portfolio,
   case studies) so a Meta click is remembered even if the visitor
   browses around or comes back later before submitting the form.

   Storage (localStorage, first-party, 90-day retention):
     zx_ft   first touch   — written once, never overwritten while valid
     zx_lt   latest touch  — replaced when a different attribution set arrives
     zx_fbc  latest Meta click {fbc, fbclid, ts} — fbc built from the time the
             fbclid was FIRST captured, or Meta's own _fbc for that click

   URL carrier: once this page's click is known, ?zx_fbc=<that exact fbc> is added
   to the address (history.replaceState, nothing else in the URL changes). If the
   visitor moves to another browser (e.g. Instagram → "Open in external browser"),
   the carried fbc is restored as-is: same click, same original timestamp.

   Nothing is fabricated: no fbclid/fbc/fbp is produced unless it came from
   the URL or Meta's own cookies. Every storage/cookie access is guarded, so
   blocked storage or cookies can never break the page or the lead form.

   window.zxAttribution() returns the merged values ({} on any failure).
   ───────────────────────────────────────────────────────────── */
(function (w) {
  'use strict';

  var RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];
  var SET_KEYS = UTM_KEYS.concat(['fbclid', 'gclid']);

  var RE_CLICK_ID = /^[\w-]{10,500}$/;                 // fbclid / gclid
  var RE_FBC = /^fb\.[0-2]\.\d{13}\.[\w-]{10,500}$/;
  var RE_FBP = /^fb\.[0-2]\.\d{13}\.\d{5,30}$/;

  function validFbc(v) { return typeof v === 'string' && RE_FBC.test(v); }
  function validFbp(v) { return typeof v === 'string' && RE_FBP.test(v); }
  function validClickId(v) { return typeof v === 'string' && RE_CLICK_ID.test(v); }
  function fbcTime(v) { return Number(v.split('.')[2]); }
  function fbcClickId(v) { return v.split('.').slice(3).join('.'); }
  function fresh(rec) { return !!rec && typeof rec.ts === 'number' && Date.now() - rec.ts < RETENTION_MS; }
  // valid format AND embedded click time no older than 90 days
  function usableFbc(v) { return validFbc(v) && Date.now() - fbcTime(v) < RETENTION_MS; }

  function cleanText(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  }

  /* ── guarded storage / cookies ── */
  function load(key) {
    try {
      var raw = w.localStorage.getItem(key);
      var rec = raw ? JSON.parse(raw) : null;
      return rec && typeof rec === 'object' ? rec : null;
    } catch (e) { return null; }
  }
  function save(key, rec) {
    try { w.localStorage.setItem(key, JSON.stringify(rec)); } catch (e) { /* storage unavailable */ }
  }
  function cookie(name) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  /* ── read this page's URL ── */
  function readUrl() {
    var out = {};
    try {
      var sp = new URLSearchParams(w.location.search);
      UTM_KEYS.forEach(function (k) { var v = cleanText(sp.get(k)); if (v) out[k] = v; });
      var fbclid = sp.get('fbclid');
      if (validClickId(fbclid)) out.fbclid = fbclid;          // malformed → ignored
      var gclid = sp.get('gclid');
      if (validClickId(gclid)) out.gclid = gclid;
    } catch (e) { /* no URLSearchParams / bad URL */ }
    return out;
  }

  function sameSet(a, b) {
    if (!a || !b) return false;
    for (var i = 0; i < SET_KEYS.length; i++) {
      if ((a[SET_KEYS[i]] || '') !== (b[SET_KEYS[i]] || '')) return false;
    }
    return true;
  }

  /* ── URL carrier: the original fbc preserved across browsers ── */
  var CARRIER = 'zx_fbc';
  function readCarrier() {
    try {
      var v = new URLSearchParams(w.location.search).get(CARRIER);
      return usableFbc(v) ? v : '';                            // malformed / older than 90 days → ignored
    } catch (e) { return ''; }
  }

  /* ── capture on landing ── */
  var current = readUrl();          // this page's attribution, kept in memory even if storage fails
  var currentFbc = null;            // {fbc, fbclid, ts} for a click seen on this page
  var carried = readCarrier();      // exact original fbc carried in this URL, or ''

  (function capture() {
    if (!Object.keys(current).length) return;
    var now = Date.now();
    var path = '';
    try { path = String(w.location.pathname || '').slice(0, 200); } catch (e) {}

    var touch = { ts: now, landing: path };
    SET_KEYS.forEach(function (k) { if (current[k]) touch[k] = current[k]; });

    // latest touch: replace only when a different attribution set arrives,
    // so a reload of the same ad URL keeps the original landing time
    var lt = load('zx_lt');
    if (!(fresh(lt) && sameSet(lt, touch))) save('zx_lt', touch);

    // first touch: write once; never overwrite a valid one
    if (!fresh(load('zx_ft'))) save('zx_ft', touch);

    // Meta click → fbc stamped with the time this fbclid was first captured
    if (current.fbclid) {
      var stored = load('zx_fbc');
      if (fresh(stored) && stored.fbclid === current.fbclid && usableFbc(stored.fbc)) {
        currentFbc = stored;                                   // same click seen again: keep original
      } else if (carried && fbcClickId(carried) === current.fbclid) {
        currentFbc = { fbc: carried, fbclid: current.fbclid, ts: fbcTime(carried) };  // carried original
        save('zx_fbc', currentFbc);
      } else {
        var metaFbc = cookie('_fbc');
        var fbc = (usableFbc(metaFbc) && fbcClickId(metaFbc) === current.fbclid)
          ? metaFbc                                            // Meta already created one for this click
          : 'fb.1.' + now + '.' + current.fbclid;              // first capture time, not submit time
        currentFbc = { fbc: fbc, fbclid: current.fbclid, ts: now };
        save('zx_fbc', currentFbc);
      }
    }
  })();

  // no click in this URL, but a carried one (e.g. a new external browser):
  // restore that exact fbc — no new timestamp, no rebuilt value
  (function restoreCarried() {
    if (currentFbc || !carried) return;
    currentFbc = { fbc: carried, fbclid: fbcClickId(carried), ts: fbcTime(carried) };
    save('zx_fbc', currentFbc);
  })();

  // put this page's original fbc in the URL so it survives a move to another browser;
  // skipped when the URL already carries exactly that value (no rewrite loop)
  (function writeCarrier() {
    if (!currentFbc || !usableFbc(currentFbc.fbc)) return;
    try {
      var loc = w.location, h = w.history;
      if (!h || !h.replaceState) return;
      var have = new URLSearchParams(loc.search).getAll(CARRIER);
      if (have.length === 1 && have[0] === currentFbc.fbc) return;
      var kept = String(loc.search || '').replace(/^\?/, '').split('&').filter(function (p) {
        return p && p.split('=')[0] !== CARRIER;               // every other parameter kept byte-for-byte
      });
      kept.push(CARRIER + '=' + currentFbc.fbc);               // fbc is [\w.-] only: no encoding needed
      h.replaceState(h.state, '', loc.pathname + '?' + kept.join('&') + loc.hash);
    } catch (e) { /* history unavailable: attribution still works in this browser */ }
  })();

  /* ── merged view for the lead form ── */
  w.zxAttribution = function () {
    try {
      var ft = load('zx_ft'), lt = load('zx_lt'), sf = load('zx_fbc');
      if (!fresh(ft)) ft = null;
      if (!fresh(lt)) lt = null;
      if (!fresh(sf)) sf = null;

      // UTM / gclid as one set: this page's URL if it has any, else latest touch
      var set = Object.keys(current).length ? current : (lt || {});
      var out = {};
      UTM_KEYS.concat(['gclid']).forEach(function (k) { if (set[k]) out[k] = set[k]; });

      var fbc = '';
      var metaFbc = cookie('_fbc');
      if (currentFbc && usableFbc(currentFbc.fbc)) {
        // a valid fbclid in this page's URL is authoritative: Meta's _fbc is used only
        // when it is the same click; a different cookie or stored click is ignored
        fbc = (usableFbc(metaFbc) && fbcClickId(metaFbc) === currentFbc.fbclid) ? metaFbc : currentFbc.fbc;
      } else {
        // no click in this URL: most recent usable click among Meta's _fbc cookie and the
        // stored click (each well-formed and no older than 90 days by its embedded timestamp)
        var cands = [];
        if (usableFbc(metaFbc)) cands.push(metaFbc);           // listed first: wins ties
        if (sf && usableFbc(sf.fbc)) cands.push(sf.fbc);
        cands.forEach(function (c) { if (!fbc || fbcTime(c) > fbcTime(fbc)) fbc = c; });
      }
      if (fbc) out.fbc = fbc;

      // fbclid always matches the chosen fbc, so the two never describe different clicks
      var fbclid = fbc ? fbcClickId(fbc) : (current.fbclid || '');
      if (validClickId(fbclid)) out.fbclid = fbclid;

      var fbp = cookie('_fbp');
      if (validFbp(fbp)) out.fbp = fbp;

      if (ft) out.first_touch = ft;
      if (lt) out.latest_touch = lt;
      return out;
    } catch (e) {
      return {};
    }
  };
})(window);

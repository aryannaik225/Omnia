/*
 * Omnia — injected HTML5 <video> telemetry observer, profile handshake & history scraper.
 *
 * Injected by src-tauri/src/player/window_manager.rs into every page load of an OTT player
 * window (and hidden importer windows) via WebView2's document-created script hook. Rust
 * appends the call `({...config})` to this function expression.
 *
 * Privacy: this script only ever talks to the local Omnia process through Tauri IPC. Network
 * requests it makes are same-origin calls the OTT page itself is authorised for (Netflix's own
 * metadata / viewing-activity APIs); it never reads or forwards cookies.
 *
 * Modes:
 *   play    — switch to the linked profile, track progress / pauses / seeks / episode hops,
 *             render the "Back to Hub" pill (with one-click profile linking when unlinked)
 *   connect — profile handshake: detect the OTT profile the user picked and link it
 *   import  — hidden window: read watch history and submit it
 */
(function (CONFIG) {
  "use strict";

  if (window.top !== window.self) return;
  var FLAG = "__omniaTelemetry";
  if (window[FLAG]) return;
  try {
    Object.defineProperty(window, FLAG, { value: true });
  } catch (_) {
    return;
  }
  var TOKEN_KEY = String(CONFIG.token || "").slice(0, 12);
  var IS_NETFLIX = CONFIG.provider === "netflix";

  // -------------------------------------------------------------------------------------------
  // IPC (capture Tauri's invoke before page scripts run, so later monkey-patching can't wrap it)
  // -------------------------------------------------------------------------------------------
  var capturedInvoke = null;
  function bindInvoke() {
    var i = window.__TAURI_INTERNALS__;
    if (!capturedInvoke && i && typeof i.invoke === "function") capturedInvoke = i.invoke.bind(i);
    return capturedInvoke;
  }
  bindInvoke();

  function invoke(cmd, payload) {
    var fn = bindInvoke();
    if (!fn) return Promise.resolve(null);
    try {
      return Promise.resolve(fn(cmd, { payload: payload })).catch(function () {
        return null;
      });
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function session(key, value) {
    try {
      if (value === undefined) return window.sessionStorage.getItem(key);
      if (value === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch (_) {}
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Text helpers
  // -------------------------------------------------------------------------------------------
  function clean(s) {
    return String(s == null ? "" : s).replace(/[\s ]+/g, " ").trim();
  }

  var SE_PATTERNS = [
    // S1:E3 · S01E03 · S1 E3 · S2.E1 · Season 1, Ep. 3 · Season 1 Episode 3
    /\bS(?:eason)?\s*(\d{1,3})\s*[:,.\-|·]?\s*E(?:p(?:isode)?)?\.?\s*(\d{1,4})\b/i,
    /\bSeason\s*(\d{1,3})\b[^\d]{0,12}\b(?:Episode|Ep\.?)\s*(\d{1,4})\b/i,
  ];
  var EP_ONLY = /\b(?:Ep(?:isode)?\.?|E)\s*(\d{1,4})\b/i;
  var SEASON_ONLY = /^(?:S|Season|Series|Part|Volume)\s*(\d{1,3})$/i;

  /** Parses season/episode markers; `rest` is the text left after removing them (episode title). */
  function parseSE(text) {
    var t = clean(text);
    if (!t) return null;
    for (var i = 0; i < SE_PATTERNS.length; i++) {
      var m = t.match(SE_PATTERNS[i]);
      if (m) {
        return {
          season: parseInt(m[1], 10),
          episode: parseInt(m[2], 10),
          rest: clean(t.replace(m[0], "").replace(/^[\s:,.\-|·]+|[\s:,.\-|·]+$/g, "")) || null,
        };
      }
    }
    // A standalone "E1" / "Ep. 1" / "Episode 1" token (season shown elsewhere).
    var e = t.match(/^(?:Ep(?:isode)?\.?|E)\s*(\d{1,4})\b/i) || t.match(/\b(?:Episode|Ep\.)\s*(\d{1,4})\b/i);
    if (e) {
      return {
        season: null,
        episode: parseInt(e[1], 10),
        rest: clean(t.replace(e[0], "").replace(/^[\s:,.\-|·]+|[\s:,.\-|·]+$/g, "")) || null,
      };
    }
    return null;
  }

  var BRAND_ONLY = /^(netflix|prime video|amazon\.?\w*|jiohotstar|disney\+?\s*hotstar|hotstar|zee5|sony ?liv|apple tv\+?|disney\+|hbo max|max|hulu|peacock|paramount\+|crunchyroll|mubi|youtube)$/i;

  function stripProviderSuffix(title) {
    return clean(
      String(title || "")
        .replace(/\s*[|\-–—]\s*(Netflix|Prime Video|Amazon\.?\w*|JioHotstar|Disney\+?\s*Hotstar|Hotstar|ZEE5|Sony ?LIV|Apple TV\+?|Disney\+|HBO Max|Max|Hulu|Peacock|Paramount\+|Crunchyroll|MUBI|YouTube)\b.*$/i, "")
        .replace(/\s+on\s+(Netflix|Prime Video|JioHotstar|Disney\+?\s*Hotstar|Hotstar|ZEE5|Sony ?LIV|Apple TV\+?|Disney\+|HBO Max|Max|Hulu|Peacock|Paramount\+)\b.*$/i, "")
        .replace(/^(Watch|Stream)\s+/i, "")
        .replace(/\s+(Online|Full (Movie|Episode)s?)(\s+(in\s+)?(HD|4K))?.*$/i, ""),
    );
  }

  function matchUrl(re) {
    var m = location.href.match(re);
    return m ? m[1] : null;
  }

  function waitFor(check, timeoutMs, intervalMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function tick() {
        var value = null;
        try { value = check(); } catch (_) {}
        if (value || Date.now() - start > timeoutMs) return resolve(value || null);
        setTimeout(tick, intervalMs || 400);
      })();
    });
  }

  // -------------------------------------------------------------------------------------------
  // OTT profile detection (the native identity used for ott_profile_mappings)
  // -------------------------------------------------------------------------------------------
  var PROFILE_ID_KEYS = ["currentProfileId", "activeProfileId", "selectedProfileId", "profileId", "profile_id", "pid"];
  var PROFILE_NAME_KEYS = ["currentProfileName", "profileName", "profile_name", "name"];

  function pickProfileFromObject(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > 4) return null;
    for (var i = 0; i < PROFILE_ID_KEYS.length; i++) {
      var v = obj[PROFILE_ID_KEYS[i]];
      if ((typeof v === "string" && v.length >= 3 && v.length <= 128) || typeof v === "number") {
        var name = null;
        for (var j = 0; j < PROFILE_NAME_KEYS.length; j++) {
          if (typeof obj[PROFILE_NAME_KEYS[j]] === "string") {
            name = clean(obj[PROFILE_NAME_KEYS[j]]).slice(0, 64);
            break;
          }
        }
        return { id: String(v), name: name };
      }
    }
    var keys = Object.keys(obj).sort();
    for (var k = 0; k < keys.length; k++) {
      if (/profile/i.test(keys[k])) {
        var found = pickProfileFromObject(obj[keys[k]], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function netflixUserInfo() {
    try {
      return window.netflix.reactContext.models.userInfo.data || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Netflix identity = `guid::profile name`. The name disambiguates profiles even if `guid`
   * turns out to be account-level; a page reload after any profile gate keeps it fresh.
   */
  function detectNetflixProfile() {
    var data = netflixUserInfo();
    if (!data || !data.guid || !data.name) return null;
    var name = clean(data.name).slice(0, 64);
    return { id: String(data.guid) + "::" + name, name: name };
  }

  function detectGenericProfile() {
    var stores = [];
    try { stores.push(window.localStorage); } catch (_) {}
    try { stores.push(window.sessionStorage); } catch (_) {}
    for (var s = 0; s < stores.length; s++) {
      var store = stores[s];
      if (!store) continue;
      var keys = [];
      for (var i = 0; i < store.length; i++) keys.push(store.key(i));
      keys.sort();
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (!key || !/profile/i.test(key) || /^omnia-/.test(key)) continue;
        var raw = store.getItem(key);
        if (!raw) continue;
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) {}
        if (parsed && typeof parsed === "object") {
          var p = pickProfileFromObject(parsed, 0);
          if (p) return p;
        } else if (/^(current|active|selected)?_?profile_?id$/i.test(key) && raw.length >= 3 && raw.length <= 128) {
          return { id: raw.replace(/^"|"$/g, ""), name: null };
        }
      }
    }
    return null;
  }

  // Signed-in detection for every provider other than Netflix. Profiles aren't exposed the same
  // way anywhere (Apple TV has none on the web), so a session counts as signed in when:
  //   - the page isn't a sign-in / sign-up / OTP page, nor a "Who's watching?" picker,
  //   - no visible "Sign in" / "Log in" call to action is left on the page, and
  //   - an account / profile / avatar control (or a stored auth session) is present.
  // The profile id comes from the page's storage when the provider keeps one; otherwise the
  // link is account-level ("account"), which Rust scopes to this Omnia profile — safe because
  // each Omnia profile has its own isolated browser session.
  var AUTH_PATH = /\/(login|log-in|signin|sign-in|sign_in|signup|sign-up|register|join|auth|authenticate|activate|verify|otp|mylogin|ap\/signin|ap\/register|ap\/cvf|subscribe\/login)(\/|$|\?)|\/onboarding\/(?!profile)/i;
  var GATE_PATH = /\/(profiles?|profile-?select|select-?profile|choose-?profile|who-?s-?watching|switch-?profile|onboarding\/profile)(\/|$|\?)/i;
  var SIGN_IN_CTA = /^(sign in|sign-in|log in|log-in|login|sign up|sign in to watch|log in to watch|sign in or sign up|join now|already a member\?? sign in)$/i;
  var SIGNED_IN_HINTS = [
    'a[href*="logout" i]', 'a[href*="signout" i]', 'a[href*="sign-out" i]', 'a[href*="log-out" i]',
    'a[href*="/account" i]', 'a[href*="/myaccount" i]', 'a[href*="/my-account" i]', 'a[href*="/settings" i]',
    'a[href*="/profiles" i]', 'a[href*="/mystuff" i]', 'a[href*="/watchlist" i]',
    '[aria-label*="account" i]', '[aria-label*="profile" i]', '[aria-label*="my space" i]',
    '[data-testid*="avatar" i]', '[data-testid*="profile" i]', '[data-testid*="account" i]',
    '[class*="avatar" i]', 'img[alt*="profile" i]', 'img[alt*="avatar" i]',
  ].join(",");

  function isVisible(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
    } catch (_) {
      return false;
    }
  }

  function hasSignInCta() {
    return Array.prototype.some.call(document.querySelectorAll("a, button, [role=button]"), function (el) {
      var t = clean(el.textContent || el.getAttribute("aria-label") || "");
      return t.length <= 40 && SIGN_IN_CTA.test(t) && isVisible(el);
    });
  }

  function onGenericProfileGate() {
    if (GATE_PATH.test(location.pathname)) return true;
    var text = document.body ? clean(String(document.body.innerText || "").slice(0, 2500)) : "";
    return /who.?s watching\??|choose (your |a )?profile|select (your |a )?profile|switch profiles?/i.test(text) &&
      document.querySelectorAll('[class*="profile" i] img, [data-testid*="profile" i], [aria-label*="profile" i]').length > 1;
  }

  function hasStoredSession() {
    var stores = [];
    try { stores.push(window.localStorage); } catch (_) {}
    try { stores.push(window.sessionStorage); } catch (_) {}
    return stores.some(function (store) {
      if (!store) return false;
      for (var i = 0; i < store.length; i++) {
        var key = store.key(i) || "";
        if (/^omnia-/.test(key) || !/(access.?token|auth.?token|id.?token|user.?token|session.?token|usertoken|bearer|jwt)/i.test(key)) continue;
        var v = store.getItem(key) || "";
        if (v.length >= 20) return true;
      }
      return false;
    });
  }

  /** Signed-in identity for non-Netflix providers, or null while signed out / choosing. */
  function detectSignedInIdentity() {
    if (document.readyState === "loading" || !document.body) return null;
    if (AUTH_PATH.test(location.pathname)) return null;
    if (onGenericProfileGate()) return null;
    if (hasSignInCta()) return null;
    var stored = detectGenericProfile();
    if (stored) return stored;
    if (document.querySelector(SIGNED_IN_HINTS) || hasStoredSession()) return { id: "account", name: null };
    return null;
  }

  function detectOttProfile() {
    if (IS_NETFLIX) return onProfileGate() ? null : detectNetflixProfile();
    return detectSignedInIdentity();
  }

  function onProfileGate() {
    if (!IS_NETFLIX) return false;
    if (/\/(ProfilesGate|profiles\/manage|SwitchProfile)/i.test(location.pathname)) return true;
    return !!document.querySelector(
      '[data-uia*="profile-gate"], [data-uia="profile-choices-page"], .profile-gate-container, .list-profiles, .profiles-gate-container',
    );
  }

  /**
   * Netflix can switch profiles inside its single-page app, leaving the page's profile data
   * stale. After any trip through the "Who's watching?" gate, reload once so detection is fresh.
   */
  function watchProfileGate() {
    if (!IS_NETFLIX) return;
    var KEY = "omnia-gate-seen";
    setInterval(function () {
      if (onProfileGate()) {
        if (!session(KEY)) session(KEY, "1");
      } else if (session(KEY) && document.readyState === "complete") {
        session(KEY, null);
        location.reload();
      }
    }, 800);
  }

  // -------------------------------------------------------------------------------------------
  // Netflix metadata (season / episode) — merged from every source that knows something
  //
  // No single source is reliable during playback: `netflix.reactContext` is often absent on
  // /watch pages, the player store's shape changes between builds, the title overlay is only in
  // the DOM while the controls are visible, and Shakti endpoints get refused. So every source
  // fills in whatever the previous ones left missing, and every episode Netflix's own metadata
  // describes is indexed by its video id (the id in /watch/<id>).
  // -------------------------------------------------------------------------------------------
  function netflixContextValue(path) {
    try {
      var node = window.netflix.reactContext.models;
      for (var i = 0; i < path.length; i++) node = node[path[i]];
      return node || null;
    } catch (_) {
      return null;
    }
  }

  function toInt(v) {
    if (typeof v === "number" && isFinite(v)) return Math.round(v);
    if (typeof v === "string" && /^\d{1,4}$/.test(v.trim())) return parseInt(v, 10);
    return null;
  }

  /** Netflix video id → { title, seasonNumber, episodeNumber, episodeTitle }, from any metadata seen. */
  var NFX_VIDEOS = {};
  var NFX_VIDEO_COUNT = 0;
  /** Build identifiers seen in page requests / scripts (for the metadata endpoint). */
  var NFX_BUILDS = [];

  function rememberBuild(b) {
    if (b && /^v[0-9a-f]{4,}$/i.test(b) && NFX_BUILDS.indexOf(b) < 0) NFX_BUILDS.push(b);
  }

  function indexVideo(v) {
    if (!v || typeof v !== "object") return false;
    var title = typeof v.title === "string" ? clean(v.title) : "";
    if (!title || title.length > 200) return false;
    var year = toInt(v.year != null ? v.year : v.releaseYear);
    if (year != null && (year < 1880 || year > 2100)) year = null;
    if (Array.isArray(v.seasons)) {
      var added = false;
      v.seasons.forEach(function (season, si) {
        if (!season || !Array.isArray(season.episodes)) return;
        var sNum = toInt(season.seq != null ? season.seq : season.num);
        if (sNum == null) sNum = si + 1;
        season.episodes.forEach(function (ep, ei) {
          if (!ep) return;
          var id = ep.episodeId != null ? ep.episodeId : ep.id;
          if (id == null) return;
          var eNum = toInt(ep.seq != null ? ep.seq : ep.num);
          if (eNum == null) eNum = ei + 1;
          if (!NFX_VIDEOS[id]) NFX_VIDEO_COUNT++;
          NFX_VIDEOS[id] = {
            title: title,
            seasonNumber: sNum,
            episodeNumber: eNum,
            episodeTitle: typeof ep.title === "string" ? clean(ep.title) || null : null,
            mediaType: "tv",
            releaseYear: year,
          };
          added = true;
        });
      });
      return added;
    }
    if (v.type === "movie" && v.id != null && !NFX_VIDEOS[v.id]) {
      NFX_VIDEO_COUNT++;
      NFX_VIDEOS[v.id] = { title: title, seasonNumber: null, episodeNumber: null, episodeTitle: null, mediaType: "movie", releaseYear: year };
      return true;
    }
    return false;
  }

  /** Walks any JSON-ish tree (player store, API response) for Netflix video metadata objects. */
  function indexNetflixVideos(root) {
    var seen = typeof WeakSet === "function" ? new WeakSet() : null;
    var budget = 60000;
    var found = false;
    (function walk(node, depth) {
      if (!node || typeof node !== "object" || depth > 9 || --budget < 0) return;
      if (seen) {
        if (seen.has(node)) return;
        seen.add(node);
      }
      if (!Array.isArray(node) && indexVideo(node)) {
        found = true;
        return;
      }
      var keys;
      try { keys = Object.keys(node); } catch (_) { return; }
      for (var i = 0; i < keys.length && i < 400; i++) {
        var child;
        try { child = node[keys[i]]; } catch (_) { continue; }
        if (child && typeof child === "object") walk(child, depth + 1);
      }
    })(root, 0);
    return found;
  }

  function considerMetadataText(text) {
    if (!text || text.length > 6e6 || text.indexOf('"seasons"') < 0 && text.indexOf('"movie"') < 0) return;
    try {
      indexNetflixVideos(JSON.parse(text));
    } catch (_) {}
  }

  /**
   * Play mode: read the metadata Netflix's own player downloads for the episode being played
   * (response bodies only; requests are untouched). Installed at document start.
   */
  function installNetflixPlayerTap() {
    function sameSite(url) {
      try {
        return /(^|\.)netflix\.com$/i.test(new URL(url, location.href).hostname);
      } catch (_) {
        return false;
      }
    }
    function noteUrl(url) {
      var m = String(url || "").match(/\/(?:api\/shakti|nq\/website\/memberapi)\/(v[0-9a-f]+)\//i);
      if (m) rememberBuild(m[1]);
    }
    if (typeof window.fetch === "function") {
      var origFetch = window.fetch;
      window.fetch = function (input) {
        var p = origFetch.apply(window, arguments);
        try {
          var url = typeof input === "string" ? input : (input && input.url) || String(input || "");
          if (sameSite(url)) {
            noteUrl(url);
            p.then(function (r) {
              var type = (r.headers && r.headers.get("content-type")) || "";
              if (!r.ok || type.indexOf("json") < 0) return;
              r.clone().text().then(considerMetadataText).catch(function () {});
            }).catch(function () {});
          }
        } catch (_) {}
        return p;
      };
    }
    var X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!X) return;
    var origOpen = X.open;
    var origSend = X.send;
    X.open = function (method, url) {
      try { this.__omniaMetaUrl = String(url); } catch (_) {}
      return origOpen.apply(this, arguments);
    };
    X.send = function () {
      var xhr = this;
      var url = xhr.__omniaMetaUrl || "";
      if (sameSite(url)) {
        noteUrl(url);
        xhr.addEventListener("load", function () {
          try {
            if (xhr.status < 200 || xhr.status >= 300) return;
            if (xhr.responseType === "json") indexNetflixVideos(xhr.response);
            else if (!xhr.responseType || xhr.responseType === "text") considerMetadataText(xhr.responseText);
          } catch (_) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  /** Build id from page state or inline scripts (reactContext is often missing on /watch). */
  function discoverNetflixBuilds() {
    rememberBuild(netflixContextValue(["serverDefs", "data", "BUILD_IDENTIFIER"]));
    if (NFX_BUILDS.length) return;
    var scripts = document.querySelectorAll("script:not([src])");
    for (var i = 0; i < scripts.length && i < 60; i++) {
      var m = (scripts[i].textContent || "").match(/"BUILD_IDENTIFIER"\s*:\s*"(v[0-9a-f]+)"/i);
      if (m) {
        rememberBuild(m[1]);
        return;
      }
    }
  }

  /** Netflix's in-memory player store (no network); the shape varies, so search it. */
  function netflixFromPlayerState() {
    try {
      var app = window.netflix && window.netflix.appContext && window.netflix.appContext.state && window.netflix.appContext.state.playerApp;
      var st = app && typeof app.getState === "function" ? app.getState() : null;
      if (st) indexNetflixVideos(st.videoPlayer || st);
    } catch (_) {}
    try {
      if (window.netflix && window.netflix.falcorCache) indexNetflixVideos(window.netflix.falcorCache.videos);
    } catch (_) {}
  }

  var netflixMeta = { id: null, pending: false, failedAt: 0, attempts: 0 };

  /** Asks Netflix's own metadata endpoint (same-origin, as its web client does) about the id. */
  function refreshNetflixMetadata(videoId) {
    if (!videoId || netflixMeta.pending) return;
    if (netflixMeta.id !== videoId) {
      netflixMeta.id = videoId;
      netflixMeta.failedAt = 0;
      netflixMeta.attempts = 0;
    }
    if (netflixMeta.attempts >= 4 || Date.now() - netflixMeta.failedAt < 15000) return;
    discoverNetflixBuilds();
    var bases = [];
    NFX_BUILDS.forEach(function (b) {
      bases.push("/nq/website/memberapi/" + b + "/metadata");
      bases.push("/api/shakti/" + b + "/metadata");
    });
    bases.push("/nq/website/memberapi/release/metadata", "/api/shakti/mre/metadata");
    netflixMeta.pending = true;
    netflixMeta.attempts++;
    (function attempt(i) {
      if (i >= bases.length) {
        netflixMeta.pending = false;
        netflixMeta.failedAt = Date.now();
        return;
      }
      fetch(bases[i] + "?movieid=" + encodeURIComponent(videoId) + "&imageFormat=webp&withSize=true&materialize=true", { credentials: "include" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) {
          if (!json || !indexNetflixVideos(json) || !NFX_VIDEOS[videoId]) return attempt(i + 1);
          netflixMeta.pending = false;
          sendSync("metadata");
        })
        .catch(function () { attempt(i + 1); });
    })(0);
  }

  /** Netflix's title overlay: <h4>Series</h4><span>S2:E1</span><span>Episode</span> and variants. */
  function netflixFromDom() {
    var root =
      document.querySelector('[data-uia="video-title"]') ||
      document.querySelector('[data-uia="player-title"], [data-uia*="video-title"], .video-title');
    if (!root) return null;
    var h4 = root.querySelector("h4");
    var series = clean(h4 ? h4.textContent : "");
    var leaves = Array.prototype.filter
      .call(root.querySelectorAll("*"), function (el) { return el.childElementCount === 0; })
      .map(function (el) { return clean(el.textContent); })
      .filter(Boolean);
    if (!leaves.length) leaves = [clean(root.textContent)].filter(Boolean);
    if (!series) series = leaves[0] || "";
    var season = null, episode = null, epTitle = null;
    var joined = leaves.filter(function (t) { return t !== series; }).join(" | ");
    var combined = parseSE(joined.replace(/\s*\|\s*/g, " "));
    leaves.forEach(function (t) {
      if (t === series) return;
      var p = parseSE(t);
      if (p && p.episode != null) {
        if (p.season != null) season = p.season;
        episode = p.episode;
        if (p.rest && !epTitle) epTitle = p.rest;
        return;
      }
      var s = t.match(SEASON_ONLY);
      if (s) {
        season = parseInt(s[1], 10);
        return;
      }
      if (!epTitle && t.length > 1) epTitle = t;
    });
    if (episode == null && combined) {
      episode = combined.episode;
      if (season == null) season = combined.season;
    }
    // A single leaf like "Friends S2:E2 The One with the Breast Milk".
    if (episode == null && leaves.length === 1) {
      var single = parseSE(leaves[0]);
      if (single) {
        series = clean(leaves[0].split(SE_PATTERNS[0])[0] || "").replace(/[\s:,\-|·]+$/, "") || series;
        season = single.season;
        episode = single.episode;
        epTitle = single.rest;
      }
    }
    if (!series) return null;
    return { title: series, seasonNumber: season, episodeNumber: episode, episodeTitle: epTitle };
  }

  /** Last good overlay read per video id: the overlay disappears with the player controls. */
  var nfxDomCache = {};

  /** Fills the gaps in `into` from `from` (never overwrites what an earlier source knew). */
  function mergeDetected(into, from) {
    if (!from) return into;
    if (!into) into = { title: null, seasonNumber: null, episodeNumber: null, episodeTitle: null };
    if (!into.title && from.title) into.title = from.title;
    if (into.episodeNumber == null && from.episodeNumber != null) {
      into.episodeNumber = from.episodeNumber;
      if (from.seasonNumber != null) into.seasonNumber = from.seasonNumber;
    }
    if (into.seasonNumber == null && from.seasonNumber != null) into.seasonNumber = from.seasonNumber;
    if (!into.episodeTitle && from.episodeTitle) into.episodeTitle = from.episodeTitle;
    if (!into.mediaType && from.mediaType) into.mediaType = from.mediaType;
    if (into.releaseYear == null && from.releaseYear != null) into.releaseYear = from.releaseYear;
    return into;
  }

  function netflixMediaSessionHint() {
    try {
      var md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (!md || !md.title) return null;
      var p = parseSE(md.title) || parseSE(md.album || "") || parseSE(md.artist || "");
      if (!p) return null;
      return { title: clean(md.artist || md.album) || null, seasonNumber: p.season, episodeNumber: p.episode, episodeTitle: p.rest };
    } catch (_) {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Media metadata detection (title / season / episode) per provider
  // -------------------------------------------------------------------------------------------
  var adapters = {
    netflix: function () {
      var id = matchUrl(/\/watch\/(\d+)/);
      if (!id) return null;
      if (!NFX_VIDEOS[id]) netflixFromPlayerState();

      // 1. Netflix's own metadata for this exact video id (captured, store, or fetched).
      var r = mergeDetected(null, NFX_VIDEOS[id] || null);
      // 2. The on-screen title overlay, live or the last read for this id.
      var dom = netflixFromDom();
      if (dom) nfxDomCache[id] = mergeDetected(nfxDomCache[id] || null, dom);
      r = mergeDetected(r, dom);
      r = mergeDetected(r, nfxDomCache[id] || null);
      // 3. The OS media session (Netflix sets it on some builds).
      r = mergeDetected(r, netflixMediaSessionHint());
      // Still missing the episode: ask Netflix's metadata endpoint for this id.
      if (!r || r.episodeNumber == null) refreshNetflixMetadata(id);
      if (!r || !r.title) return null;
      return {
        title: r.title,
        seasonNumber: r.seasonNumber,
        episodeNumber: r.episodeNumber,
        // With only an episode name, Rust places it by name in TMDB's season data.
        episodeTitle: r.episodeTitle,
        ottTitleId: id,
        // From Netflix's own metadata: lets Rust search the right TMDB type and year.
        mediaType: r.mediaType || (r.episodeNumber != null || r.seasonNumber != null || r.episodeTitle ? "tv" : null),
        releaseYear: r.releaseYear != null ? r.releaseYear : null,
        confidence: "high",
      };
    },
    primevideo: function () {
      var t = document.querySelector(".atvwebplayersdk-title-text");
      if (!t || !clean(t.textContent)) return null;
      var sub = document.querySelector(".atvwebplayersdk-subtitle-text");
      var p = sub ? parseSE(sub.textContent) : null;
      return {
        title: clean(t.textContent),
        seasonNumber: p ? p.season : null,
        episodeNumber: p ? p.episode : null,
        episodeTitle: p ? p.rest : null,
        ottTitleId: matchUrl(/\/detail\/([^/?#]+)/),
        confidence: "high",
      };
    },
  };

  function fromMediaSession() {
    try {
      var md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (!md || !md.title) return null;
      var p = parseSE(md.title) || parseSE(md.album || "");
      if (p && (md.artist || md.album)) {
        return { title: clean(md.artist || md.album), seasonNumber: p.season, episodeNumber: p.episode, episodeTitle: p.rest, confidence: "high" };
      }
      return { title: clean(md.title), seasonNumber: null, episodeNumber: null, episodeTitle: null, confidence: "low" };
    } catch (_) {
      return null;
    }
  }

  function fromDocumentTitle() {
    var t = stripProviderSuffix(document.title);
    if (!t || t.length < 2 || BRAND_ONLY.test(t)) return null;
    var p = parseSE(t);
    if (p) {
      var series = clean(t.split(SE_PATTERNS[0])[0] || "").replace(/[\s:,\-|·]+$/, "");
      return { title: series || t, seasonNumber: p.season, episodeNumber: p.episode, episodeTitle: p.rest, confidence: "low" };
    }
    return { title: t, seasonNumber: null, episodeNumber: null, episodeTitle: null, confidence: "low" };
  }

  var urlKey = location.pathname + location.search;
  var lastDetected = null;
  var urlChangedSinceDetection = false;
  var urlChangedAt = 0;
  var hasHighAdapter = !!adapters[CONFIG.provider];

  function detectMedia() {
    var adapter = adapters[CONFIG.provider];
    var d = (adapter && adapter()) || fromMediaSession() || fromDocumentTitle();
    if (d && d.confidence === "high") {
      lastDetected = d;
      urlChangedSinceDetection = false;
    } else if (d && urlChangedSinceDetection && !hasHighAdapter && Date.now() - urlChangedAt > 4000) {
      // Providers without a dedicated adapter only expose document/mediaSession titles; accept
      // them once the SPA has had time to update its title after navigation.
      lastDetected = d;
      urlChangedSinceDetection = false;
    } else if (!lastDetected && d && !urlChangedSinceDetection) {
      lastDetected = d;
    }
    return urlChangedSinceDetection ? null : lastDetected;
  }

  // -------------------------------------------------------------------------------------------
  // <video> tracking
  // -------------------------------------------------------------------------------------------
  var video = null;
  var wasPlaying = false;
  var lastTick = performance.now();
  var activeAccum = 0; // seconds of real watching since the last sync (excludes pause/seek/buffering)
  var lastKnownTime = 0;
  var seekFrom = null;
  var resumeApplied = !(CONFIG.resumeAtSeconds > 30) || IS_NETFLIX;
  var VIDEO_EVENTS = ["play", "playing", "pause", "seeking", "seeked", "ended", "timeupdate", "waiting", "durationchange", "loadedmetadata"];

  function isPlaying(v) {
    return !!v && !v.paused && !v.ended && !v.seeking && v.readyState >= 3;
  }

  /** Adds wall time to the active-watch counter only while the video was genuinely playing. */
  function accrue() {
    var now = performance.now();
    if (wasPlaying) activeAccum += Math.min(5, Math.max(0, (now - lastTick) / 1000));
    lastTick = now;
    wasPlaying = isPlaying(video);
  }

  function pickVideo() {
    var best = null, bestArea = 0;
    document.querySelectorAll("video").forEach(function (v) {
      var r = v.getBoundingClientRect();
      var area = r.width * r.height;
      if (v.readyState > 0 && area > bestArea) {
        best = v;
        bestArea = area;
      }
    });
    return best;
  }

  function onVideoEvent(e) {
    accrue();
    var v = e.currentTarget;
    switch (e.type) {
      case "timeupdate":
        if (!v.seeking) lastKnownTime = v.currentTime;
        maybeResume(v);
        break;
      case "seeking":
        if (seekFrom == null) seekFrom = lastKnownTime;
        break;
      case "seeked":
        if (seekFrom != null && Math.abs(v.currentTime - seekFrom) > 2) sendSync("seek", { seekFrom: seekFrom });
        seekFrom = null;
        lastKnownTime = v.currentTime;
        break;
      case "pause":
        sendSync("pause");
        break;
      case "playing":
        sendSync("play");
        break;
      case "ended":
        sendSync("ended");
        break;
    }
  }

  function attach(v) {
    if (v === video) return;
    if (video) VIDEO_EVENTS.forEach(function (n) { video.removeEventListener(n, onVideoEvent); });
    accrue();
    video = v;
    wasPlaying = isPlaying(v);
    if (v) VIDEO_EVENTS.forEach(function (n) { v.addEventListener(n, onVideoEvent, { passive: true }); });
  }

  function maybeResume(v) {
    if (resumeApplied || !isFinite(v.duration) || v.duration <= 0) return;
    resumeApplied = true;
    var target = CONFIG.resumeAtSeconds;
    // Only seek when the provider itself did not resume (still near the start).
    if (v.currentTime < 15 && target < v.duration * 0.95) {
      try { v.currentTime = target; } catch (_) {}
    }
  }

  // -------------------------------------------------------------------------------------------
  // Sync to Rust
  // -------------------------------------------------------------------------------------------
  var lastAck = null;

  function sendSync(kind, extra) {
    if (CONFIG.mode !== "play") return Promise.resolve(null);
    accrue();
    var v = video;
    var payload = {
      token: CONFIG.token,
      kind: kind,
      currentTime: v && isFinite(v.currentTime) ? v.currentTime : 0,
      duration: v && isFinite(v.duration) ? v.duration : 0,
      paused: v ? v.paused : true,
      activeDeltaSeconds: activeAccum,
      seekFrom: extra && extra.seekFrom != null ? extra.seekFrom : null,
      pageUrl: location.origin + location.pathname,
      urlChanged: urlChangedSinceDetection,
      detected: detectMedia(),
      ottProfile: detectOttProfile(),
    };
    activeAccum = 0;
    return invoke("sync_playback_telemetry", payload).then(function (ack) {
      if (ack) {
        lastAck = ack;
        renderStatus();
      }
      return ack;
    });
  }

  function onUrlMaybeChanged() {
    var key = location.pathname + location.search;
    if (key === urlKey) return;
    urlKey = key;
    lastDetected = null;
    urlChangedSinceDetection = true;
    urlChangedAt = Date.now();
    setTimeout(function () { sendSync("metadata"); }, 1500);
    setTimeout(function () { sendSync("metadata"); }, 4500);
  }

  // History API hops (SPA navigation between episodes/titles).
  ["pushState", "replaceState"].forEach(function (name) {
    var original = history[name];
    if (typeof original !== "function") return;
    history[name] = function () {
      var result = original.apply(this, arguments);
      setTimeout(onUrlMaybeChanged, 0);
      return result;
    };
  });
  window.addEventListener("popstate", onUrlMaybeChanged);
  window.addEventListener("hashchange", onUrlMaybeChanged);

  // Final flush hook used by Rust right before the player window is destroyed.
  try {
    Object.defineProperty(window, "__omniaFinalFlush", {
      value: function () {
        if (video && !video.paused) {
          try { video.pause(); } catch (_) {}
        }
        return sendSync("final");
      },
    });
  } catch (_) {}

  window.addEventListener("pagehide", function () { sendSync("final"); });

  // -------------------------------------------------------------------------------------------
  // Play mode: open the title only once the linked profile is active
  // -------------------------------------------------------------------------------------------
  /** Returns true while the window is still on the provider's profile-switch pages. */
  function handleProfileSwitchThenTarget() {
    if (CONFIG.mode !== "play" || !CONFIG.targetUrl) return false;
    var KEY = "omnia-target-" + TOKEN_KEY;
    if (session(KEY) === "done") return false;
    var started = Date.now();
    var hinted = false;
    (function check() {
      if (onProfileGate()) {
        // Waiting for the user (e.g. a profile PIN); never time out while on the gate.
        if (!hinted && ui.panel) {
          hinted = true;
          showPanel("Choose " + (CONFIG.expectedOttProfileName || "your linked profile") + " to continue.", null);
        }
        started = Date.now();
        return setTimeout(check, 800);
      }
      var p = detectOttProfile();
      var matches = p && p.id === CONFIG.expectedOttProfileId;
      if (matches || Date.now() - started > 12000) {
        session(KEY, "done");
        location.replace(CONFIG.targetUrl);
        return;
      }
      setTimeout(check, 500);
    })();
    return true;
  }

  /**
   * Info page "play S2 E5" on Netflix: the deep link opens the series page (/title/<id>). Look
   * the episode up in Netflix's own metadata (same-origin, like its web client) and jump to
   * /watch/<episodeId>. Runs once per player session; falls back to the series page.
   */
  function jumpToNetflixEpisode() {
    if (CONFIG.mode !== "play" || !IS_NETFLIX || !CONFIG.targetSeason || !CONFIG.targetEpisode) return false;
    var KEY = "omnia-episode-jump-" + TOKEN_KEY;
    if (session(KEY)) return false;
    var m = location.pathname.match(/\/title\/(\d+)/);
    if (!m) return false;
    session(KEY, "1");
    var seriesId = m[1];
    function findEpisode() {
      for (var id in NFX_VIDEOS) {
        var v = NFX_VIDEOS[id];
        if (v.mediaType === "tv" && v.seasonNumber === CONFIG.targetSeason && v.episodeNumber === CONFIG.targetEpisode) return id;
      }
      return null;
    }
    discoverNetflixBuilds();
    var bases = [];
    NFX_BUILDS.forEach(function (b) {
      bases.push("/nq/website/memberapi/" + b + "/metadata");
      bases.push("/api/shakti/" + b + "/metadata");
    });
    bases.push("/nq/website/memberapi/release/metadata", "/api/shakti/mre/metadata");
    (function attempt(i) {
      var hit = findEpisode();
      if (hit) return location.replace("/watch/" + hit);
      if (i >= bases.length) return; // stay on the series page; the user picks the episode
      fetch(bases[i] + "?movieid=" + encodeURIComponent(seriesId) + "&imageFormat=webp&withSize=true&materialize=true", { credentials: "include" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) {
          if (json) indexNetflixVideos(json);
          attempt(i + 1);
        })
        .catch(function () { attempt(i + 1); });
    })(0);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Liquid Glass overlay pill (closed shadow DOM so page CSS can't touch it)
  // -------------------------------------------------------------------------------------------
  var host = null, shadow = null, ui = {};
  var hideTimer = null;
  var panelSticky = false;

  var STYLE = [
    ":host{all:initial}",
    ".wrap{position:fixed;top:16px;left:16px;z-index:2147483647;font:500 13px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI Variable Display','Segoe UI',system-ui,sans-serif;color:rgba(255,255,255,.96);",
    "transition:opacity .28s cubic-bezier(.32,.72,0,1),transform .28s cubic-bezier(.32,.72,0,1);opacity:0;transform:translateY(-6px);pointer-events:none}",
    ".wrap.show{opacity:1;transform:none;pointer-events:auto}",
    ".glass{background:rgba(18,18,22,.65);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);",
    "box-shadow:inset 0 1px 0 rgba(255,255,255,.22),inset 0 0 0 1px rgba(255,255,255,.06),0 12px 40px rgba(0,0,0,.45);border-radius:12px}",
    ".pill{display:flex;align-items:center;gap:10px;padding:6px 12px 6px 6px;max-width:min(560px,70vw)}",
    "button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:9px;background:rgba(255,255,255,.12);font-weight:600;transition:background .2s,transform .2s}",
    "button:hover{background:rgba(255,255,255,.2)}button:active{transform:scale(.96)}button:focus-visible{outline:2px solid #fff;outline-offset:2px}",
    "button.primary{background:rgba(255,255,255,.92);color:#0b0b0f}button.primary:hover{background:#fff}",
    ".title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(235,235,245,.72)}",
    ".dot{width:7px;height:7px;border-radius:50%;background:#30d158;flex:none}.dot.warn{background:#ff9f0a}.dot.off{background:rgba(235,235,245,.4)}",
    ".panel{margin-top:10px;padding:14px 16px;max-width:380px}.panel p{margin:0 0 10px;color:rgba(235,235,245,.78)}.panel strong{color:#fff}",
    ".hidden{display:none}",
  ].join("");

  function buildOverlay() {
    if (CONFIG.mode === "import" || !document.documentElement) return;
    host = document.createElement("omnia-overlay");
    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML =
      "<style>" + STYLE + "</style>" +
      '<div class="wrap" part="wrap">' +
      '<div class="glass pill"><button class="back" aria-label="Back to Omnia">&#8592; Omnia</button>' +
      '<span class="dot off"></span><span class="title"></span></div>' +
      '<div class="glass panel hidden"><p class="msg"></p><button class="primary link hidden">Link this profile</button></div>' +
      "</div>";
    ui.wrap = shadow.querySelector(".wrap");
    ui.back = shadow.querySelector(".back");
    ui.dot = shadow.querySelector(".dot");
    ui.title = shadow.querySelector(".title");
    ui.panel = shadow.querySelector(".panel");
    ui.msg = shadow.querySelector(".msg");
    ui.link = shadow.querySelector(".link");

    ui.back.addEventListener("click", function () {
      Promise.resolve(window.__omniaFinalFlush && window.__omniaFinalFlush()).then(function () {
        invoke("player_back_to_hub", { token: CONFIG.token });
      });
    });
    ui.link.addEventListener("click", linkProfile);
    ui.wrap.addEventListener("mouseenter", function () { showOverlay(true); });

    mountOverlay();
    renderStatus();
    if (CONFIG.mode === "connect") showOverlay(true);
  }

  /** Keeps the pill attached, including inside the fullscreen element. */
  function mountOverlay() {
    if (!host) return;
    var parent = document.fullscreenElement || document.documentElement;
    if (parent && host.parentNode !== parent) parent.appendChild(host);
  }

  function showOverlay(sticky) {
    if (!ui.wrap) return;
    mountOverlay();
    ui.wrap.classList.add("show");
    clearTimeout(hideTimer);
    if (panelSticky || (CONFIG.mode === "connect" && !linked)) return;
    if (!sticky) hideTimer = setTimeout(function () { ui.wrap.classList.remove("show"); }, 2500);
  }

  /** Shows the info panel; `linkLabel` adds the "Link …" button. */
  function showPanel(message, linkLabel) {
    if (!ui.panel) return;
    ui.panel.classList.remove("hidden");
    ui.msg.textContent = message;
    if (linkLabel) {
      ui.link.textContent = linkLabel;
      ui.link.classList.remove("hidden");
    } else {
      ui.link.classList.add("hidden");
    }
    panelSticky = true;
    showOverlay(true);
  }

  function hidePanel() {
    if (!ui.panel) return;
    ui.panel.classList.add("hidden");
    panelSticky = false;
  }

  function renderStatus() {
    if (!ui.wrap) return;
    if (CONFIG.mode === "connect") {
      ui.title.textContent = "Linking " + CONFIG.providerName + " to " + CONFIG.appProfileName;
      return;
    }
    var d = lastDetected;
    var label = CONFIG.title || (d && d.title) || CONFIG.providerName;
    if (d && d.seasonNumber && d.episodeNumber) label += " · S" + d.seasonNumber + " E" + d.episodeNumber;
    ui.title.textContent = label;
    var a = lastAck && lastAck.attribution;
    var observed = (lastAck && lastAck.observedProfileName) || "This profile";
    if (a === "recording") {
      ui.dot.className = "dot";
      hidePanel();
    } else if (a === "unlinked") {
      ui.dot.className = "dot warn";
      ui.title.textContent = "Not tracking yet";
      showPanel(
        observed + " on " + CONFIG.providerName + " isn't linked to " + CONFIG.appProfileName + ". Link it so this viewing is saved to " + CONFIG.appProfileName + " only.",
        "Link to " + CONFIG.appProfileName,
      );
    } else if (a === "mismatch") {
      ui.dot.className = "dot warn";
      ui.title.textContent = "Not tracking: wrong profile";
      showPanel(
        observed + (lastAck.ownerProfileName ? " belongs to " + lastAck.ownerProfileName + " in Omnia" : " isn't " + CONFIG.appProfileName + "'s profile") +
          ". Switch to " + (CONFIG.expectedOttProfileName || "your linked profile") + " in " + CONFIG.providerName + " to track this.",
        null,
      );
    } else {
      ui.dot.className = "dot off";
      if (lastAck && lastAck.message) ui.title.textContent = lastAck.message;
      if (a !== "unverified") hidePanel();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Profile linking (connect mode, or "Link to …" from the pill in play mode)
  // -------------------------------------------------------------------------------------------
  var linked = false;
  var currentProfile = null;

  // Connect mode links automatically once the same signed-in identity has been seen for a few
  // polls in a row (the page has settled past sign-in and any "Who's watching?" step); the
  // window then closes and the history import starts. The button links immediately.
  var AUTO_LINK_POLLS = 3;
  var stablePolls = 0;
  var lastSeenId = null;

  // Auto-linking needs evidence the user chose: this window saw them signed out or on the
  // "Who's watching?" picker first. Already signed in on arrival (a remembered profile) →
  // they confirm with the button instead, so nobody's profile is linked silently.
  var ACTED_KEY = "omnia-connect-acted-" + TOKEN_KEY;

  /** A real signed-out page or a profile picker (not just a page that hasn't rendered yet). */
  function sawSignInOrPicker() {
    if (!document.body || document.readyState === "loading") return false;
    if (/\/(login|signin|sign-in)(\/|$|\?)/i.test(location.pathname)) return true;
    if (IS_NETFLIX) return onProfileGate();
    return AUTH_PATH.test(location.pathname) || onGenericProfileGate() || hasSignInCta();
  }

  function pollProfile() {
    if (CONFIG.mode !== "connect" || linked) return;
    var p = detectOttProfile();
    currentProfile = p;
    stablePolls = p && p.id === lastSeenId ? stablePolls + 1 : p ? 1 : 0;
    lastSeenId = p ? p.id : null;
    if (!p && sawSignInOrPicker()) session(ACTED_KEY, "1");
    var auto = session(ACTED_KEY) === "1";
    if (ui.panel) {
      if (p) {
        showPanel("", auto ? "Link now" : "Link this profile");
        ui.msg.textContent = "";
        var who = p.name || (p.id === "account" ? "your account" : "profile " + p.id.slice(0, 6));
        ui.msg.append(
          "Signed in to " + CONFIG.providerName + " as ",
          Object.assign(document.createElement("strong"), { textContent: who }),
          auto ? ". Linking to " + CONFIG.appProfileName + "…" : ". Link it to " + CONFIG.appProfileName + "?",
        );
      } else {
        showPanel("Sign in to " + CONFIG.providerName + " and choose who's watching.", null);
      }
    }
    if (p && auto && stablePolls >= AUTO_LINK_POLLS) linkProfile();
  }

  var linking = false;

  function linkProfile() {
    var p = CONFIG.mode === "connect" ? currentProfile : detectOttProfile();
    if (!p || linked || linking) return;
    linking = true;
    var original = ui.link.textContent;
    ui.link.textContent = "Linking…";
    invoke("report_ott_profile", { token: CONFIG.token, profile: p }).then(function (res) {
      linking = false;
      if (res && res.linked) {
        linked = true;
        if (CONFIG.mode === "connect") {
          showPanel("Linked ✓ Importing your " + CONFIG.providerName + " history…", null);
        } else {
          showPanel("Linked ✓ Tracking " + CONFIG.appProfileName + "'s viewing.", null);
          setTimeout(function () {
            hidePanel();
            sendSync("metadata");
          }, 1800);
        }
      } else {
        showPanel((res && res.message) || "Couldn't link this profile. Try again.", original);
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // Import mode: scrape watch history / continue-watching from the rendered page
  // -------------------------------------------------------------------------------------------
  function progressWithin(el) {
    if (!el) return null;
    var bar = el.querySelector('[role="progressbar"][aria-valuenow]');
    if (bar) {
      var now = parseFloat(bar.getAttribute("aria-valuenow"));
      var max = parseFloat(bar.getAttribute("aria-valuemax") || "100");
      if (isFinite(now) && max > 0) return Math.max(0, Math.min(1, now / max));
    }
    var nodes = el.querySelectorAll("[style*='width']");
    for (var i = 0; i < nodes.length; i++) {
      var w = nodes[i].style.width;
      var r = nodes[i].getBoundingClientRect();
      if (/%$/.test(w) && r.height > 0 && r.height <= 10) {
        var pct = parseFloat(w);
        if (isFinite(pct)) return Math.max(0, Math.min(1, pct / 100));
      }
    }
    return null;
  }

  function cardTitle(a) {
    var img = a.querySelector("img[alt]");
    return clean(a.getAttribute("aria-label") || a.getAttribute("title") || (img && img.getAttribute("alt")) || a.textContent);
  }

  function itemFromText(rawTitle, extra) {
    var t = stripProviderSuffix(rawTitle);
    if (!t) return null;
    var p = parseSE(t);
    var series = p ? clean(t.split(SE_PATTERNS[0])[0] || t.split(EP_ONLY)[0] || "").replace(/[\s:,\-|·]+$/, "") : t;
    return Object.assign(
      {
        title: series || t,
        seasonNumber: p && p.season ? p.season : null,
        episodeNumber: p ? p.episode : null,
        episodeTitle: p ? p.rest : null,
        isTv: !!p,
        progressRatio: null,
        watchedAt: null,
      },
      extra || {},
    );
  }

  function scrapeContinueWatching() {
    var items = [];
    var seen = {};
    var labels = Array.prototype.filter.call(
      document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading],span,div,p"),
      function (el) {
        var t = clean(el.textContent);
        return el.childElementCount === 0 && t.length < 60 && /(continue|resume|keep) watching/i.test(t);
      },
    );
    labels.forEach(function (label) {
      var container = label;
      for (var depth = 0; depth < 7 && container; depth++) {
        container = container.parentElement;
        if (container && container.querySelectorAll("a[href] img").length >= 1) break;
      }
      if (!container) return;
      var cards = Array.prototype.filter.call(container.querySelectorAll("a[href]"), function (a) { return !!a.querySelector("img"); });
      if (!cards.length) {
        // Tiles that are clickable <div>s (no link): anything focusable / labelled holding an image.
        cards = Array.prototype.filter.call(
          container.querySelectorAll('[role=button],[role=link],[tabindex],[aria-label],[data-testid*="tile" i],[data-testid*="card" i],li,article'),
          function (el) { return !!el.querySelector("img") && el.querySelectorAll("img").length <= 3; },
        );
      }
      cards.forEach(function (a) {
        var label = cardTitle(a);
        var key = a.href || label;
        if (!label || seen[key]) return;
        seen[key] = true;
        var card = a.closest("li,article,[role=listitem]") || a;
        var item = itemFromText(label, { progressRatio: progressWithin(card) });
        if (item && !GEN_TRAY_TEXT.test(item.title)) items.push(item);
      });
    });
    return items;
  }

  function parseDateText(t) {
    var s = clean(t);
    if (!s || s.length > 40 || !/\d{4}|\d{1,2}[\/.\-]\d{1,2}/.test(s)) return null;
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function scrapePrimeHistory() {
    var items = [];
    var seen = {};
    document.querySelectorAll('a[href*="/detail/"]').forEach(function (a) {
      var key = a.href + "|" + clean(a.textContent);
      if (seen[key]) return;
      seen[key] = true;
      var watchedAt = null;
      for (var el = a; el && !watchedAt && el !== document.body; el = el.parentElement) {
        for (var sib = el.previousElementSibling; sib && !watchedAt; sib = sib.previousElementSibling) {
          if (sib.childElementCount <= 2) watchedAt = parseDateText(sib.textContent);
        }
      }
      var row = a.closest("li,article,[role=listitem]") || a.parentElement || a;
      var rowText = clean(row.textContent);
      var item = itemFromText(cardTitle(a), { watchedAt: watchedAt, progressRatio: progressWithin(row) });
      if (!item) return;
      var p = parseSE(rowText);
      if (p && !item.episodeNumber) {
        item.isTv = true;
        item.seasonNumber = p.season;
        item.episodeNumber = p.episode;
      }
      items.push(item);
    });
    return items;
  }

  function submitHistory(items, error, notes) {
    return invoke("submit_scraped_history", {
      // Diagnostics for the local log: HTTP statuses, page counts and totals only.
      notes: notes && notes.length ? notes.join("; ").slice(0, 2000) : null,
      token: CONFIG.token,
      // Lifetime activity: no practical cap (a decade of daily viewing is well under this).
      items: items.slice(0, 100000),
      ottProfile: detectOttProfile(),
      pageUrl: location.origin + location.pathname,
      error: items.length ? null : error,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Generic import: the provider's own JSON (embedded app state + the app's API responses)
  //
  // Hotstar, Disney+, Apple TV and most React/Redux OTT apps render "Continue Watching" from
  // state that is already on the page (window.__INITIAL_STATE__, __NEXT_DATA__, Apollo / Redux
  // stores) or that their app fetches as JSON. Reading that is far more reliable than the DOM:
  // a tray is found by its heading ("Continue Watching", "Watch History"…) or key name, then its
  // items are read by shape (a title plus show / season / episode / progress fields).
  // -------------------------------------------------------------------------------------------
  var GEN = { items: [], keys: {}, sources: {}, responses: 0, trays: 0, paths: {} };
  var GEN_TRAY_TEXT = /\b(continue|resume|keep) watching\b|\bwatch(ing)? history\b|\brecently watched\b|\bwatched recently\b/i;
  var GEN_TRAY_KEY = /^(continue_?watching|cw|cw_?tray|cw_?widget|watch_?history|recently_?watched|resume_?watching|keep_?watching)$/i;
  var GEN_TITLE = ["title", "name", "displayTitle", "display_title", "contentTitle", "content_title", "episodeTitle", "episodeName", "heading"];
  var GEN_SUBTITLE = ["subTitle", "sub_title", "subtitle", "description_label", "episodeLabel", "episode_label"];
  var GEN_SHOW = ["showName", "showTitle", "seriesName", "seriesTitle", "parentTitle", "showDisplayTitle", "series_name", "show_name", "seriesDisplayName"];
  var GEN_SEASON = ["seasonNo", "seasonNumber", "season_no", "season_number", "seasonNum", "season"];
  var GEN_EPISODE = ["episodeNo", "episodeNumber", "episode_no", "episode_number", "episodeNum", "episode"];
  var GEN_RATIO = ["watchedRatio", "watched_ratio", "progressRatio", "progress_ratio", "completionRatio", "percentWatched", "watchedPercentage", "progressPercent", "progress_percentage", "watchProgress", "progress", "percentage"];
  var GEN_POS = ["watchedDuration", "watched_duration", "resumeAt", "resume_at", "resumePoint", "resumePosition", "bookmark", "playbackPosition", "offsetSeconds", "watchedSeconds", "position"];
  var GEN_DUR = ["duration", "contentDuration", "durationSeconds", "duration_seconds", "runtime", "totalDuration", "durationInSeconds"];
  var GEN_DATE = ["lastWatched", "lastWatchedAt", "last_watched", "watchedAt", "watched_at", "updatedAt", "lastPlayed", "lastViewed", "timestamp"];
  var GEN_TYPE = ["contentType", "content_type", "assetType", "asset_type", "type", "entityType", "mediaType"];
  var GEN_LABEL_KEYS = ["title", "name", "header", "heading", "trayTitle", "widgetName"];

  function genPick(o, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v;
      try { v = o[keys[i]]; } catch (_) { continue; }
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return null;
  }
  function genStr(v) {
    if (typeof v === "string") return clean(v);
    // Localised text objects: { text: "…" } / { value: "…" } / { en: "…" }.
    if (v && typeof v === "object" && !Array.isArray(v)) {
      var inner = v.text || v.value || v.en || v["default"] || null;
      return typeof inner === "string" ? clean(inner) : "";
    }
    return "";
  }
  function genNum(v) {
    if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) v = parseFloat(v);
    if (v && typeof v === "object") v = v.number != null ? v.number : v.value;
    return typeof v === "number" && isFinite(v) ? v : null;
  }
  function genDate(v) {
    var n = genNum(v);
    if (n !== null) {
      if (n > 1e9 && n < 1e11) n *= 1000; // epoch seconds
      else if (n < 1e11) return null;
      var d = new Date(n);
      return d.getFullYear() > 2000 && d.getTime() <= Date.now() + 864e5 ? d.toISOString() : null;
    }
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      var t = new Date(v);
      return isNaN(t.getTime()) ? null : t.toISOString();
    }
    return null;
  }

  /** One watched item from a tray entry, or null when it isn't shaped like one. */
  function genItem(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    // Many apps wrap the payload: { content: {...} }, { data: {...} }, { item: {...} }.
    var src = o;
    for (var w = 0; w < 3; w++) {
      if (genStr(genPick(src, GEN_TITLE))) break;
      var inner = src.content || src.data || src.item || src.asset || src.contentInfo || src.widget || src.playable_content || src.playableContent || src.tile || null;
      if (!inner || typeof inner !== "object" || Array.isArray(inner)) break;
      src = inner;
    }
    var title = genStr(genPick(src, GEN_TITLE));
    var show = genStr(genPick(src, GEN_SHOW)) || genStr(genPick(o, GEN_SHOW));
    if (!title && !show) return null;
    if (title && (title.length > 160 || BRAND_ONLY.test(title) || GEN_TRAY_TEXT.test(title))) return null;
    var season = genNum(genPick(src, GEN_SEASON));
    var episode = genNum(genPick(src, GEN_EPISODE));
    var type = String(genPick(src, GEN_TYPE) || "").toLowerCase();
    var isTv = !!(show && show !== title) || episode !== null || /episode|show|series|tv/.test(type);
    var ratio = genNum(genPick(src, GEN_RATIO));
    if (ratio !== null) ratio = ratio > 1 ? Math.min(100, ratio) / 100 : Math.max(0, ratio);
    var pos = genNum(genPick(src, GEN_POS));
    var dur = genNum(genPick(src, GEN_DUR));
    // Milliseconds (anything longer than a day) → seconds.
    if (dur !== null && dur > 86400) { dur /= 1000; if (pos !== null) pos /= 1000; }
    if (pos !== null && dur && ratio === null) ratio = Math.max(0, Math.min(1, pos / dur));
    var series = show && show !== title ? show : title;
    var epTitle = show && show !== title ? title : null;
    // "S2 E4 · Title" subtitles (Hotstar tiles): numbers from the subtitle, series from the title.
    var sub = genStr(genPick(src, GEN_SUBTITLE));
    var ps = sub ? parseSE(sub) : null;
    if (ps && !show) {
      season = season || ps.season;
      episode = episode || ps.episode;
      isTv = true;
      if (ps.rest && ps.rest !== title) epTitle = ps.rest;
    }
    var p = !show && !ps && title ? parseSE(title) : null;
    if (p) {
      series = clean(title.split(SE_PATTERNS[0])[0] || title.split(EP_ONLY)[0] || title).replace(/[\s:,\-|·]+$/, "") || title;
      season = season || p.season;
      episode = episode || p.episode;
      epTitle = p.rest;
      isTv = true;
    }
    series = stripProviderSuffix(series);
    if (!series) return null;
    return {
      title: series,
      seasonNumber: season && season > 0 && season < 200 ? Math.round(season) : null,
      episodeNumber: episode && episode > 0 && episode < 5000 ? Math.round(episode) : null,
      episodeTitle: epTitle,
      isTv: isTv,
      progressRatio: ratio,
      progressSeconds: pos !== null && dur ? pos : null,
      durationSeconds: pos !== null && dur ? dur : null,
      watchedAt: genDate(genPick(src, GEN_DATE)) || genDate(genPick(o, GEN_DATE)),
    };
  }

  function genAdd(item, source) {
    var key = [item.title.toLowerCase(), item.seasonNumber || "", item.episodeNumber || "", (item.episodeTitle || "").toLowerCase()].join("|");
    if (GEN.keys[key]) return false;
    GEN.keys[key] = true;
    GEN.items.push(item);
    GEN.sources[source] = (GEN.sources[source] || 0) + 1;
    return true;
  }

  /** Item arrays anywhere under a tray node. */
  function genHarvestTray(node, source) {
    var added = 0;
    var seen = typeof WeakSet === "function" ? new WeakSet() : null;
    (function walk(n, depth) {
      if (!n || typeof n !== "object" || depth > 7) return;
      if (seen) { if (seen.has(n)) return; seen.add(n); }
      if (Array.isArray(n)) {
        var items = [];
        var objects = 0;
        for (var i = 0; i < n.length && i < 500; i++) {
          if (n[i] && typeof n[i] === "object") objects++;
          var it = genItem(n[i]);
          if (it) items.push(it);
        }
        if (items.length && items.length * 2 >= objects) {
          items.forEach(function (it) { if (genAdd(it, source)) added++; });
          return;
        }
        for (var j = 0; j < n.length && j < 500; j++) walk(n[j], depth + 1);
        return;
      }
      var keys;
      try { keys = Object.keys(n); } catch (_) { return; }
      for (var k = 0; k < keys.length && k < 300; k++) {
        var c;
        try { c = n[keys[k]]; } catch (_) { continue; }
        if (c && typeof c === "object") walk(c, depth + 1);
      }
    })(node, 0);
    return added;
  }

  /** Finds Continue-Watching / history trays (by heading text or key name) in any JSON value. */
  function genFindTrays(root, source) {
    var added = 0;
    var seen = typeof WeakSet === "function" ? new WeakSet() : null;
    var budget = 300000;
    var stack = [];
    (function walk(n, depth, viaKey) {
      if (!n || typeof n !== "object" || depth > 16 || --budget < 0) return;
      if (seen) { if (seen.has(n)) return; seen.add(n); }
      stack.push(n);
      try { visit(n, depth, viaKey); } finally { stack.pop(); }
    })(root, 0, null);
    return added;

    function walk(n, depth, viaKey) {
      if (!n || typeof n !== "object" || depth > 16 || --budget < 0) return;
      if (seen) { if (seen.has(n)) return; seen.add(n); }
      stack.push(n);
      try { visit(n, depth, viaKey); } finally { stack.pop(); }
    }

    function visit(n, depth, viaKey) {
      var isTray = !!viaKey && GEN_TRAY_KEY.test(String(viaKey).replace(/[\s-]/g, "_"));
      if (!isTray && !Array.isArray(n)) {
        var kind = n.template || n.widgetType || n.widget_type || n.trayType || n.tray_type || n.layout || n.__typename || n.type;
        if (typeof kind === "string" && kind.length < 80 && /continue.?watch|cw.?tray|watch.?history|recently.?watched/i.test(kind)) isTray = true;
      }
      if (!isTray && !Array.isArray(n)) {
        for (var h = 0; h < GEN_LABEL_KEYS.length && !isTray; h++) {
          var label = genStr(n[GEN_LABEL_KEYS[h]]);
          if (label && label.length < 60 && GEN_TRAY_TEXT.test(label)) isTray = true;
        }
      }
      if (isTray) {
        GEN.trays++;
        // The heading's own node first, then up to three ancestors (header -> data -> widget).
        for (var up = stack.length - 1, got = 0; up >= 0 && up >= stack.length - 4 && !got; up--) {
          got = genHarvestTray(stack[up], source);
          added += got;
        }
        return;
      }
      if (Array.isArray(n)) {
        for (var i = 0; i < n.length && i < 2000; i++) walk(n[i], depth + 1, null);
        return;
      }
      var keys;
      try { keys = Object.keys(n); } catch (_) { return; }
      for (var k = 0; k < keys.length && k < 1000; k++) {
        var c;
        try { c = n[keys[k]]; } catch (_) { continue; }
        if (c && typeof c === "object") walk(c, depth + 1, keys[k]);
        else if (typeof c === "string" && c.length > 50 && c.length < 4e6 && (c.charAt(0) === "{" || c.charAt(0) === "[") && /watch/i.test(c)) {
          // Serialised state ("__INITIAL_STATE__": "{…}").
          try { walk(JSON.parse(c), depth + 1, keys[k]); } catch (_) {}
        }
      }
    }
  }

  function genConsiderText(text, source) {
    if (typeof text !== "string" || text.length < 2 || text.length > 8e6 || !/watch/i.test(text)) return 0;
    var first = text.charAt(0);
    if (first !== "{" && first !== "[") return 0;
    try { return genFindTrays(JSON.parse(text), source); } catch (_) { return 0; }
  }

  var GEN_GLOBALS = ["__INITIAL_STATE__", "__PRELOADED_STATE__", "__REDUX_STATE__", "__APOLLO_STATE__", "__NEXT_DATA__", "__NUXT__", "__APP_STATE__", "__STATE__", "__DATA__", "INITIAL_STATE"];

  /** Embedded app state: well-known globals, a Redux store, and inline JSON scripts. */
  function genScanState() {
    var found = 0;
    GEN_GLOBALS.forEach(function (k) {
      var v;
      try { v = window[k]; } catch (_) { return; }
      if (v && typeof v === "object") found += genFindTrays(v, "page state");
      else if (typeof v === "string") found += genConsiderText(v.trim(), "page state");
    });
    try {
      if (window.store && typeof window.store.getState === "function") found += genFindTrays(window.store.getState(), "page state");
    } catch (_) {}
    document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__').forEach(function (el) {
      found += genConsiderText((el.textContent || "").trim(), "page state");
    });
    // Inline "window.__INITIAL_STATE__ = {…};" assignments that never became readable globals.
    document.querySelectorAll("script:not([src])").forEach(function (el) {
      var t = el.textContent || "";
      if (t.length > 4e6 || !/__\w*STATE__/.test(t)) return;
      var m = t.match(/__\w*STATE__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      if (m) found += genConsiderText(m[1], "page state");
    });
    return found;
  }

  function genSameSite(url) {
    try {
      var site = function (h) { return h.split(".").slice(-2).join("."); };
      return site(new URL(url, location.href).hostname) === site(location.hostname);
    } catch (_) {
      return false;
    }
  }

  /** The app's own JSON responses (read-only; requests are untouched). Installed at document start. */
  function installGenericCapture() {
    if (typeof window.fetch === "function") {
      var origFetch = window.fetch;
      window.fetch = function (input) {
        var p = origFetch.apply(window, arguments);
        try {
          var url = typeof input === "string" ? input : (input && input.url) || String(input || "");
          if (genSameSite(url)) {
            p.then(function (r) {
              var type = (r.headers && r.headers.get("content-type")) || "";
              if (!r.ok || type.indexOf("json") < 0) return;
              GEN.responses++;
              genNotePath(url);
              r.clone().text().then(function (t) { genConsiderText(t, "app requests"); }).catch(function () {});
            }).catch(function () {});
          }
        } catch (_) {}
        return p;
      };
    }
    var X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!X) return;
    var origOpen = X.open;
    var origSend = X.send;
    X.open = function (method, url) {
      try { this.__omniaGenUrl = String(url); } catch (_) {}
      return origOpen.apply(this, arguments);
    };
    X.send = function () {
      var xhr = this;
      if (genSameSite(xhr.__omniaGenUrl || "")) {
        xhr.addEventListener("load", function () {
          try {
            if (xhr.status < 200 || xhr.status >= 300) return;
            GEN.responses++;
            genNotePath(xhr.__omniaGenUrl);
            if (xhr.responseType === "json") genFindTrays(xhr.response, "app requests");
            else if (!xhr.responseType || xhr.responseType === "text") genConsiderText(xhr.responseText, "app requests");
          } catch (_) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  /** Endpoint paths (no query strings: they can carry ids) for the diagnostics line. */
  function genNotePath(url) {
    try {
      var u = new URL(url, location.href);
      var path = (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/\d{3,}(?=\/|$)/g, "/#")).slice(0, 70);
      GEN.paths[path] = (GEN.paths[path] || 0) + 1;
    } catch (_) {}
  }

  /** Diagnostics for the local log: counts, page path and endpoint paths only, never titles. */
  function genNotes(domCount) {
    var by = Object.keys(GEN.sources).map(function (k) { return k + " " + GEN.sources[k]; }).join(", ");
    var paths = Object.keys(GEN.paths).slice(0, 12).map(function (k) { return k + (GEN.paths[k] > 1 ? " x" + GEN.paths[k] : ""); }).join(", ");
    var headings = Array.prototype.filter.call(document.querySelectorAll("h1,h2,h3,h4,[role=heading]"), function (el) { return isVisible(el); }).length;
    return [
      "page: " + location.pathname.replace(/\/\d{3,}(?=\/|$)/g, "/#").slice(0, 60),
      "state/app entries: " + GEN.items.length + (by ? " (" + by + ")" : ""),
      "trays found: " + GEN.trays,
      "json responses: " + GEN.responses + (paths ? " (" + paths + ")" : ""),
      "rendered cards: " + domCount,
      "visible headings: " + headings + ", images: " + document.images.length,
      "sign-in prompt: " + (hasSignInCta() ? "yes" : "no") + ", profile picker: " + (onGenericProfileGate() ? "yes" : "no"),
    ];
  }

  function runGenericImport() {
    var scraper = CONFIG.scraper === "primevideo_history" ? scrapePrimeHistory : scrapeContinueWatching;
    var deadline = Date.now() + (CONFIG.scrapeTimeoutMs || 30000);
    var lastCount = -1, stableRounds = 0, scrolls = 0;

    /** Page state + captured JSON first (exact numbers and progress), then rendered cards. */
    function collect() {
      try { genScanState(); } catch (_) {}
      var dom = [];
      try { dom = scraper(); } catch (_) {}
      var merged = GEN.items.slice();
      var have = {};
      merged.forEach(function (it) { have[it.title.toLowerCase()] = true; });
      dom.forEach(function (it) { if (!have[it.title.toLowerCase()]) merged.push(it); });
      return { items: merged, dom: dom.length };
    }

    function tick() {
      var r = collect();
      var items = r.items;
      if (items.length > 0 && items.length === lastCount) stableRounds++;
      else stableRounds = 0;
      lastCount = items.length;

      // Lazy-loaded lists / trays: scroll to the bottom a few times to load more entries.
      if (scrolls < 12 && document.body) {
        scrolls++;
        window.scrollTo(0, document.body.scrollHeight);
      }

      if ((items.length > 0 && stableRounds >= 2) || Date.now() > deadline) {
        submitHistory(items, "No history entries were found on " + location.hostname, genNotes(r.dom));
        return;
      }
      setTimeout(tick, 1500);
    }
    setTimeout(tick, 2500);
  }

  // -------------------------------------------------------------------------------------------
  // Netflix history import (hidden window)
  //
  // Strategies, most to least robust — none depends on Netflix's CSS class names:
  //   1. Capture: fetch / XHR are hooked at document start (this script runs before any page
  //      script), so the JSON that Netflix's own viewing-activity page requests is harvested,
  //      whatever endpoint and headers the current web app uses. "Show more" pulls more pages.
  //   2. Embedded state: window.netflix.reactContext / falcorCache and JSON <script> blobs.
  //   3. Netflix's Shakti API called in-page with the web client's own headers.
  //   4. DOM rows — only once the React page has hydrated, and without relying on class names.
  // Entries are recognised by shape (a title plus a watch date), not by a fixed schema path.
  // -------------------------------------------------------------------------------------------
  var NFX = { items: [], keys: {}, total: 0, responses: 0, sources: {}, paths: {}, hits: {}, dataRequest: null, template: null, clicks: 0, buttonSeen: false };
  var NFX_TITLE_KEYS = ["seriesTitle", "title", "videoTitle", "showTitle"];
  var NFX_DATE_KEYS = ["date", "dateWatched", "watchedDate", "lastWatched", "viewedAt", "timestamp"];
  var nfxLastReport = 0;

  /** Tells the hub how far a (possibly multi-minute) lifetime import has got. Throttled. */
  function nfxReportProgress(force) {
    var now = Date.now();
    if (!force && now - nfxLastReport < 1200) return;
    nfxLastReport = now;
    invoke("report_scrape_progress", { token: CONFIG.token, fetched: NFX.items.length, total: NFX.total || null });
  }

  function nfxSleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function nfxText(v) {
    var s = typeof v === "string" ? clean(v) : "";
    return s || null;
  }

  function nfxEpochMs(v) {
    if (typeof v === "number" && isFinite(v)) return v > 1e11 ? v : v > 1e9 ? v * 1000 : null;
    if (typeof v === "string" && v.length < 40 && /\d{4}/.test(v)) {
      var t = Date.parse(v);
      return isNaN(t) ? null : t;
    }
    return null;
  }

  function nfxFirst(o, keys, pick) {
    for (var i = 0; i < keys.length; i++) {
      var r = pick(o[keys[i]]);
      if (r != null) return r;
    }
    return null;
  }

  function nfxLooksViewed(o) {
    return !!o && typeof o === "object" && !Array.isArray(o) && nfxFirst(o, NFX_TITLE_KEYS, nfxText) != null && nfxFirst(o, NFX_DATE_KEYS, nfxEpochMs) != null;
  }

  function nfxToItem(v) {
    var series = nfxText(v.seriesTitle) || nfxText(v.showTitle);
    var isTv = !!series || v.series != null;
    var seasonMatch = String(v.seasonDescriptor || "").match(/\d+/);
    var ms = nfxFirst(v, NFX_DATE_KEYS, nfxEpochMs);
    return {
      title: isTv ? series || nfxText(v.title) : nfxText(v.title) || nfxText(v.videoTitle),
      isTv: isTv,
      // "Part Three" / "Volume II" / "Limited Series" have no digits: Rust parses the raw label
      // and, failing that, places the episode by its name across the whole series.
      seasonNumber: isTv && seasonMatch ? parseInt(seasonMatch[0], 10) : null,
      seasonLabel: isTv ? nfxText(v.seasonDescriptor) || null : null,
      // The watched video's id: /watch/<id> reopens exactly this episode.
      ottVideoId: v.movieID != null && /^\d{3,12}$/.test(String(v.movieID)) ? String(v.movieID) : null,
      episodeNumber: null,
      episodeTitle: nfxText(v.episodeTitle),
      progressRatio: null,
      progressSeconds: typeof v.bookmark === "number" ? v.bookmark : null,
      durationSeconds: typeof v.duration === "number" ? v.duration : null,
      watchedAt: ms ? new Date(ms).toISOString() : null,
    };
  }

  function nfxHarvest(list, source) {
    var added = 0;
    list.forEach(function (v) {
      var it = nfxToItem(v);
      if (!it.title) return;
      var key = [it.ottVideoId || "", it.title, it.episodeTitle || "", it.watchedAt || ""].join("|");
      if (NFX.keys[key]) return;
      NFX.keys[key] = true;
      NFX.items.push(it);
      added++;
    });
    if (added) NFX.sources[source] = (NFX.sources[source] || 0) + added;
    return added;
  }

  /** Harvests every viewing-activity-shaped array inside a JSON value (cycle- and size-safe). */
  function nfxCollect(root) {
    var seen = typeof WeakSet === "function" ? new WeakSet() : null;
    var budget = 250000;
    var lists = [];
    (function walk(node, depth) {
      if (!node || typeof node !== "object" || depth > 12 || --budget < 0) return;
      if (seen) {
        if (seen.has(node)) return;
        seen.add(node);
      }
      if (typeof node.vhSize === "number" && node.vhSize > NFX.total) NFX.total = node.vhSize;
      if (Array.isArray(node)) {
        var objects = 0;
        var viewed = [];
        for (var i = 0; i < node.length && i < 5000; i++) {
          var x = node[i];
          if (x && typeof x === "object") {
            objects++;
            if (nfxLooksViewed(x)) viewed.push(x);
          }
        }
        if (viewed.length && viewed.length * 2 >= objects) {
          lists.push(viewed);
          return;
        }
        for (var j = 0; j < node.length && j < 5000; j++) walk(node[j], depth + 1);
        return;
      }
      var keys;
      try { keys = Object.keys(node); } catch (_) { return; }
      for (var k = 0; k < keys.length; k++) {
        var child;
        try { child = node[keys[k]]; } catch (_) { continue; }
        walk(child, depth + 1);
      }
    })(root, 0);
    return lists;
  }

  /** Harvests every viewing-activity-shaped array inside a JSON value. */
  function nfxFindViewed(root, source) {
    var found = 0;
    nfxCollect(root).forEach(function (list) { found += nfxHarvest(list, source); });
    return found;
  }

  function nfxConsiderText(text, source) {
    if (typeof text !== "string" || text.length < 2 || text.length > 8e6) return 0;
    var first = text.charAt(0);
    if (first !== "{" && first !== "[") return 0;
    try { return nfxFindViewed(JSON.parse(text), source); } catch (_) { return 0; }
  }

  function nfxPath(url) {
    try {
      var u = new URL(url, location.href);
      return (u.hostname.replace(/^www\./, "") + u.pathname).slice(0, 80);
    } catch (_) {
      return "?";
    }
  }

  /**
   * Bookkeeping for each Netflix JSON response the page received: which paths answered (for
   * the diagnostic log) and the first request that actually carried viewing activity — that
   * request is replayed page by page, whatever endpoint the current web app uses.
   */
  function nfxNoteResponse(url, method, headers, body, found) {
    var path = nfxPath(url);
    NFX.paths[path] = (NFX.paths[path] || 0) + 1;
    if (found > 0) {
      NFX.hits[path] = (NFX.hits[path] || 0) + found;
      if (!NFX.dataRequest) NFX.dataRequest = { url: String(url), method: String(method || "GET").toUpperCase(), headers: headers || {}, body: typeof body === "string" ? body : null };
    }
  }

  function nfxSameSite(url) {
    try {
      return /(^|\.)netflix\.com$/i.test(new URL(url, location.href).hostname);
    } catch (_) {
      return false;
    }
  }

  /** Observes the page's own requests. Installed at document start, before Netflix's scripts. */
  /** Plain object from Headers / [k, v][] / object. */
  function nfxHeadersObject(h) {
    var out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== "undefined" && h instanceof Headers) h.forEach(function (v, k) { out[k] = v; });
      else if (Array.isArray(h)) h.forEach(function (p) { out[p[0]] = p[1]; });
      else Object.keys(h).forEach(function (k) { out[k] = h[k]; });
    } catch (_) {}
    return out;
  }

  /** Netflix's own paged viewing-activity request (URL + headers), replayed page by page. */
  function nfxRememberTemplate(url, headers) {
    try {
      var u = new URL(url, location.href);
      if (!/viewingactivity/i.test(u.pathname) || !u.searchParams.has("pg")) return;
      NFX.template = { url: u.toString(), headers: headers || {} };
    } catch (_) {}
  }

  function installNetflixCapture() {
    if (typeof window.fetch === "function") {
      var origFetch = window.fetch;
      NFX.fetch = origFetch;
      window.fetch = function (input, init) {
        var p = origFetch.apply(window, arguments);
        try {
          var url = typeof input === "string" ? input : (input && input.url) || String(input || "");
          if (nfxSameSite(url)) {
            var hdrs = nfxHeadersObject((init && init.headers) || (input && typeof input === "object" && input.headers));
            var method = (init && init.method) || (input && typeof input === "object" && input.method) || "GET";
            var reqBody = init && typeof init.body === "string" ? init.body : null;
            nfxRememberTemplate(url, hdrs);
            p.then(function (r) {
              var type = (r.headers && r.headers.get("content-type")) || "";
              if (!r.ok || type.indexOf("json") < 0) return;
              NFX.responses++;
              r.clone().text().then(function (t) {
                nfxNoteResponse(url, method, hdrs, reqBody, nfxConsiderText(t, "page requests"));
              }).catch(function () {});
            }).catch(function () {});
          }
        } catch (_) {}
        return p;
      };
    }
    var X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!X) return;
    var origOpen = X.open;
    var origSend = X.send;
    var origSetHeader = X.setRequestHeader;
    X.open = function (method, url) {
      try {
        this.__omniaUrl = String(url);
        this.__omniaMethod = String(method || "GET");
        this.__omniaHeaders = {};
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };
    X.setRequestHeader = function (name, value) {
      try { if (this.__omniaHeaders) this.__omniaHeaders[name] = value; } catch (_) {}
      return origSetHeader.apply(this, arguments);
    };
    X.send = function (sent) {
      var xhr = this;
      if (nfxSameSite(xhr.__omniaUrl || "")) {
        nfxRememberTemplate(xhr.__omniaUrl, xhr.__omniaHeaders);
        xhr.addEventListener("load", function () {
          try {
            if (xhr.status < 200 || xhr.status >= 300) return;
            NFX.responses++;
            var found = 0;
            if (xhr.responseType === "json") found = nfxFindViewed(xhr.response, "page requests");
            else if (!xhr.responseType || xhr.responseType === "text") found = nfxConsiderText(xhr.responseText, "page requests");
            nfxNoteResponse(xhr.__omniaUrl, xhr.__omniaMethod, xhr.__omniaHeaders, typeof sent === "string" ? sent : null, found);
          } catch (_) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  /** The balanced `{...}` starting at `start` in script text, honouring string literals. */
  function nfxBalanced(text, start) {
    var depth = 0, quote = null, escaped = false;
    for (var i = start; i < text.length; i++) {
      var c = text.charAt(i);
      if (quote) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  /** Strategy 2: activity embedded in the page's own state and inline <script> blobs. */
  function harvestNetflixPageState() {
    try {
      if (window.netflix) {
        nfxFindViewed(window.netflix.reactContext && window.netflix.reactContext.models, "page state");
        nfxFindViewed(window.netflix.falcorCache, "page state");
      }
    } catch (_) {}
    document.querySelectorAll("script:not([src])").forEach(function (s) {
      var text = s.textContent || "";
      if (text.length > 8e6 || !/viewedItems|viewingActivity|dateWatched|seriesTitle/.test(text)) return;
      if (/json/i.test(s.type || "")) {
        nfxConsiderText(text.trim(), "page state");
        return;
      }
      // Inline `x = {...};` assignments: parse each object literal (JS-only \x escapes → \u00).
      var re = /=\s*\{/g, m;
      while ((m = re.exec(text))) {
        var obj = nfxBalanced(text, m.index + m[0].length - 1);
        if (!obj) continue;
        re.lastIndex = m.index + obj.length;
        nfxConsiderText(obj.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1"), "page state");
      }
    });
  }

  /** Every entry Netflix counts (vhSize) has been read. */
  function nfxHaveAll() {
    return NFX.total > 0 && NFX.items.length >= NFX.total;
  }

  /**
   * Close enough to call an *empty page* the real end: a few of Netflix's entries can collapse
   * into one on our side (same video, same moment). Never used to stop paging early.
   */
  function nfxReachedTotal() {
    return NFX.total > 0 && NFX.items.length >= NFX.total - Math.max(3, Math.floor(NFX.total * 0.02));
  }

  /** One JSON page with retries (backoff 1.5s, 3s, 6s, 12s) for throttling and transient errors. */
  function nfxFetchJson(req, deadline) {
    var attempt = 0;
    var doFetch = NFX.fetch || window.fetch;
    function once() {
      var init = { credentials: "include", headers: req.headers || {}, method: req.method || "GET" };
      if (req.body != null && init.method !== "GET") init.body = req.body;
      return doFetch.call(window, req.url, init).then(function (r) {
        if (!r.ok) {
          var err = new Error("HTTP " + r.status);
          // Auth / not-found won't fix themselves; rate limits and server errors usually do.
          err.fatal = r.status === 401 || r.status === 403 || r.status === 404;
          throw err;
        }
        return r.text().then(function (t) {
          try {
            return JSON.parse(t);
          } catch (_) {
            throw new Error("non-JSON response");
          }
        });
      });
    }
    function tryIt() {
      return once().catch(function (e) {
        attempt++;
        var wait = 1500 * Math.pow(2, attempt - 1);
        if (e.fatal || attempt > 4 || Date.now() + wait > deadline) throw e;
        return nfxSleep(wait).then(tryIt);
      });
    }
    return tryIt();
  }

  var NFX_CURSOR_OUT = /^(endCursor|nextCursor|nextPageCursor|nextPageToken|nextToken|continuationToken|cursor)$/;

  /** The "next page" cursor in a response, if it pages by cursor (null when there's no more). */
  function nfxFindCursor(root) {
    var found = null, more = null;
    (function walk(node, depth) {
      if (!node || typeof node !== "object" || depth > 10 || found) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length && i < 50; i++) walk(node[i], depth + 1);
        return;
      }
      Object.keys(node).forEach(function (k) {
        var v = node[k];
        if (k === "hasNextPage" && typeof v === "boolean") more = v;
        if (!found && NFX_CURSOR_OUT.test(k) && typeof v === "string" && v) found = v;
        else if (v && typeof v === "object") walk(v, depth + 1);
      });
    })(root, 0);
    return more === false ? null : found;
  }

  /** Viewing entries in one response: Shakti's `viewedItems`, or any entry-shaped arrays. */
  function nfxEntriesIn(body) {
    if (body && Array.isArray(body.viewedItems)) return body.viewedItems;
    var all = [];
    nfxCollect(body).forEach(function (list) { all = all.concat(list); });
    return all;
  }

  /**
   * Pages through one viewing-activity source until Netflix's own total is reached.
   * `pager.request(pg, size, cursor)` builds each request (same headers every time); pages are
   * stepped by index, offset or cursor. Netflix may serve fewer entries than asked (20 of a
   * requested 100): the page size then follows what it actually serves, so nothing is skipped.
   * An empty page before the total is NOT treated as the end — the caller tries another way.
   */
  function nfxCrawl(label, pager, deadline, notes) {
    var pg = 0, pages = 0, repeats = 0, lastSig = null, cursor = null;
    var size = pager.size || 20;
    var maxPages = 4000;
    function step() {
      if (Date.now() > deadline) {
        notes.push(label + ": time limit reached at page " + pg);
        return Promise.resolve(false);
      }
      if (pages >= maxPages) return Promise.resolve(false);
      // Sent with the unhooked fetch, so these pages aren't double-counted as the page's own.
      var req = pager.request(pg, size, cursor);
      return nfxFetchJson(req, deadline)
        .then(function (body) {
          pages++;
          nfxCollect(body); // picks up vhSize / totals anywhere in the response
          if (body && body.vhSize > NFX.total) NFX.total = body.vhSize;
          var list = nfxEntriesIn(body);
          if (!list.length) {
            var done = !NFX.total || nfxReachedTotal();
            notes.push(label + ": " + (done ? "end" : "empty page " + pg + " at " + NFX.items.length + "/" + NFX.total));
            return done;
          }
          if (pg === 0 && list.length < size) {
            notes.push(label + ": asked " + size + " per page, got " + list.length);
            size = list.length;
          }
          // The same page twice means the server ignored the page parameter: stop, don't loop.
          var sig = list.length + "|" + JSON.stringify(list[0]).slice(0, 300) + "|" + JSON.stringify(list[list.length - 1]).slice(0, 300);
          repeats = sig === lastSig ? repeats + 1 : 0;
          lastSig = sig;
          if (repeats >= 2) {
            notes.push(label + ": page " + pg + " repeated the previous page");
            return false;
          }
          nfxHarvest(list, label);
          nfxReportProgress(false);
          if (nfxHaveAll()) return true;
          if (pager.mode === "cursor") {
            cursor = nfxFindCursor(body);
            if (!cursor) {
              var end = !NFX.total || nfxReachedTotal();
              if (!end) notes.push(label + ": no next cursor at " + NFX.items.length + "/" + NFX.total);
              return end;
            }
          }
          pg++;
          // Paced like a person scrolling, so Netflix doesn't throttle a long history.
          return nfxSleep(250).then(step);
        })
        .catch(function (e) {
          notes.push(label + ": page " + pg + " failed (" + String((e && e.message) || e).slice(0, 80) + ")");
          return false;
        });
    }
    return step().then(function (complete) {
      notes.push(label + ": " + pages + " pages, " + NFX.items.length + (NFX.total ? "/" + NFX.total : "") + " entries" + (complete ? ", complete" : ""));
      nfxReportProgress(true);
      return complete;
    });
  }

  var NFX_PAGE_KEYS = /^(pg|page|pageNumber|pageIndex|pageNum)$/i;
  var NFX_OFFSET_KEYS = /^(offset|start|from|skip|startIndex)$/i;
  var NFX_SIZE_KEYS = /^(pgSize|pageSize|size|limit|count|first|perPage|num)$/i;
  var NFX_CURSOR_IN = /^(after|cursor|pageToken|nextToken|continuationToken|nextCursor)$/i;

  /**
   * How a captured request pages — a page index, an offset or a cursor, in the query string or
   * the JSON body (including GraphQL `variables`). Null when it has no paging parameter.
   */
  function nfxPagerFor(req) {
    var u;
    try { u = new URL(req.url, location.href); } catch (_) { return null; }
    var body = null;
    if (req.body) { try { body = JSON.parse(req.body); } catch (_) {} }
    var holders = [{
      where: "query",
      keys: function () { var a = []; u.searchParams.forEach(function (_, k) { a.push(k); }); return a; },
      get: function (k) { return u.searchParams.get(k); },
      set: function (k, v) { if (v == null) u.searchParams.delete(k); else u.searchParams.set(k, String(v)); },
    }];
    [body, body && body.variables].forEach(function (o) {
      if (!o || typeof o !== "object" || Array.isArray(o)) return;
      holders.push({
        where: o === body ? "body" : "variables",
        keys: function () { return Object.keys(o); },
        get: function (k) { return o[k]; },
        set: function (k, v) { o[k] = typeof o[k] === "string" && v != null ? String(v) : v; },
      });
    });
    var page = null, offset = null, size = null, cursor = null;
    holders.forEach(function (h) {
      h.keys().forEach(function (k) {
        if (!page && NFX_PAGE_KEYS.test(k)) page = { h: h, k: k, base: parseInt(h.get(k), 10) || 0 };
        else if (!offset && NFX_OFFSET_KEYS.test(k)) offset = { h: h, k: k, base: parseInt(h.get(k), 10) || 0 };
        else if (!size && NFX_SIZE_KEYS.test(k) && /^\d+$/.test(String(h.get(k)))) size = { h: h, k: k };
        else if (!cursor && NFX_CURSOR_IN.test(k)) cursor = { h: h, k: k, first: h.get(k) };
      });
    });
    if (!page && !offset && !cursor) return null;
    var mode = page ? "page" : offset ? "offset" : "cursor";
    var where = (page || offset || cursor).h.where + "." + (page || offset || cursor).k;
    return {
      mode: mode,
      where: where,
      size: size ? parseInt(size.h.get(size.k), 10) || 20 : 20,
      request: function (pg, sz, cur) {
        if (page) page.h.set(page.k, page.base + pg);
        if (offset) offset.h.set(offset.k, offset.base + pg * sz);
        if (size) size.h.set(size.k, sz);
        if (mode === "cursor") cursor.h.set(cursor.k, pg === 0 ? cursor.first : cur);
        return { url: u.toString(), method: req.method || "GET", headers: req.headers || {}, body: body ? JSON.stringify(body) : req.body };
      },
    };
  }

  /** Strategy 3: Netflix's Shakti API, called in-page as Netflix's own web client does. */
  function netflixApiHistory(deadline, notes) {
    var build = netflixContextValue(["serverDefs", "data", "BUILD_IDENTIFIER"]);
    var info = netflixUserInfo() || {};
    var auth = info.authURL || netflixContextValue(["memberContext", "data", "userInfo", "authURL"]) || "";
    var esn = netflixContextValue(["esnGeneratorModel", "data", "esn"]) || "";
    var locale = netflixContextValue(["geo", "data", "locale", "id"]) || "";
    var bases = (build ? ["/api/shakti/" + build + "/viewingactivity"] : []).concat(["/api/shakti/mre/viewingactivity"]);
    var headers = {
      Accept: "*/*",
      "X-Netflix.client.request.name": "ui/xhrUnclassified",
      "X-Netflix.clientType": "akira",
    };
    if (build) headers["X-Netflix.uiVersion"] = build;
    if (typeof esn === "string" && esn) headers["X-Netflix.esnPrefix"] = esn.split("-").slice(0, 2).join("-") + "-";

    var i = 0;
    function nextBase() {
      if (i >= bases.length) return Promise.resolve(false);
      var base = bases[i++];
      var url = function (pg, size) {
        return base + "?" + (locale ? "languages=" + encodeURIComponent(locale) + "&" : "") + "pg=" + pg + "&pgSize=" + size + (auth ? "&authURL=" + encodeURIComponent(auth) : "");
      };
      var pager = { mode: "page", size: 100, request: function (pg, size) { return { url: url(pg, size), method: "GET", headers: headers }; } };
      return nfxCrawl("shakti " + base.split("/")[3], pager, deadline, notes).then(function (complete) {
        return complete || nextBase();
      });
    }
    return nextBase();
  }

  /**
   * Replays the exact request Netflix's own viewing-activity page used for its entries (same
   * endpoint, query, body and headers, captured by the fetch / XHR hooks), stepping only its
   * page / offset / cursor parameter.
   */
  function netflixTemplateHistory(deadline, notes) {
    var reqs = [NFX.dataRequest, NFX.template && { url: NFX.template.url, method: "GET", headers: NFX.template.headers }].filter(Boolean);
    if (!reqs.length) {
      notes.push("no request carrying viewing activity was captured");
      return Promise.resolve(false);
    }
    var i = 0;
    function next() {
      if (i >= reqs.length) return Promise.resolve(false);
      var req = reqs[i++];
      var pager = nfxPagerFor(req);
      if (!pager) {
        notes.push("page's request " + nfxPath(req.url) + " (" + req.method + ") has no page/offset/cursor parameter");
        return next();
      }
      return nfxCrawl("page's request " + nfxPath(req.url) + " by " + pager.where, pager, deadline, notes).then(function (complete) {
        return complete || next();
      });
    }
    return next();
  }

  function nfxRowLinks() {
    return document.querySelectorAll('a[href*="/title/"]');
  }

  function nfxEmptyState() {
    var text = document.body ? clean(String(document.body.innerText || "").slice(0, 4000)) : "";
    return /haven.t watched anything|no viewing activity|nothing to show/i.test(text);
  }

  /** The activity page is ready once Netflix's app state exists and it rendered or fetched rows. */
  function netflixActivityHydrated() {
    return (
      document.readyState === "complete" &&
      !!(window.netflix && window.netflix.reactContext) &&
      (NFX.items.length > 0 || nfxRowLinks().length > 0 || nfxEmptyState())
    );
  }

  function nfxShowMoreButton() {
    return Array.prototype.find.call(document.querySelectorAll("button, [role=button]"), function (b) {
      return /show more|load more|see more/i.test(clean(b.textContent)) && !b.disabled;
    });
  }

  /**
   * A real-looking press: scrolled into view first (WebView2 can ignore clicks on off-screen
   * elements), then pointer / mouse down-up at its centre, then click.
   */
  function nfxPress(el) {
    try { el.scrollIntoView({ block: "center" }); } catch (_) {}
    var r = el.getBoundingClientRect();
    var opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent("mousedown", opts)); } catch (_) {}
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent("mouseup", opts)); } catch (_) {}
    el.click();
  }

  /**
   * Clicks "Show more" until the button is gone — the whole lifetime list. Each click makes the
   * page fetch another page; a slow response is retried (up to 3 clicks) rather than ending.
   */
  function expandNetflixActivity(deadline) {
    return new Promise(function (resolve) {
      var misses = 0;
      (function step() {
        if (Date.now() > deadline || nfxHaveAll()) return resolve();
        // Bring the end of the list (and the button) into the viewport so it renders.
        try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (_) {}
        var more = nfxShowMoreButton();
        if (!more) {
          // The button can briefly vanish while the next batch renders: confirm it's really gone.
          return waitFor(nfxShowMoreButton, 2500, 250).then(function (back) {
            if (back && Date.now() < deadline) step();
            else resolve();
          });
        }
        var before = NFX.items.length + nfxRowLinks().length;
        NFX.buttonSeen = true;
        NFX.clicks++;
        nfxPress(more);
        waitFor(function () { return NFX.items.length + nfxRowLinks().length > before; }, 15000, 300).then(function (grew) {
          nfxReportProgress(false);
          if (!grew && ++misses >= 3) return resolve();
          if (grew) misses = 0;
          setTimeout(step, grew ? 300 : 1500);
        });
      })();
    });
  }

  // Entries already read survive the hop from the homepage (API) to the activity page.
  var NFX_STASH_KEY = "omnia-import-stash-" + TOKEN_KEY;

  function nfxStash() {
    try {
      sessionStorage.setItem(NFX_STASH_KEY, JSON.stringify({ items: NFX.items, total: NFX.total }));
    } catch (_) {}
  }

  function nfxRestoreStash() {
    try {
      var raw = sessionStorage.getItem(NFX_STASH_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      (data.items || []).forEach(function (it) {
        var key = [it.ottVideoId || "", it.title, it.episodeTitle || "", it.watchedAt || ""].join("|");
        if (NFX.keys[key]) return;
        NFX.keys[key] = true;
        NFX.items.push(it);
      });
      if (data.total > NFX.total) NFX.total = data.total;
    } catch (_) {}
  }

  /** Strategy 4: rows rendered on the page — title links plus the nearest date, no class names. */
  var NFX_NUMERIC_DATE = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/;

  /**
   * Netflix prints activity dates in the account's locale: 14/11/25 (India, UK…) or 11/14/25
   * (US). `new Date()` only reads month-first, so day-first dates were rejected (and fell back
   * to "now") or swapped (5/11 → May 11). The order is decided from the dates themselves — any
   * first number above 12 means day-first, any second above 12 means month-first — then from
   * the page language.
   */
  function nfxDateOrder(texts) {
    var dmy = false, mdy = false;
    texts.forEach(function (t) {
      var m = NFX_NUMERIC_DATE.exec(t);
      if (!m) return;
      if (+m[1] > 12) dmy = true;
      if (+m[2] > 12) mdy = true;
    });
    if (dmy !== mdy) return dmy ? "dmy" : "mdy";
    var lang = String(document.documentElement.lang || navigator.language || "").toLowerCase();
    return /^en(-(us|ph|ca))?$/.test(lang) ? "mdy" : "dmy";
  }

  /** A row's calendar date as an ISO string at 12:00 UTC (so no time zone shifts its day). */
  function nfxRowDate(text, order) {
    var t = clean(text);
    var m = NFX_NUMERIC_DATE.exec(t);
    var y, mo, d;
    if (m) {
      d = +(order === "dmy" ? m[1] : m[2]);
      mo = +(order === "dmy" ? m[2] : m[1]);
      y = +m[3];
      if (y < 100) y += y > (new Date().getFullYear() % 100) + 1 ? 1900 : 2000;
    } else {
      // Month names ("14 Nov 2025", "Nov 14, 2025") are unambiguous.
      if (!/[a-z]{3}/i.test(t) || !/\d{4}/.test(t)) return null;
      var parsed = new Date(t);
      if (isNaN(parsed.getTime())) return null;
      y = parsed.getFullYear();
      mo = parsed.getMonth() + 1;
      d = parsed.getDate();
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
    return new Date(Date.UTC(y, mo - 1, d, 12)).toISOString();
  }

  function nfxLooksLikeDate(text) {
    var t = clean(text);
    return !!t && t.length <= 24 && (NFX_NUMERIC_DATE.test(t) || (/\d{4}/.test(t) && /[a-z]{3}/i.test(t) && !isNaN(new Date(t).getTime())));
  }

  function scrapeNetflixActivityDom() {
    var rows = [];
    nfxRowLinks().forEach(function (link) {
      var title = clean(link.textContent);
      if (!title) return;
      var row = link;
      var dateText = null;
      for (var up = 0; up < 5 && !dateText; up++) {
        row = row.parentElement;
        if (!row) break;
        Array.prototype.some.call(row.querySelectorAll("*"), function (el) {
          if (el.childElementCount !== 0 || el === link || link.contains(el)) return false;
          if (nfxLooksLikeDate(el.textContent)) dateText = clean(el.textContent);
          return !!dateText;
        });
      }
      var id = (String(link.getAttribute("href") || "").match(/\/title\/(\d{3,12})/) || [])[1] || null;
      rows.push({ title: title, dateText: dateText, id: id });
    });
    var order = nfxDateOrder(rows.map(function (r) { return r.dateText || ""; }));
    var items = [];
    var seen = {};
    rows.forEach(function (r) {
      var watchedAt = r.dateText ? nfxRowDate(r.dateText, order) : null;
      var key = r.title + "|" + (watchedAt || "");
      if (seen[key]) return;
      seen[key] = true;
      items.push({ title: r.title, isTv: false, seasonNumber: null, episodeNumber: null, episodeTitle: null, progressRatio: null, watchedAt: watchedAt, ottVideoId: r.id });
    });
    NFX.dateOrder = order;
    NFX.undatedRows = rows.filter(function (r) { return !r.dateText; }).length;
    return items;
  }

  /**
   * Adds rendered activity rows that weren't already captured as data ("Show more" may load rows
   * whose responses aren't recognisable JSON). A row is a duplicate when a captured entry has
   * the same day and the same video id, or its title (and episode title) appear in the row text.
   */
  function nfxMergeDomRows(rows) {
    // Rows show a local calendar date while data carries a UTC timestamp: compare a day either
    // side. Indexed by UTC day number.
    var DAY = 86400000;
    var dayOf = function (iso) { var t = Date.parse(iso || ""); return isNaN(t) ? null : Math.floor(t / DAY); };
    var byDay = {};
    var index = function (it) {
      var d = dayOf(it.watchedAt);
      (byDay[d] = byDay[d] || []).push(it);
    };
    NFX.items.forEach(index);
    var lower = function (v) { return String(v || "").toLowerCase(); };
    var added = 0;
    rows.forEach(function (row) {
      var d = dayOf(row.watchedAt);
      var text = lower(row.title);
      var near = d == null ? byDay[null] || [] : [].concat(byDay[d - 1] || [], byDay[d] || [], byDay[d + 1] || []);
      var dup = near.some(function (it) {
        // Same id is certain. Different ids aren't proof of a different viewing: a row links to
        // the series page while the data carries the episode's id — so compare titles too.
        if (row.ottVideoId && it.ottVideoId && row.ottVideoId === it.ottVideoId) return true;
        return !!it.title && text.indexOf(lower(it.title)) >= 0 && (!it.episodeTitle || text.indexOf(lower(it.episodeTitle)) >= 0);
      });
      if (dup) return;
      NFX.items.push(row);
      index(row);
      added++;
    });
    return added;
  }

  /** Short, title-free summary of what the page fetched, for the local diagnostic log. */
  function nfxResponseSummary() {
    var paths = Object.keys(NFX.paths).sort(function (a, b) { return NFX.paths[b] - NFX.paths[a]; }).slice(0, 8);
    var sources = Object.keys(NFX.sources).map(function (k) { return k + " " + NFX.sources[k]; }).join(", ");
    return (
      "entries by source: " + (sources || "none") +
      "; responses: " + (paths.map(function (p) { return p + " x" + NFX.paths[p] + (NFX.hits[p] ? " (" + NFX.hits[p] + " entries)" : ""); }).join(", ") || "none")
    );
  }

  function runNetflixImport() {
    var NAV_KEY = "omnia-import-nav-" + TOKEN_KEY;
    var API_KEY = "omnia-import-api-" + TOKEN_KEY;
    // One deadline for the whole import, kept across the hop to the activity page (Rust's
    // timer doesn't restart when the page navigates).
    var DEADLINE_KEY = "omnia-import-deadline-" + TOKEN_KEY;
    var deadline = parseInt(session(DEADLINE_KEY) || "0", 10);
    if (!deadline) {
      deadline = Date.now() + (CONFIG.scrapeTimeoutMs || 120000);
      session(DEADLINE_KEY, String(deadline));
    }
    if (/\/login/i.test(location.pathname)) {
      submitHistory([], "Netflix asked to sign in again: this Omnia profile's Netflix session has expired. Sign in via Connect Accounts.");
      return;
    }
    waitFor(function () { return !onProfileGate() && detectOttProfile(); }, 25000).then(function (profile) {
      if (CONFIG.expectedOttProfileId && (!profile || profile.id !== CONFIG.expectedOttProfileId)) {
        submitHistory([], profile ? "Netflix is on " + (profile.name || "another profile") + ", not the linked profile." : "Couldn't detect the Netflix profile.");
        return;
      }
      var onActivityPage = /viewingactivity|settings\/viewed/i.test(location.pathname);
      var apiOutcome = session(API_KEY);

      // Step 1 — on the homepage, already signed in: the Shakti API through a genuine in-page
      // fetch() (Netflix's own TLS stack, cookies and headers). Most imports finish here.
      if (!onActivityPage && apiOutcome === null) {
        harvestNetflixPageState();
        var apiNotes = [];
        netflixApiHistory(deadline, apiNotes).then(function (complete) {
          // Done only when Netflix's own total was reached (or time is up). Otherwise keep what
          // was read and continue on the activity page: Netflix's own request, then "Show more".
          if (NFX.items.length && (complete || Date.now() > deadline - 20000)) {
            nfxReportProgress(true);
            submitHistory(NFX.items.slice(), null, apiNotes);
            return;
          }
          session(API_KEY, apiNotes.join("; ") || "no entries returned");
          session(NAV_KEY, "1");
          nfxStash();
          location.href = "/viewingactivity";
        });
        return;
      }

      nfxRestoreStash();

      var navigations = parseInt(session(NAV_KEY) || "0", 10);
      if (!onActivityPage && navigations < 2) {
        session(NAV_KEY, String(navigations + 1));
        location.href = "/viewingactivity";
        return;
      }

      // Steps 2-4 — the viewing-activity page: captured app requests, embedded state, rows.
      var notes = [];
      if (apiOutcome !== null) notes.push("in-page API: " + apiOutcome);
      if (!onActivityPage) notes.push("couldn't open the viewing-activity page (landed on " + location.pathname + ")");
      waitFor(netflixActivityHydrated, 30000, 500)
        .then(function (ready) {
          if (!ready) notes.push("the page didn't finish loading within 30s");
          harvestNetflixPageState();
          if (nfxHaveAll()) return true;
          // Netflix's own paged request, replayed with its exact headers.
          return waitFor(function () { return NFX.template; }, 8000, 300).then(function () {
            return netflixTemplateHistory(deadline, notes);
          });
        })
        .then(function (complete) {
          if (complete || nfxHaveAll()) return null;
          var before = NFX.items.length;
          return expandNetflixActivity(deadline).then(function () {
            notes.push("show more: " + before + " -> " + NFX.items.length + (NFX.total ? "/" + NFX.total : "") + " entries");
          });
        })
        .then(function () {
          nfxReportProgress(true);
          if (NFX.items.length || apiOutcome !== null) return null;
          return netflixApiHistory(deadline, notes);
        })
        .then(function () {
          var captured = NFX.items.length;
          var rows = scrapeNetflixActivityDom();
          var added = nfxMergeDomRows(rows);
          notes.push("show more button " + (NFX.buttonSeen ? "clicked " + NFX.clicks + "x" : "not found"));
          notes.push("captured entries: " + captured + (NFX.total ? "/" + NFX.total : ""));
          notes.push("rendered rows: " + rows.length + " (" + added + " not in captured data; dates read as " + (NFX.dateOrder || "?") + ", " + (NFX.undatedRows || 0) + " undated)");
          notes.push(NFX.responses + " page responses; " + nfxResponseSummary());
          submitHistory(NFX.items.slice(), "No readable Netflix viewing activity (" + notes.join("; ") + ").", notes);
        });
    });
  }

  // Capture must be live before Netflix's own scripts issue their first request.
  if (CONFIG.mode === "import" && CONFIG.scraper === "netflix_history") installNetflixCapture();
  else if (CONFIG.mode === "import") installGenericCapture();
  // A hidden window is a background page: Chromium may throttle or freeze it. A held Web Lock
  // keeps it running for the length of the import (WebView2 has no throttling switch).
  if (CONFIG.mode === "import") {
    try {
      if (navigator.locks && navigator.locks.request) navigator.locks.request("omnia-import-" + TOKEN_KEY, function () { return new Promise(function () {}); });
    } catch (_) {}
  }
  if (CONFIG.mode === "play" && IS_NETFLIX) installNetflixPlayerTap();

  // -------------------------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------------------------
  function boot() {
    buildOverlay();
    document.addEventListener("fullscreenchange", mountOverlay);
    document.addEventListener("mousemove", function () { showOverlay(false); }, { passive: true });

    if (CONFIG.mode === "import") {
      if (CONFIG.scraper === "netflix_history") runNetflixImport();
      else runGenericImport();
      return;
    }
    watchProfileGate();
    if (CONFIG.mode === "connect") {
      pollProfile();
      setInterval(pollProfile, 1500);
      return;
    }
    if (handleProfileSwitchThenTarget()) return;
    jumpToNetflixEpisode();

    // Video discovery: cheap, throttled scan on DOM mutations plus a 1s safety poll.
    var scanQueued = false;
    function scan() {
      scanQueued = false;
      var v = pickVideo();
      if (v !== video) attach(v);
      mountOverlay();
    }
    new MutationObserver(function () {
      if (!scanQueued) {
        scanQueued = true;
        setTimeout(scan, 500);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

    var titleEl = document.querySelector("head > title");
    if (titleEl) new MutationObserver(function () { setTimeout(onUrlMaybeChanged, 0); }).observe(titleEl, { childList: true });

    setInterval(function () {
      accrue();
      if (!video || !video.isConnected) scan();
    }, 1000);

    setInterval(function () {
      // Periodic sync while playing; while paused, a slow heartbeat keeps the profile status fresh.
      if (video && (isPlaying(video) || activeAccum > 0)) sendSync("progress");
    }, CONFIG.syncIntervalMs || 3000);
    setInterval(function () {
      if (!video || !isPlaying(video)) sendSync("metadata");
    }, 10000);

    scan();
    setTimeout(function () { sendSync("metadata"); }, 2500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})

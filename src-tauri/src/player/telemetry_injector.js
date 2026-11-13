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

  function detectOttProfile() {
    if (IS_NETFLIX) return onProfileGate() ? null : detectNetflixProfile();
    return detectGenericProfile();
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
          };
          added = true;
        });
      });
      return added;
    }
    if (v.type === "movie" && v.id != null && !NFX_VIDEOS[v.id]) {
      NFX_VIDEO_COUNT++;
      NFX_VIDEOS[v.id] = { title: title, seasonNumber: null, episodeNumber: null, episodeTitle: null };
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

  function pollProfile() {
    if (CONFIG.mode !== "connect" || linked) return;
    var p = detectOttProfile();
    currentProfile = p;
    if (ui.panel) {
      if (p) {
        showPanel("", "Link this profile");
        ui.msg.textContent = "";
        ui.msg.append(
          "Signed in to " + CONFIG.providerName + " as ",
          Object.assign(document.createElement("strong"), { textContent: p.name || "profile " + p.id.slice(0, 6) }),
          ". Link it to " + CONFIG.appProfileName + "?",
        );
      } else {
        showPanel("Sign in to " + CONFIG.providerName + " and choose who's watching.", null);
      }
    }
  }

  function linkProfile() {
    var p = CONFIG.mode === "connect" ? currentProfile : detectOttProfile();
    if (!p || linked) return;
    var original = ui.link.textContent;
    ui.link.textContent = "Linking…";
    invoke("report_ott_profile", { token: CONFIG.token, profile: p }).then(function (res) {
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
      container.querySelectorAll("a[href]").forEach(function (a) {
        if (seen[a.href] || !a.querySelector("img")) return;
        seen[a.href] = true;
        var card = a.closest("li,article,[role=listitem]") || a;
        var item = itemFromText(cardTitle(a), { progressRatio: progressWithin(card) });
        if (item) items.push(item);
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

  function submitHistory(items, error) {
    return invoke("submit_scraped_history", {
      token: CONFIG.token,
      items: items.slice(0, 6000),
      ottProfile: detectOttProfile(),
      pageUrl: location.origin + location.pathname,
      error: items.length ? null : error,
    });
  }

  function runGenericImport() {
    var scraper = CONFIG.scraper === "primevideo_history" ? scrapePrimeHistory : scrapeContinueWatching;
    var deadline = Date.now() + (CONFIG.scrapeTimeoutMs || 30000);
    var lastCount = -1, stableRounds = 0, scrolls = 0;

    function tick() {
      var items = [];
      try { items = scraper(); } catch (_) {}
      if (items.length > 0 && items.length === lastCount) stableRounds++;
      else stableRounds = 0;
      lastCount = items.length;

      // Lazy-loaded lists: scroll to the bottom a few times to load more entries.
      if (scrolls < 12 && document.body) {
        scrolls++;
        window.scrollTo(0, document.body.scrollHeight);
      }

      if ((items.length > 0 && stableRounds >= 2) || Date.now() > deadline) {
        submitHistory(items, "No history entries were found on " + location.hostname);
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
  var NFX = { items: [], keys: {}, total: 0, responses: 0, sources: {} };
  var NFX_TITLE_KEYS = ["seriesTitle", "title", "videoTitle", "showTitle"];
  var NFX_DATE_KEYS = ["date", "dateWatched", "watchedDate", "lastWatched", "viewedAt", "timestamp"];

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
      var key = [v.movieID || "", it.title, it.episodeTitle || "", it.watchedAt || ""].join("|");
      if (NFX.keys[key]) return;
      NFX.keys[key] = true;
      NFX.items.push(it);
      added++;
    });
    if (added) NFX.sources[source] = (NFX.sources[source] || 0) + added;
    return added;
  }

  /** Harvests every viewing-activity-shaped array inside a JSON value (cycle- and size-safe). */
  function nfxFindViewed(root, source) {
    var seen = typeof WeakSet === "function" ? new WeakSet() : null;
    var budget = 250000;
    var found = 0;
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
          found += nfxHarvest(viewed, source);
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
    return found;
  }

  function nfxConsiderText(text, source) {
    if (typeof text !== "string" || text.length < 2 || text.length > 8e6) return;
    var first = text.charAt(0);
    if (first !== "{" && first !== "[") return;
    try { nfxFindViewed(JSON.parse(text), source); } catch (_) {}
  }

  function nfxSameSite(url) {
    try {
      return /(^|\.)netflix\.com$/i.test(new URL(url, location.href).hostname);
    } catch (_) {
      return false;
    }
  }

  /** Observes the page's own requests. Installed at document start, before Netflix's scripts. */
  function installNetflixCapture() {
    if (typeof window.fetch === "function") {
      var origFetch = window.fetch;
      window.fetch = function (input) {
        var p = origFetch.apply(window, arguments);
        try {
          var url = typeof input === "string" ? input : (input && input.url) || String(input || "");
          if (nfxSameSite(url)) {
            p.then(function (r) {
              var type = (r.headers && r.headers.get("content-type")) || "";
              if (!r.ok || type.indexOf("json") < 0) return;
              NFX.responses++;
              r.clone().text().then(function (t) { nfxConsiderText(t, "page requests"); }).catch(function () {});
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
      try { this.__omniaUrl = String(url); } catch (_) {}
      return origOpen.apply(this, arguments);
    };
    X.send = function () {
      var xhr = this;
      if (nfxSameSite(xhr.__omniaUrl || "")) {
        xhr.addEventListener("load", function () {
          try {
            if (xhr.status < 200 || xhr.status >= 300) return;
            NFX.responses++;
            if (xhr.responseType === "json") nfxFindViewed(xhr.response, "page requests");
            else if (!xhr.responseType || xhr.responseType === "text") nfxConsiderText(xhr.responseText, "page requests");
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

  /** Strategy 3: Netflix's Shakti API, called in-page as Netflix's own web client does. */
  function netflixApiHistory(deadline) {
    var build = netflixContextValue(["serverDefs", "data", "BUILD_IDENTIFIER"]);
    var info = netflixUserInfo() || {};
    var auth = info.authURL || netflixContextValue(["memberContext", "data", "userInfo", "authURL"]) || "";
    var esn = netflixContextValue(["esnGeneratorModel", "data", "esn"]) || "";
    var locale = netflixContextValue(["geo", "data", "locale", "id"]) || "";
    var bases = (build ? ["/api/shakti/" + build + "/viewingactivity"] : []).concat(["/api/shakti/mre/viewingactivity"]);
    var statuses = [];
    var headers = {
      Accept: "*/*",
      "X-Netflix.client.request.name": "ui/xhrUnclassified",
      "X-Netflix.clientType": "akira",
    };
    if (build) headers["X-Netflix.uiVersion"] = build;
    if (typeof esn === "string" && esn) headers["X-Netflix.esnPrefix"] = esn.split("-").slice(0, 2).join("-") + "-";

    function page(base, pg) {
      var url = base + "?" + (locale ? "languages=" + encodeURIComponent(locale) + "&" : "") + "pg=" + pg + "&pgSize=100" + (auth ? "&authURL=" + encodeURIComponent(auth) : "");
      return fetch(url, { credentials: "include", headers: headers }).then(function (r) {
        if (!r.ok) {
          statuses.push("HTTP " + r.status + " from " + base.split("/api/")[1]);
          return null;
        }
        return r.json();
      });
    }

    function fromBase(i) {
      if (i >= bases.length) return Promise.resolve(false);
      return page(bases[i], 0)
        .then(function (first) {
          if (!first || !Array.isArray(first.viewedItems)) return fromBase(i + 1);
          if (first.vhSize > NFX.total) NFX.total = first.vhSize;
          nfxHarvest(first.viewedItems, "in-page API");
          var pg = 1;
          function next() {
            if (Date.now() > deadline || (NFX.total && NFX.items.length >= NFX.total) || pg >= 60) return true;
            return page(bases[i], pg++).then(function (body) {
              var list = body && body.viewedItems;
              if (!list || !list.length) return true;
              nfxHarvest(list, "in-page API");
              return next();
            });
          }
          return first.viewedItems.length ? next() : true;
        })
        .catch(function (e) {
          statuses.push(String((e && e.message) || e).slice(0, 80));
          return fromBase(i + 1);
        });
    }
    return fromBase(0).then(function () { return statuses.join(", "); });
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

  /** Clicks "Show more" until everything is listed; each click makes the page fetch another page. */
  function expandNetflixActivity(deadline) {
    return new Promise(function (resolve) {
      var clicks = 0;
      (function step() {
        if (Date.now() > deadline || clicks >= 80 || (NFX.total && NFX.items.length >= NFX.total)) return resolve();
        var more = Array.prototype.find.call(document.querySelectorAll("button, [role=button]"), function (b) {
          return /show more|load more|see more/i.test(clean(b.textContent)) && !b.disabled;
        });
        if (!more) return resolve();
        var before = NFX.items.length + nfxRowLinks().length;
        clicks++;
        more.click();
        waitFor(function () { return NFX.items.length + nfxRowLinks().length > before; }, 8000, 300).then(function (grew) {
          if (!grew) return resolve();
          setTimeout(step, 350);
        });
      })();
    });
  }

  /** Strategy 4: rows rendered on the page — title links plus the nearest date, no class names. */
  function scrapeNetflixActivityDom() {
    var items = [];
    var seen = {};
    nfxRowLinks().forEach(function (link) {
      var title = clean(link.textContent);
      if (!title) return;
      var row = link;
      var watchedAt = null;
      for (var up = 0; up < 5 && !watchedAt; up++) {
        row = row.parentElement;
        if (!row) break;
        Array.prototype.some.call(row.querySelectorAll("*"), function (el) {
          if (el.childElementCount !== 0 || el === link || link.contains(el)) return false;
          watchedAt = parseDateText(el.textContent);
          return !!watchedAt;
        });
      }
      var key = title + "|" + (watchedAt || "");
      if (seen[key]) return;
      seen[key] = true;
      items.push({ title: title, isTv: false, seasonNumber: null, episodeNumber: null, episodeTitle: null, progressRatio: null, watchedAt: watchedAt });
    });
    return items;
  }

  function runNetflixImport() {
    var NAV_KEY = "omnia-import-nav-" + TOKEN_KEY;
    var API_KEY = "omnia-import-api-" + TOKEN_KEY;
    var deadline = Date.now() + (CONFIG.scrapeTimeoutMs || 120000);
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
        netflixApiHistory(deadline).then(function (status) {
          if (NFX.items.length) {
            submitHistory(NFX.items.slice(), null);
            return;
          }
          session(API_KEY, status || "no entries returned");
          session(NAV_KEY, "1");
          location.href = "/viewingactivity";
        });
        return;
      }

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
          return expandNetflixActivity(deadline);
        })
        .then(function () {
          if (NFX.items.length || apiOutcome !== null) return null;
          return netflixApiHistory(deadline).then(function (status) {
            if (status) notes.push("in-page API: " + status);
          });
        })
        .then(function () {
          var items = NFX.items.slice();
          var domRows = 0;
          if (!items.length) {
            items = scrapeNetflixActivityDom();
            domRows = items.length;
          }
          notes.push(NFX.responses + " page responses inspected");
          notes.push("embedded/captured entries: " + NFX.items.length);
          notes.push("rendered rows: " + domRows);
          submitHistory(items, "No readable Netflix viewing activity (" + notes.join("; ") + ").");
        });
    });
  }

  // Capture must be live before Netflix's own scripts issue their first request.
  if (CONFIG.mode === "import" && CONFIG.scraper === "netflix_history") installNetflixCapture();
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

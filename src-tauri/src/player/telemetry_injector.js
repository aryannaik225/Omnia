/*
 * Omnia — injected HTML5 <video> telemetry observer, profile handshake & history scraper.
 *
 * Injected by src-tauri/src/player/window_manager.rs into every page load of an OTT player
 * window (and hidden importer windows) via WebView2's document-created script hook. Rust
 * appends the call `({...config})` to this function expression.
 *
 * Privacy: this script only ever talks to the local Omnia process through Tauri IPC. It sends
 * nothing to any network endpoint except same-origin metadata requests the OTT page itself is
 * authorised for (Netflix's own metadata API), and it never reads or forwards cookies.
 *
 * Modes:
 *   play    — track progress / pauses / seeks / episode hops, render the "Back to Hub" pill
 *   connect — profile handshake: detect the OTT profile the user picked and link it
 *   import  — hidden window: scrape the watch-history / continue-watching page and submit it
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

  // -------------------------------------------------------------------------------------------
  // Text helpers
  // -------------------------------------------------------------------------------------------
  function clean(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }

  var SE_PATTERNS = [
    // S1:E3 · S01E03 · S1 E3 · Season 1, Ep. 3 · Season 1 Episode 3 · Season 1 · Episode 3
    /\bS(?:eason)?\s*(\d{1,3})\s*[:,.\-|·]?\s*E(?:p(?:isode)?)?\.?\s*(\d{1,4})\b/i,
    /\bSeason\s*(\d{1,3})\b[^\d]{0,12}\bEpisode\s*(\d{1,4})\b/i,
  ];
  var EP_ONLY = /\bEp(?:isode)?\.?\s*(\d{1,4})\b/i;

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
    var e = t.match(EP_ONLY);
    if (e) {
      return {
        season: null,
        episode: parseInt(e[1], 10),
        rest: clean(t.replace(e[0], "").replace(/^[\s:,.\-|·]+|[\s:,.\-|·]+$/g, "")) || null,
      };
    }
    return null;
  }

  function stripProviderSuffix(title) {
    return clean(
      String(title || "")
        .replace(/\s*[|\-–—]\s*(Netflix|Prime Video|Amazon\.?\w*|JioHotstar|Disney\+?\s*Hotstar|Hotstar|ZEE5|Sony ?LIV|Apple TV\+?|Disney\+|HBO Max|Max|Hulu|Peacock|Paramount\+|Crunchyroll|MUBI|YouTube)\b.*$/i, "")
        .replace(/^(Watch|Stream)\s+/i, "")
        .replace(/\s+(Online|Full (Movie|Episode)s?)(\s+(in\s+)?(HD|4K))?.*$/i, ""),
    );
  }

  function matchUrl(re) {
    var m = location.href.match(re);
    return m ? m[1] : null;
  }

  // -------------------------------------------------------------------------------------------
  // OTT profile detection (the native profile id used for ott_profile_mappings)
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

  function detectNetflixProfile() {
    try {
      var data = window.netflix && window.netflix.reactContext && window.netflix.reactContext.models &&
        window.netflix.reactContext.models.userInfo && window.netflix.reactContext.models.userInfo.data;
      if (data && data.guid) return { id: String(data.guid), name: data.name ? clean(data.name) : null };
    } catch (_) {}
    return null;
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
        if (!key || !/profile/i.test(key)) continue;
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
    if (CONFIG.provider === "netflix") return detectNetflixProfile();
    return detectGenericProfile();
  }

  // -------------------------------------------------------------------------------------------
  // Media metadata detection (title / season / episode) per provider
  // -------------------------------------------------------------------------------------------
  var netflixMeta = { id: null, value: null, pending: false };

  function netflixBuildId() {
    try {
      return window.netflix.reactContext.models.serverDefs.data.BUILD_IDENTIFIER;
    } catch (_) {
      return null;
    }
  }

  /** Netflix hides the title overlay during playback, so resolve the episode from its own metadata API. */
  function refreshNetflixMetadata(videoId) {
    if (!videoId || netflixMeta.pending || netflixMeta.id === videoId) return;
    var build = netflixBuildId();
    if (!build) return;
    netflixMeta.pending = true;
    fetch("/api/shakti/" + build + "/metadata?movieid=" + encodeURIComponent(videoId), { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        var v = json && json.video;
        if (!v) return;
        var result = { title: clean(v.title), seasonNumber: null, episodeNumber: null, episodeTitle: null, runtime: v.runtime || null };
        if (v.type === "show" && Array.isArray(v.seasons)) {
          v.seasons.forEach(function (season) {
            (season.episodes || []).forEach(function (ep) {
              if (String(ep.episodeId || ep.id) === String(videoId)) {
                result.seasonNumber = season.seq;
                result.episodeNumber = ep.seq;
                result.episodeTitle = ep.title ? clean(ep.title) : null;
                result.runtime = ep.runtime || result.runtime;
              }
            });
          });
        }
        netflixMeta.id = videoId;
        netflixMeta.value = result;
        sendSync("metadata");
      })
      .catch(function () {})
      .then(function () { netflixMeta.pending = false; });
  }

  var adapters = {
    netflix: function () {
      var id = matchUrl(/\/watch\/(\d+)/);
      if (!id) return null;
      if (netflixMeta.id === id && netflixMeta.value) {
        var m = netflixMeta.value;
        return { title: m.title, seasonNumber: m.seasonNumber, episodeNumber: m.episodeNumber, episodeTitle: m.episodeTitle, ottTitleId: id, confidence: "high" };
      }
      refreshNetflixMetadata(id);
      var root = document.querySelector('[data-uia="video-title"]');
      if (!root) return null;
      var h4 = root.querySelector("h4");
      var se = null, epTitle = null;
      root.querySelectorAll("span").forEach(function (span) {
        var p = parseSE(span.textContent);
        if (p && !se) se = p;
        else if (clean(span.textContent)) epTitle = clean(span.textContent);
      });
      return {
        title: clean(h4 ? h4.textContent : root.textContent),
        seasonNumber: se ? se.season : null,
        episodeNumber: se ? se.episode : null,
        episodeTitle: epTitle,
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

  var BRAND_ONLY = /^(netflix|prime video|amazon\.?\w*|jiohotstar|disney\+?\s*hotstar|hotstar|zee5|sony ?liv|apple tv\+?|disney\+|hbo max|max|hulu|peacock|paramount\+|crunchyroll|mubi|youtube)$/i;

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
  var resumeApplied = !(CONFIG.resumeAtSeconds > 30) || CONFIG.provider === "netflix";
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
  // Liquid Glass overlay pill (closed shadow DOM so page CSS can't touch it)
  // -------------------------------------------------------------------------------------------
  var host = null, shadow = null, ui = {};
  var hideTimer = null;

  var STYLE = [
    ":host{all:initial}",
    ".wrap{position:fixed;top:16px;left:16px;z-index:2147483647;font:500 13px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI Variable Display','Segoe UI',system-ui,sans-serif;color:rgba(255,255,255,.96);",
    "transition:opacity .28s cubic-bezier(.32,.72,0,1),transform .28s cubic-bezier(.32,.72,0,1);opacity:0;transform:translateY(-6px);pointer-events:none}",
    ".wrap.show{opacity:1;transform:none;pointer-events:auto}",
    ".glass{background:rgba(18,18,22,.65);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);",
    "box-shadow:inset 0 1px 0 rgba(255,255,255,.22),inset 0 0 0 1px rgba(255,255,255,.06),0 12px 40px rgba(0,0,0,.45);border-radius:12px}",
    ".pill{display:flex;align-items:center;gap:10px;padding:6px 12px 6px 6px;max-width:min(520px,70vw)}",
    "button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:9px;background:rgba(255,255,255,.12);font-weight:600;transition:background .2s,transform .2s}",
    "button:hover{background:rgba(255,255,255,.2)}button:active{transform:scale(.96)}button:focus-visible{outline:2px solid #fff;outline-offset:2px}",
    "button.primary{background:rgba(255,255,255,.92);color:#0b0b0f}button.primary:hover{background:#fff}",
    ".title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgba(235,235,245,.72)}",
    ".dot{width:7px;height:7px;border-radius:50%;background:#30d158;flex:none}.dot.warn{background:#ff9f0a}.dot.off{background:rgba(235,235,245,.4)}",
    ".panel{margin-top:10px;padding:14px 16px;max-width:360px}.panel p{margin:0 0 10px;color:rgba(235,235,245,.72)}.panel strong{color:#fff}",
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
      '<div class="glass panel hidden"><p class="msg"></p><button class="primary link">Link this profile</button></div>' +
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
    if (CONFIG.mode === "connect" && !linked) return;
    if (!sticky) hideTimer = setTimeout(function () { ui.wrap.classList.remove("show"); }, 2500);
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
    ui.dot.className = "dot";
    if (lastAck && lastAck.attribution === "rejected") {
      ui.dot.className = "dot warn";
      ui.title.textContent = lastAck.message || "Not tracking: this " + CONFIG.providerName + " profile isn't linked to " + CONFIG.appProfileName;
    } else if (lastAck && lastAck.attribution === "rerouted") {
      ui.dot.className = "dot warn";
      ui.title.textContent = label + " — saving to " + (lastAck.profileName || "another profile");
    } else if (lastAck && lastAck.attribution === "suspended") {
      ui.dot.className = "dot off";
    }
  }

  // -------------------------------------------------------------------------------------------
  // Connect mode: the profile handshake
  // -------------------------------------------------------------------------------------------
  var linked = false;
  var currentProfile = null;

  function pollProfile() {
    if (CONFIG.mode !== "connect" || linked) return;
    var p = detectOttProfile();
    currentProfile = p;
    if (ui.panel) {
      ui.panel.classList.remove("hidden");
      if (p) {
        ui.msg.innerHTML = "";
        ui.msg.append(
          "Signed in to " + CONFIG.providerName + " as ",
          Object.assign(document.createElement("strong"), { textContent: p.name || "profile " + p.id.slice(0, 6) }),
          ". Link it to " + CONFIG.appProfileName + "?",
        );
        ui.link.classList.remove("hidden");
      } else {
        ui.msg.textContent = "Sign in to " + CONFIG.providerName + " and choose who's watching.";
        ui.link.classList.add("hidden");
      }
    }
    showOverlay(true);
  }

  function linkProfile() {
    if (!currentProfile || linked) return;
    ui.link.textContent = "Linking…";
    invoke("report_ott_profile", { token: CONFIG.token, profile: currentProfile }).then(function (res) {
      if (res && res.linked) {
        linked = true;
        ui.msg.textContent = "Linked ✓ Importing your " + CONFIG.providerName + " history…";
        ui.link.classList.add("hidden");
      } else {
        ui.msg.textContent = (res && res.message) || "Couldn't link this profile. Try again.";
        ui.link.textContent = "Link this profile";
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
      // Nearest date heading above this entry.
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

  function runImport() {
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
        invoke("submit_scraped_history", {
          token: CONFIG.token,
          items: items.slice(0, 2000),
          ottProfile: detectOttProfile(),
          pageUrl: location.origin + location.pathname,
          error: items.length ? null : "No history entries were found on " + location.hostname,
        });
        return;
      }
      setTimeout(tick, 1500);
    }
    setTimeout(tick, 2500);
  }

  // -------------------------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------------------------
  function boot() {
    buildOverlay();
    document.addEventListener("fullscreenchange", mountOverlay);
    document.addEventListener("mousemove", function () { showOverlay(false); }, { passive: true });

    if (CONFIG.mode === "import") {
      runImport();
      return;
    }
    if (CONFIG.mode === "connect") {
      pollProfile();
      setInterval(pollProfile, 1500);
      return;
    }

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
      // Periodic sync every CONFIG.syncIntervalMs while playing; idle heartbeats are skipped.
      if (video && (isPlaying(video) || activeAccum > 0)) sendSync("progress");
    }, CONFIG.syncIntervalMs || 3000);

    scan();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})

//! Direct stream URL resolver backed by JustWatch's public GraphQL API.
//!
//! TMDB's `/watch/providers` only links to an intermediate JustWatch page. This module asks
//! JustWatch for the exact `standardWebURL` of every regional offer (Netflix `/title/...`,
//! Hotstar `/in/movies/...`, Prime `/detail/...`, ...), caches the result in `deep_links`
//! for 7 days, and synthesises deterministic provider search URLs whenever no direct link
//! exists, so playback never dead-ends.
//!
//! Privacy: the only data sent to JustWatch is the public title, release year and region.
//! No profile, history, cookie or device identifier ever leaves the machine.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use crate::db::queries::{self, DeepLink};
use crate::db::Database;
use crate::{AppError, AppResult};

pub const JUSTWATCH_GRAPHQL_ENDPOINT: &str = "https://apis.justwatch.com/graphql";
/// Direct links are stable; keep them for 7 days.
pub const DEEP_LINK_TTL_HOURS: i64 = 24 * 7;
/// Search-page fallbacks are retried daily in case JustWatch picks the title up.
pub const FALLBACK_TTL_HOURS: i64 = 24;
/// `quality` marker stored for synthesised search-page fallbacks.
pub const FALLBACK_QUALITY: &str = "SEARCH";

const SEARCH_RESULT_LIMIT: i64 = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

const SEARCH_TITLES_QUERY: &str = r#"
query OmniaSearchTitles(
  $searchTitlesFilter: TitleFilter!,
  $country: Country!,
  $language: Language!,
  $first: Int!,
  $filter: OfferFilter!
) {
  popularTitles(
    country: $country
    filter: $searchTitlesFilter
    first: $first
    sortBy: POPULAR
    sortRandomSeed: 0
  ) {
    edges {
      node {
        id
        objectId
        objectType
        content(country: $country, language: $language) {
          title
          fullPath
          originalReleaseYear
          externalIds {
            imdbId
            tmdbId
          }
        }
        offers(country: $country, platform: WEB, filter: $filter) {
          monetizationType
          presentationType
          standardWebURL
          package {
            id
            packageId
            clearName
            technicalName
          }
        }
      }
    }
  }
}
"#;

// ---------------------------------------------------------------------------------------------
// Public request / response types (mirrored in src/services/tauriBridge.ts)
// ---------------------------------------------------------------------------------------------

/// A provider TMDB reports for the title in this region (from `/watch/providers`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TmdbProviderHint {
    pub provider_id: i64,
    pub provider_name: String,
    /// `flatrate` | `free` | `ads` | `rent` | `buy`
    pub monetization_type: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRequest {
    pub tmdb_id: i64,
    pub media_type: String,
    pub title: String,
    #[serde(default)]
    pub original_title: Option<String>,
    #[serde(default)]
    pub release_year: Option<i32>,
    pub region: String,
    #[serde(default)]
    pub tmdb_providers: Vec<TmdbProviderHint>,
    #[serde(default)]
    pub force_refresh: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    pub provider_id: i64,
    pub provider_name: String,
    pub monetization_type: String,
    pub direct_url: String,
    pub quality: Option<String>,
    /// True when `direct_url` is a provider search page rather than the title itself.
    pub is_fallback: bool,
    pub expires_at: Option<String>,
}

impl From<DeepLink> for ResolvedLink {
    fn from(l: DeepLink) -> Self {
        let is_fallback = l.quality.as_deref() == Some(FALLBACK_QUALITY);
        Self {
            provider_id: l.provider_id,
            provider_name: l.provider_name,
            monetization_type: l.monetization_type,
            direct_url: l.direct_url,
            quality: if is_fallback { None } else { l.quality },
            is_fallback,
            expires_at: l.expires_at,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LinkSource {
    /// Served from the local SQLite cache (0ms network).
    Cache,
    /// Freshly resolved from JustWatch GraphQL.
    Justwatch,
    /// JustWatch had no confident match (or was unreachable); deterministic search URLs only.
    Fallback,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResponse {
    pub tmdb_id: i64,
    pub media_type: String,
    pub region_code: String,
    pub source: LinkSource,
    /// The JustWatch title page, when a match was found (useful "more options" link).
    pub justwatch_url: Option<String>,
    pub links: Vec<ResolvedLink>,
}

// ---------------------------------------------------------------------------------------------
// GraphQL wire types
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GraphqlResponse<T> {
    data: Option<T>,
    errors: Option<Vec<GraphqlError>>,
}

#[derive(Debug, Deserialize)]
struct GraphqlError {
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchData {
    popular_titles: Option<PopularTitles>,
}

#[derive(Debug, Deserialize)]
struct PopularTitles {
    edges: Option<Vec<TitleEdge>>,
}

#[derive(Debug, Deserialize)]
struct TitleEdge {
    node: Option<TitleNode>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleNode {
    #[allow(dead_code)]
    id: Option<String>,
    #[allow(dead_code)]
    object_id: Option<i64>,
    object_type: Option<String>,
    content: Option<TitleContent>,
    offers: Option<Vec<Offer>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleContent {
    title: Option<String>,
    full_path: Option<String>,
    original_release_year: Option<i32>,
    external_ids: Option<ExternalIds>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalIds {
    #[allow(dead_code)]
    imdb_id: Option<String>,
    /// JustWatch returns this as a string; accept numbers too.
    tmdb_id: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Offer {
    monetization_type: Option<String>,
    presentation_type: Option<String>,
    #[serde(rename = "standardWebURL")]
    standard_web_url: Option<String>,
    package: Option<OfferPackage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfferPackage {
    package_id: i64,
    clear_name: String,
    #[allow(dead_code)]
    technical_name: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
pub struct JustWatchResolver {
    http: reqwest::Client,
}

impl JustWatchResolver {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    /// Resolves (cache-first) every playable link for a title in a region.
    pub async fn resolve(&self, db: &Database, req: ResolveRequest) -> AppResult<ResolveResponse> {
        let region = req.region.trim().to_ascii_uppercase();
        if region.len() != 2 || !region.chars().all(|c| c.is_ascii_alphabetic()) {
            return Err(AppError::Message(format!("invalid region code '{}'", req.region)));
        }
        let tmdb_id = req.tmdb_id;
        let media_type = req.media_type.clone();

        if !req.force_refresh {
            let (mt, rg) = (media_type.clone(), region.clone());
            let cached = db
                .run(move |c| queries::get_valid_deep_links(c, tmdb_id, &mt, &rg))
                .await?;
            if !cached.is_empty() {
                return Ok(ResolveResponse {
                    tmdb_id,
                    media_type,
                    region_code: region,
                    source: LinkSource::Cache,
                    justwatch_url: None,
                    links: cached.into_iter().map(ResolvedLink::from).collect(),
                });
            }
        }

        let (mut links, justwatch_url, mut source, persist) = match self.lookup(&req, &region).await {
            Ok(Some(node)) => {
                let url = node
                    .content
                    .as_ref()
                    .and_then(|c| c.full_path.as_deref())
                    .map(|p| format!("https://www.justwatch.com{p}"));
                (links_from_offers(&node), url, LinkSource::Justwatch, true)
            }
            Ok(None) => (Vec::new(), None, LinkSource::Fallback, true),
            Err(err) => {
                // Network failures must not break playback; serve fallbacks but don't cache them.
                log::warn!("JustWatch lookup failed for tmdb:{tmdb_id} ({region}): {err}");
                (Vec::new(), None, LinkSource::Fallback, false)
            }
        };

        merge_tmdb_hints(&mut links, &req.tmdb_providers, &req.title, &region);

        if links.is_empty() {
            // Nothing is known anywhere: hand back a regional JustWatch search so the UI still has a target.
            links.push(ResolvedLink {
                provider_id: 0,
                provider_name: "JustWatch".into(),
                monetization_type: "search".into(),
                direct_url: justwatch_url
                    .clone()
                    .unwrap_or_else(|| justwatch_search_url(&req.title, &region)),
                quality: None,
                is_fallback: true,
                expires_at: None,
            });
            source = LinkSource::Fallback;
            return Ok(ResolveResponse { tmdb_id, media_type, region_code: region, source, justwatch_url, links });
        }

        if source == LinkSource::Justwatch && links.iter().all(|l| l.is_fallback) {
            source = LinkSource::Fallback;
        }

        if persist {
            let rows: Vec<(DeepLink, i64)> = links
                .iter()
                .map(|l| {
                    let ttl = if l.is_fallback { FALLBACK_TTL_HOURS } else { DEEP_LINK_TTL_HOURS };
                    (
                        DeepLink {
                            tmdb_id,
                            media_type: media_type.clone(),
                            region_code: region.clone(),
                            provider_id: l.provider_id,
                            provider_name: l.provider_name.clone(),
                            monetization_type: l.monetization_type.clone(),
                            direct_url: l.direct_url.clone(),
                            quality: if l.is_fallback { Some(FALLBACK_QUALITY.into()) } else { l.quality.clone() },
                            expires_at: None,
                            resolved_at: None,
                        },
                        ttl,
                    )
                })
                .collect();
            let (mt, rg) = (media_type.clone(), region.clone());
            let stored = db
                .run(move |c| {
                    queries::replace_deep_links(c, tmdb_id, &mt, &rg, &rows)?;
                    queries::get_valid_deep_links(c, tmdb_id, &mt, &rg)
                })
                .await?;
            links = stored.into_iter().map(ResolvedLink::from).collect();
        } else {
            sort_links(&mut links);
        }

        Ok(ResolveResponse { tmdb_id, media_type, region_code: region, source, justwatch_url, links })
    }

    /// Searches JustWatch by title (then original title) and returns the best confident match.
    async fn lookup(&self, req: &ResolveRequest, region: &str) -> AppResult<Option<TitleNode>> {
        let mut queries_to_try = vec![req.title.trim().to_string()];
        if let Some(orig) = req.original_title.as_deref().map(str::trim) {
            if !orig.is_empty() && normalize_title(orig) != normalize_title(&req.title) {
                queries_to_try.push(orig.to_string());
            }
        }
        for q in queries_to_try.into_iter().filter(|q| !q.is_empty()) {
            let nodes = self.search(&q, region).await?;
            if let Some(idx) = pick_best_match(&nodes, req) {
                return Ok(nodes.into_iter().nth(idx));
            }
        }
        Ok(None)
    }

    async fn search(&self, query: &str, region: &str) -> AppResult<Vec<TitleNode>> {
        let body = json!({
            "operationName": "OmniaSearchTitles",
            "query": SEARCH_TITLES_QUERY,
            "variables": {
                "searchTitlesFilter": { "searchQuery": query },
                "country": region,
                "language": "en",
                "first": SEARCH_RESULT_LIMIT,
                "filter": { "bestOnly": false }
            }
        });
        let resp = self
            .http
            .post(JUSTWATCH_GRAPHQL_ENDPOINT)
            .timeout(REQUEST_TIMEOUT)
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(AppError::Message(format!("JustWatch returned HTTP {status}")));
        }
        let parsed: GraphqlResponse<SearchData> = resp.json().await?;
        if let Some(data) = parsed.data {
            return Ok(data
                .popular_titles
                .and_then(|p| p.edges)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|e| e.node)
                .collect());
        }
        let msg = parsed
            .errors
            .unwrap_or_default()
            .into_iter()
            .map(|e| e.message)
            .collect::<Vec<_>>()
            .join("; ");
        Err(AppError::Message(format!("JustWatch GraphQL error: {msg}")))
    }
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

/// Lowercases, maps `&` to `and`, and strips punctuation so "Spider-Man: No Way Home" and
/// "Spider Man No Way Home" compare equal. Unicode letters (Hindi, Japanese...) are preserved.
pub fn normalize_title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = true;
    for ch in s.chars().flat_map(char::to_lowercase) {
        if ch == '&' {
            if !last_space {
                out.push(' ');
            }
            out.push_str("and ");
            last_space = true;
        } else if ch.is_alphanumeric() {
            out.push(ch);
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    out.trim_end().to_string()
}

fn value_to_i64(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Scores a candidate; `None` means "not this title".
fn score_candidate(node: &TitleNode, req: &ResolveRequest, wanted: &[String]) -> Option<i32> {
    let content = node.content.as_ref()?;

    // An exact TMDB id cross-reference is authoritative in both directions.
    if let Some(jw_tmdb) = content
        .external_ids
        .as_ref()
        .and_then(|e| e.tmdb_id.as_ref())
        .and_then(value_to_i64)
    {
        return if jw_tmdb == req.tmdb_id { Some(10_000) } else { None };
    }

    let candidate = normalize_title(content.title.as_deref().unwrap_or_default());
    if candidate.is_empty() {
        return None;
    }
    let mut score = if wanted.iter().any(|t| *t == candidate) {
        100
    } else if wanted
        .iter()
        .any(|t| candidate.contains(t.as_str()) || t.contains(candidate.as_str()))
    {
        40
    } else {
        return None;
    };

    if let (Some(a), Some(b)) = (req.release_year, content.original_release_year) {
        score += match (a - b).abs() {
            0 => 60,
            1 => 30,
            2 => 0,
            _ => return None,
        };
    }
    (score >= 100).then_some(score)
}

/// Index of the best confident match among `nodes`, restricted to the right media type.
fn pick_best_match(nodes: &[TitleNode], req: &ResolveRequest) -> Option<usize> {
    let wanted_type = if req.media_type == "tv" { "SHOW" } else { "MOVIE" };
    let wanted: Vec<String> = std::iter::once(req.title.as_str())
        .chain(req.original_title.as_deref())
        .map(normalize_title)
        .filter(|t| !t.is_empty())
        .collect();

    nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| {
            n.object_type
                .as_deref()
                .is_some_and(|t| t.eq_ignore_ascii_case(wanted_type))
        })
        .filter_map(|(i, n)| score_candidate(n, req, &wanted).map(|s| (s, i)))
        // On ties prefer the earlier (more popular) result.
        .max_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)))
        .map(|(_, i)| i)
}

// ---------------------------------------------------------------------------------------------
// Offer -> link conversion
// ---------------------------------------------------------------------------------------------

fn normalize_monetization(raw: &str) -> Option<&'static str> {
    match raw.to_ascii_uppercase().as_str() {
        "FLATRATE" | "FLATRATE_AND_BUY" => Some("flatrate"),
        "FREE" => Some("free"),
        "ADS" => Some("ads"),
        "RENT" => Some("rent"),
        "BUY" => Some("buy"),
        // CINEMA and unknown future types are not playable streams.
        _ => None,
    }
}

fn quality_rank(presentation: Option<&str>) -> u8 {
    match presentation.unwrap_or_default().to_ascii_uppercase().as_str() {
        "_4K" | "4K" | "UHD" => 3,
        "HD" => 2,
        "SD" => 1,
        _ => 0,
    }
}

fn quality_label(presentation: Option<&str>) -> Option<String> {
    match quality_rank(presentation) {
        3 => Some("4K".into()),
        2 => Some("HD".into()),
        1 => Some("SD".into()),
        _ => None,
    }
}

fn monetization_order(m: &str) -> u8 {
    match m {
        "flatrate" => 0,
        "free" => 1,
        "ads" => 2,
        "rent" => 3,
        "buy" => 4,
        _ => 5,
    }
}

fn sort_links(links: &mut [ResolvedLink]) {
    links.sort_by(|a, b| {
        monetization_order(&a.monetization_type)
            .cmp(&monetization_order(&b.monetization_type))
            .then_with(|| a.is_fallback.cmp(&b.is_fallback))
            .then_with(|| a.provider_name.to_lowercase().cmp(&b.provider_name.to_lowercase()))
    });
}

/// One link per (provider, monetization), keeping the highest-quality offer.
fn links_from_offers(node: &TitleNode) -> Vec<ResolvedLink> {
    let mut best: HashMap<(i64, &'static str), (u8, ResolvedLink)> = HashMap::new();
    for offer in node.offers.iter().flatten() {
        let Some(monetization) = offer.monetization_type.as_deref().and_then(normalize_monetization) else {
            continue;
        };
        let Some(pkg) = offer.package.as_ref() else { continue };
        let Some(url) = offer.standard_web_url.as_deref().and_then(sanitize_provider_url) else {
            continue;
        };
        let rank = quality_rank(offer.presentation_type.as_deref());
        let link = ResolvedLink {
            provider_id: pkg.package_id,
            provider_name: pkg.clear_name.clone(),
            monetization_type: monetization.to_string(),
            direct_url: url,
            quality: quality_label(offer.presentation_type.as_deref()),
            is_fallback: false,
            expires_at: None,
        };
        match best.entry((pkg.package_id, monetization)) {
            Entry::Occupied(mut e) => {
                if rank > e.get().0 {
                    e.insert((rank, link));
                }
            }
            Entry::Vacant(e) => {
                e.insert((rank, link));
            }
        }
    }
    let mut links: Vec<ResolvedLink> = best.into_values().map(|(_, l)| l).collect();
    sort_links(&mut links);
    links
}

fn normalize_provider_name(name: &str) -> String {
    name.to_lowercase()
        .replace('+', "plus")
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Ensures every provider TMDB lists for the region has a link. If JustWatch already resolved
/// the same provider under another monetization type, reuse that real title URL; otherwise
/// fall back to the provider's deterministic search page.
fn merge_tmdb_hints(links: &mut Vec<ResolvedLink>, hints: &[TmdbProviderHint], title: &str, region: &str) {
    for hint in hints {
        let monetization = hint.monetization_type.trim().to_ascii_lowercase();
        if monetization.is_empty() {
            continue;
        }
        let hint_name = normalize_provider_name(&hint.provider_name);
        let same_provider = |l: &ResolvedLink| {
            l.provider_id == hint.provider_id || normalize_provider_name(&l.provider_name) == hint_name
        };
        if links.iter().any(|l| same_provider(l) && l.monetization_type == monetization) {
            continue;
        }
        let sibling = links.iter().find(|l| same_provider(l) && !l.is_fallback).cloned();
        let link = match sibling {
            Some(s) => ResolvedLink {
                provider_id: hint.provider_id,
                provider_name: hint.provider_name.clone(),
                monetization_type: monetization,
                direct_url: s.direct_url,
                quality: s.quality,
                is_fallback: false,
                expires_at: None,
            },
            None => ResolvedLink {
                provider_id: hint.provider_id,
                provider_name: hint.provider_name.clone(),
                monetization_type: monetization,
                direct_url: fallback_search_url(hint.provider_id, &hint.provider_name, title, region),
                quality: None,
                is_fallback: true,
                expires_at: None,
            },
        };
        links.push(link);
    }
}

// ---------------------------------------------------------------------------------------------
// URL hygiene & deterministic fallbacks
// ---------------------------------------------------------------------------------------------

fn is_tracking_param(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.starts_with("utm_")
        || matches!(
            k.as_str(),
            "tag" | "ref_" | "clickref" | "irclickid" | "irgwc" | "irpid" | "affiliate" | "aff_id"
                | "affid" | "subid" | "sub_id" | "gclid" | "fbclid" | "msclkid" | "trackid"
                | "partnerid" | "jwsource" | "jw_source" | "camp" | "creative" | "linkcode"
        )
}

/// Unwraps JustWatch click-redirects, strips affiliate/tracking parameters and forces HTTPS,
/// so the player opens the provider page directly without third-party attribution.
pub fn sanitize_provider_url(raw: &str) -> Option<String> {
    let mut url = Url::parse(raw.trim()).ok()?;

    let is_redirect = url
        .host_str()
        .is_some_and(|h| h.ends_with("justwatch.com") && h.starts_with("click"));
    if is_redirect {
        let target = url
            .query_pairs()
            .find(|(k, _)| k == "r")
            .map(|(_, v)| v.into_owned())?;
        url = Url::parse(&target).ok()?;
    }

    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return None;
    }
    if url.scheme() == "http" {
        url.set_scheme("https").ok()?;
    }

    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| !is_tracking_param(k))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if kept.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(kept.iter());
    }
    Some(url.into())
}

fn encode_query(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.trim().as_bytes()).collect()
}

pub fn justwatch_search_url(title: &str, region: &str) -> String {
    format!(
        "https://www.justwatch.com/{}/search?q={}",
        region.to_ascii_lowercase(),
        encode_query(title)
    )
}

/// Deterministic provider search URL used when no direct deep link is known.
/// Matches by TMDB/JustWatch provider id first, then by provider name.
pub fn fallback_search_url(provider_id: i64, provider_name: &str, title: &str, region: &str) -> String {
    let q = encode_query(title);
    let region_lower = region.to_ascii_lowercase();
    let name = provider_name.to_lowercase();
    let has = |needle: &str| name.contains(needle);

    // Order matters: "Disney+ Hotstar" must hit Hotstar before Disney+, "Amazon Prime Video"
    // must hit Prime before the Amazon store, etc.
    if matches!(provider_id, 8 | 175 | 1796) || has("netflix") {
        format!("https://www.netflix.com/search?q={q}")
    } else if matches!(provider_id, 122 | 220 | 2336) || has("hotstar") || has("jiocinema") {
        format!("https://www.hotstar.com/{region_lower}/explore?search_query={q}")
    } else if matches!(provider_id, 9 | 119 | 2100) || has("prime video") || has("amazon prime") {
        format!("https://www.primevideo.com/search/?phrase={q}")
    } else if provider_id == 10 || has("amazon video") || has("amazon") {
        format!("https://www.primevideo.com/search/?phrase={q}")
    } else if provider_id == 337 || has("disney") {
        format!("https://www.disneyplus.com/search?q={q}")
    } else if matches!(provider_id, 2 | 350) || has("apple tv") || has("itunes") {
        format!("https://tv.apple.com/{region_lower}/search?term={q}")
    } else if provider_id == 232 || has("zee5") {
        format!("https://www.zee5.com/search?q={q}")
    } else if provider_id == 237 || has("sonyliv") || has("sony liv") {
        format!("https://www.sonyliv.com/search?searchTerm={q}")
    } else if matches!(provider_id, 1899 | 384) || has("hbo") || name == "max" || name.starts_with("max ") {
        format!("https://play.hbomax.com/search?q={q}")
    } else if provider_id == 15 || has("hulu") {
        format!("https://www.hulu.com/search?q={q}")
    } else if matches!(provider_id, 386 | 387) || has("peacock") {
        format!("https://www.peacocktv.com/search?q={q}")
    } else if provider_id == 531 || has("paramount") {
        format!("https://www.paramountplus.com/search/?query={q}")
    } else if provider_id == 283 || has("crunchyroll") {
        format!("https://www.crunchyroll.com/search?q={q}")
    } else if provider_id == 11 || has("mubi") {
        format!("https://mubi.com/{region_lower}/search/films?query={q}")
    } else if provider_id == 3 || has("google play") {
        format!("https://play.google.com/store/search?q={q}&c=movies")
    } else if provider_id == 192 || has("youtube") {
        format!("https://www.youtube.com/results?search_query={q}")
    } else if has("mx player") {
        format!("https://www.mxplayer.in/search?q={q}")
    } else {
        justwatch_search_url(title, region)
    }
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn req(title: &str, year: Option<i32>, media_type: &str) -> ResolveRequest {
        ResolveRequest {
            tmdb_id: 603,
            media_type: media_type.into(),
            title: title.into(),
            original_title: None,
            release_year: year,
            region: "IN".into(),
            tmdb_providers: vec![],
            force_refresh: false,
        }
    }

    fn node(title: &str, year: i32, ty: &str, tmdb: Option<&str>) -> TitleNode {
        TitleNode {
            id: Some("tm1".into()),
            object_id: Some(1),
            object_type: Some(ty.into()),
            content: Some(TitleContent {
                title: Some(title.into()),
                full_path: Some("/in/movie/the-matrix".into()),
                original_release_year: Some(year),
                external_ids: Some(ExternalIds {
                    imdb_id: None,
                    tmdb_id: tmdb.map(|t| Value::String(t.into())),
                }),
            }),
            offers: None,
        }
    }

    #[test]
    fn normalizes_titles() {
        assert_eq!(normalize_title("Spider-Man: No Way Home"), "spider man no way home");
        assert_eq!(normalize_title("Fast & Furious"), "fast and furious");
        assert_eq!(normalize_title("  RRR!! "), "rrr");
    }

    #[test]
    fn tmdb_id_is_authoritative() {
        let nodes = vec![
            node("The Matrix", 1999, "MOVIE", Some("999")),
            node("The Matrix", 1999, "MOVIE", Some("603")),
        ];
        assert_eq!(pick_best_match(&nodes, &req("The Matrix", Some(1999), "movie")), Some(1));
    }

    #[test]
    fn title_and_year_match_without_ids() {
        let nodes = vec![
            node("The Matrix", 1999, "SHOW", None),
            node("The Matrix Resurrections", 2021, "MOVIE", None),
            node("The Matrix", 1999, "MOVIE", None),
        ];
        assert_eq!(pick_best_match(&nodes, &req("The Matrix", Some(1999), "movie")), Some(2));
        assert_eq!(pick_best_match(&nodes, &req("The Matrix", Some(2010), "movie")), None);
    }

    #[test]
    fn sanitizes_urls() {
        assert_eq!(
            sanitize_provider_url("http://www.netflix.com/title/20557937?trackId=1&utm_source=jw").as_deref(),
            Some("https://www.netflix.com/title/20557937")
        );
        let wrapped = "https://click.justwatch.com/a?cx=x&r=https%3A%2F%2Fwww.primevideo.com%2Fdetail%2F0ABC%3Ftag%3Djw-21%26t%3D0&uct_country=in";
        assert_eq!(
            sanitize_provider_url(wrapped).as_deref(),
            Some("https://www.primevideo.com/detail/0ABC?t=0")
        );
        assert_eq!(sanitize_provider_url("javascript:alert(1)"), None);
    }

    #[test]
    fn fallbacks_never_fail() {
        assert_eq!(
            fallback_search_url(8, "Netflix", "Dark", "DE"),
            "https://www.netflix.com/search?q=Dark"
        );
        assert!(fallback_search_url(0, "Disney+ Hotstar", "Loki", "IN").starts_with("https://www.hotstar.com/in/"));
        assert!(fallback_search_url(99999, "Obscure Flix", "Some Film", "IN")
            .starts_with("https://www.justwatch.com/in/search?q=Some+Film"));
    }

    #[test]
    fn hints_reuse_real_links_and_fill_gaps() {
        let mut links = vec![ResolvedLink {
            provider_id: 8,
            provider_name: "Netflix".into(),
            monetization_type: "flatrate".into(),
            direct_url: "https://www.netflix.com/title/1".into(),
            quality: Some("HD".into()),
            is_fallback: false,
            expires_at: None,
        }];
        let hints = vec![
            TmdbProviderHint { provider_id: 8, provider_name: "Netflix".into(), monetization_type: "flatrate".into() },
            TmdbProviderHint { provider_id: 8, provider_name: "Netflix".into(), monetization_type: "ads".into() },
            TmdbProviderHint { provider_id: 232, provider_name: "Zee5".into(), monetization_type: "flatrate".into() },
        ];
        merge_tmdb_hints(&mut links, &hints, "Dark", "IN");
        assert_eq!(links.len(), 3);
        assert_eq!(links[1].direct_url, "https://www.netflix.com/title/1");
        assert!(!links[1].is_fallback);
        assert!(links[2].is_fallback);
        assert!(links[2].direct_url.starts_with("https://www.zee5.com/search"));
    }
}

//! Behavioural + vector recommendation engine (100% local, isolated per `app_profile_id`).
//!
//! Pipeline for one profile:
//! 1. **Signals** — fold that profile's `watch_history`, `playback_events` (Step 3 telemetry) and
//!    watchlist into per-title signals: completion, partial progress, binge sessions, early
//!    abandonment, rewatches, skimming (forward seeks), active watch time, time-of-day buckets.
//! 2. **Affinity** — turn signals into an implicit weight `W_i`:
//!    completion `+1.0`, Comfort Favorite (rewatch) `+2.0`, binge velocity `×1.8`,
//!    early abandonment `−0.8`, plus partial progress, watchlist intent, engagement and skimming,
//!    all decayed by recency (half-life 120 days) so the taste profile keeps moving.
//! 3. **Composite vectors & taste clusters** — every title is a composite "vibe" vector
//!    (embeddings.rs: keywords 40%, director + top-3 cast 25%, genres 20%, plot 15%). The
//!    profile's positive titles are clustered with weighted spherical K-means (K = 1 / 2 / 3 by
//!    history size) so distinct tastes aren't averaged into one "smoothie"; a weighted global
//!    centroid and per-time-of-day centroids still drive the context rows, and disliked titles
//!    push every query away (Rocchio-style).
//! 4. **Candidates** — TMDB discover (filtered by region + subscribed providers, kids-safe for kids
//!    profiles), genre-targeted discover, trending and "recommendations" of each cluster's
//!    strongest titles. Titles the profile already interacted with are excluded.
//! 5. **Ranking** — a nearest-neighbour search (dot product with the unit query) per cluster
//!    centroid with MMR diversity, interleaved in proportion to cluster mass ("We Think You'll
//!    Love These"), plus explainable rows ("Because you binged …").
//!
//! "More Like This" on the info page ([`similar_titles`]) is a single-title nearest-neighbour
//! search over titles already embedded locally, followed by TMDB's own list (fast path).
//! Vectors are persisted per title in `title_vectors` (content only) keyed by a content hash.
//!
//! Isolation: every database read is filtered by `app_profile_id`; vectors persisted in
//! `media_embeddings` are written under that profile only. The in-memory vector cache holds
//! title-content embeddings only (no user data), so it is safely shared.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Timelike, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::db::queries::{self, MediaCatalogEntry, PlaybackEvent, WatchHistoryEntry, WatchlistItem};
use crate::ml::embeddings::{Embedder, EmbeddingService, EmbeddingStatus, MediaDocument, Tone};
use crate::sync::history_importer::TmdbClient;
use crate::{AppError, AppResult, AppState};

// ---------------------------------------------------------------------------------------------
// Tunables (CLAUDE.md §5.6)
// ---------------------------------------------------------------------------------------------

pub const COMPLETION_THRESHOLD: f64 = 0.85;
pub const COMPLETION_BONUS: f64 = 1.0;
pub const BINGE_MULTIPLIER: f64 = 1.8;
pub const BINGE_EPISODES: usize = 3;
pub const ABANDONMENT_PENALTY: f64 = -0.8;
pub const COMFORT_BONUS: f64 = 2.0;
/// "Love": an explicit favorite is the strongest positive signal (above a rewatch).
pub const FAVORITE_BONUS: f64 = 3.0;
const PARTIAL_WEIGHT: f64 = 0.4;
const WATCHLIST_BONUS: f64 = 0.4;
const ENGAGEMENT_WEIGHT: f64 = 0.15;
const SKIM_PENALTY: f64 = -0.2;
const SKIM_RATIO: f64 = 0.25;
const RECENCY_HALF_LIFE_DAYS: f64 = 120.0;
const BINGE_WINDOW_HOURS: i64 = 6;
/// Weight of the negative (disliked) centroid subtracted from the query.
const NEGATIVE_PUSH: f32 = 0.3;
const MMR_LAMBDA: f32 = 0.72;
const RESULT_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_CANDIDATES: usize = 160;
const MAX_DETAIL_FETCHES: usize = 160;
const MAX_PROVIDER_CHECKS: usize = 40;
const TMDB_CONCURRENCY: usize = 6;

pub const BUCKETS: [&str; 5] = ["Morning", "Afternoon", "Evening", "PrimeTime", "LateNight"];

pub fn bucket_index(name: &str) -> Option<usize> {
    BUCKETS.iter().position(|b| *b == name)
}

pub fn bucket_for_hour(hour: u32) -> usize {
    bucket_index(queries::time_of_day_bucket(hour)).expect("bucket names are consistent")
}

fn bucket_phrase(idx: usize) -> &'static str {
    match idx {
        0 => "in the morning",
        1 => "in the afternoon",
        2 => "in the evening",
        3 => "in prime time",
        _ => "late at night",
    }
}

fn bucket_row_title(idx: usize) -> &'static str {
    match idx {
        0 => "Easy morning watches",
        1 => "Afternoon picks",
        2 => "Your evening line-up",
        3 => "Prime-time picks for tonight",
        _ => "Late-night picks for you",
    }
}

type TitleKey = (i64, String);
type SimilarCache = HashMap<(i64, String, bool), (Instant, Arc<SimilarTitles>)>;
/// A TMDB list request: (path, query params, media type of its results).
type ListQuery = (String, Vec<(&'static str, String)>, &'static str);

fn parse_db_time(s: &str) -> Option<DateTime<Utc>> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|n| Utc.from_utc_datetime(&n))
}

// ---------------------------------------------------------------------------------------------
// 1. Behavioural signals
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TitleSignals {
    pub tmdb_id: i64,
    pub media_type: String,
    /// Movies: 1. Series: distinct episodes started / completed.
    pub started_units: u32,
    pub completed_units: u32,
    pub max_ratio: f64,
    pub abandoned: bool,
    pub max_watch_count: i64,
    pub binge: bool,
    pub watchlisted: bool,
    /// Loved by the user (favorites table).
    pub favorited: bool,
    pub active_seconds: f64,
    pub seek_forward_seconds: f64,
    pub runtime_seconds: f64,
    pub last_activity: Option<DateTime<Utc>>,
    /// Interaction counts per time-of-day bucket (see `BUCKETS`).
    pub buckets: [f64; 5],
}

impl TitleSignals {
    pub fn bucket_shares(&self) -> [f64; 5] {
        let total: f64 = self.buckets.iter().sum();
        if total <= 0.0 {
            return [0.0; 5];
        }
        self.buckets.map(|b| b / total)
    }

    pub fn dominant_bucket(&self) -> Option<usize> {
        let shares = self.bucket_shares();
        let (idx, share) = shares
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))?;
        (*share >= 0.5).then_some(idx)
    }
}

/// True when `times` contains `BINGE_EPISODES` items inside any `BINGE_WINDOW_HOURS` window.
fn has_binge_window(times: &mut [DateTime<Utc>]) -> bool {
    times.sort();
    let window = chrono::Duration::hours(BINGE_WINDOW_HOURS);
    times.windows(BINGE_EPISODES).any(|w| w[w.len() - 1] - w[0] <= window)
}

/// Folds one profile's raw activity into per-title signals.
/// Marks favorites on the signals, adding titles that have no other interaction.
pub fn apply_favorites(map: &mut HashMap<TitleKey, TitleSignals>, favorites: &[WatchlistItem]) {
    for f in favorites {
        let s = map.entry((f.tmdb_id, f.media_type.clone())).or_insert_with(|| TitleSignals {
            tmdb_id: f.tmdb_id,
            media_type: f.media_type.clone(),
            ..Default::default()
        });
        s.favorited = true;
        if s.last_activity.is_none() {
            s.last_activity = parse_db_time(&f.added_at);
        }
    }
}

pub fn collect_signals(
    history: &[WatchHistoryEntry],
    events: &[PlaybackEvent],
    watchlist: &[WatchlistItem],
) -> HashMap<TitleKey, TitleSignals> {
    let mut map: HashMap<TitleKey, TitleSignals> = HashMap::new();
    let mut episode_times: HashMap<TitleKey, Vec<DateTime<Utc>>> = HashMap::new();
    let mut durations: HashMap<TitleKey, f64> = HashMap::new();
    let entry = |map: &mut HashMap<TitleKey, TitleSignals>, id: i64, mt: &str| -> TitleKey {
        let key = (id, mt.to_string());
        map.entry(key.clone()).or_insert_with(|| TitleSignals {
            tmdb_id: id,
            media_type: mt.to_string(),
            ..Default::default()
        });
        key
    };

    for row in history {
        let key = entry(&mut map, row.tmdb_id, &row.media_type);
        let s = map.get_mut(&key).expect("inserted");
        let completed = row.is_completed || row.completion_ratio >= COMPLETION_THRESHOLD;
        if row.progress_seconds >= 30.0 || completed {
            s.started_units += 1;
        }
        if completed {
            s.completed_units += 1;
        }
        s.max_ratio = s.max_ratio.max(row.completion_ratio);
        s.abandoned |= row.abandoned;
        s.max_watch_count = s.max_watch_count.max(row.watch_count);
        if row.duration_seconds > 1.0 {
            *durations.entry(key.clone()).or_default() += row.duration_seconds;
        }
        let at = parse_db_time(&row.last_watched_at);
        if let Some(at) = at {
            s.last_activity = s.last_activity.max(Some(at));
            if row.media_type == "tv" && row.completion_ratio >= 0.5 {
                episode_times.entry(key.clone()).or_default().push(at);
            }
        }
        if let Some(b) = row.time_of_day_bucket.as_deref().and_then(bucket_index) {
            s.buckets[b] += 1.0;
        }
    }

    for ev in events {
        let key = entry(&mut map, ev.tmdb_id, &ev.media_type);
        let s = map.get_mut(&key).expect("inserted");
        let at = parse_db_time(&ev.timestamp);
        match ev.event_type.as_str() {
            "binge_session" => s.binge = true,
            "abandoned" => s.abandoned = true,
            "session_end" => s.active_seconds += ev.session_watch_duration_sec.max(0.0),
            "seek_forward" => s.seek_forward_seconds += ev.session_watch_duration_sec.max(0.0),
            _ => {}
        }
        if matches!(ev.event_type.as_str(), "play_start" | "session_end") {
            if let Some(at) = at {
                s.last_activity = s.last_activity.max(Some(at));
                s.buckets[bucket_for_hour(at.with_timezone(&Local).hour())] += 1.0;
            }
        }
    }

    for item in watchlist {
        let key = entry(&mut map, item.tmdb_id, &item.media_type);
        let s = map.get_mut(&key).expect("inserted");
        s.watchlisted = true;
        if s.last_activity.is_none() {
            s.last_activity = parse_db_time(&item.added_at);
        }
    }

    for (key, mut times) in episode_times {
        if has_binge_window(&mut times) {
            if let Some(s) = map.get_mut(&key) {
                s.binge = true;
            }
        }
    }
    for (key, total) in durations {
        if let Some(s) = map.get_mut(&key) {
            s.runtime_seconds = total;
        }
    }
    // A finished title isn't "abandoned", even if an earlier attempt was.
    for s in map.values_mut() {
        if s.completed_units > 0 {
            s.abandoned = false;
        }
    }
    map
}

// ---------------------------------------------------------------------------------------------
// 2. Affinity weights
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Affinity {
    pub weight: f64,
    pub completion: f64,
    pub partial: f64,
    pub comfort: f64,
    pub watchlist: f64,
    pub favorite: f64,
    pub engagement: f64,
    pub binge_multiplier: f64,
    pub abandonment: f64,
    pub skimming: f64,
    pub recency: f64,
}

pub fn compute_affinity(s: &TitleSignals, now: DateTime<Utc>) -> Affinity {
    let completion = if s.completed_units == 0 {
        0.0
    } else if s.media_type == "tv" {
        let rate = s.completed_units as f64 / s.started_units.max(1) as f64;
        COMPLETION_BONUS * rate.max(0.5) + 0.2 * (s.completed_units as f64).log2()
    } else {
        COMPLETION_BONUS
    };
    let partial = if completion == 0.0 && !s.abandoned { PARTIAL_WEIGHT * s.max_ratio } else { 0.0 };
    let comfort = if s.max_watch_count > 1 { COMFORT_BONUS } else { 0.0 };
    let watchlist = if s.watchlisted { WATCHLIST_BONUS } else { 0.0 };
    let favorite = if s.favorited { FAVORITE_BONUS } else { 0.0 };
    let engagement = ENGAGEMENT_WEIGHT * (1.0 + s.active_seconds / 3600.0).ln();
    let binge_multiplier = if s.binge { BINGE_MULTIPLIER } else { 1.0 };
    let abandonment = if s.abandoned { ABANDONMENT_PENALTY } else { 0.0 };
    let skimming = if s.runtime_seconds > 0.0 && s.seek_forward_seconds / s.runtime_seconds > SKIM_RATIO {
        SKIM_PENALTY
    } else {
        0.0
    };
    let age_days = s
        .last_activity
        .map(|t| (now - t).num_seconds().max(0) as f64 / 86_400.0)
        .unwrap_or(365.0);
    // Loved and rewatched titles stay part of the taste profile even years later.
    let floor = if favorite > 0.0 { 0.7 } else if comfort > 0.0 { 0.5 } else { 0.15 };
    let recency = 0.5f64.powf(age_days / RECENCY_HALF_LIFE_DAYS).max(floor);

    let positive = completion + partial + comfort + watchlist + favorite + engagement;
    // A favorite overrides an old abandonment: the user said they love it.
    let abandonment = if favorite > 0.0 { 0.0 } else { abandonment };
    let weight = (positive * binge_multiplier + abandonment + skimming) * recency;
    Affinity { weight, completion, partial, comfort, watchlist, favorite, engagement, binge_multiplier, abandonment, skimming, recency }
}

// ---------------------------------------------------------------------------------------------
// 3. Taste centroids, cosine, MMR
// ---------------------------------------------------------------------------------------------

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Cosine similarity (vectors are not assumed normalised).
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let (na, nb) = (dot(a, a).sqrt(), dot(b, b).sqrt());
    if na < 1e-9 || nb < 1e-9 {
        0.0
    } else {
        dot(a, b) / (na * nb)
    }
}

fn normalized(mut v: Vec<f32>) -> Option<Vec<f32>> {
    let n = dot(&v, &v).sqrt();
    if n < 1e-9 {
        return None;
    }
    v.iter_mut().for_each(|x| *x /= n);
    Some(v)
}

fn add_scaled(acc: &mut Vec<f32>, v: &[f32], w: f32) {
    if acc.is_empty() {
        acc.resize(v.len(), 0.0);
    }
    acc.iter_mut().zip(v).for_each(|(a, x)| *a += w * x);
}

#[derive(Debug, Clone, Default)]
pub struct TasteProfile {
    pub global: Option<Vec<f32>>,
    pub negative: Option<Vec<f32>>,
    pub buckets: [Option<Vec<f32>>; 5],
    pub bucket_mass: [f64; 5],
    pub positive_mass: f64,
}

impl TasteProfile {
    /// `items`: (embedding, affinity weight, time-of-day shares).
    pub fn build(items: &[(&[f32], f64, [f64; 5])]) -> Self {
        let mut global = Vec::new();
        let mut negative = Vec::new();
        let mut buckets: [Vec<f32>; 5] = Default::default();
        let mut profile = TasteProfile::default();
        for (v, w, shares) in items {
            if *w > 0.0 {
                add_scaled(&mut global, v, *w as f32);
                profile.positive_mass += w;
                for (b, share) in shares.iter().enumerate() {
                    if *share > 0.0 {
                        add_scaled(&mut buckets[b], v, (*w * share) as f32);
                        profile.bucket_mass[b] += w * share;
                    }
                }
            } else if *w < 0.0 {
                add_scaled(&mut negative, v, (-*w) as f32);
            }
        }
        profile.global = normalized(global);
        profile.negative = normalized(negative);
        profile.buckets = buckets.map(normalized);
        profile
    }

    /// Query vector for a context. The bucket centroid's influence grows with how much of the
    /// profile's positive mass was watched in that bucket (max 50%), so sparse buckets fall back
    /// to the global taste.
    pub fn query(&self, bucket: Option<usize>) -> Option<Vec<f32>> {
        let global = self.global.as_ref()?;
        let mut q = global.clone();
        if let Some(b) = bucket {
            if let Some(bv) = &self.buckets[b] {
                let alpha = (0.5 * (self.bucket_mass[b] / (0.25 * self.positive_mass.max(1e-9))).min(1.0)) as f32;
                q.iter_mut().zip(bv).for_each(|(x, y)| *x = (1.0 - alpha) * *x + alpha * y);
            }
        }
        if let Some(neg) = &self.negative {
            q.iter_mut().zip(neg).for_each(|(x, y)| *x -= NEGATIVE_PUSH * y);
        }
        normalized(q)
    }

    pub fn bucket_weight(&self, b: usize) -> f64 {
        if self.positive_mass <= 0.0 {
            0.0
        } else {
            self.bucket_mass[b] / self.positive_mass
        }
    }
}

/// Maximal Marginal Relevance: greedily picks `k` items maximising
/// `λ·relevance − (1−λ)·max similarity to anything already chosen` (including `already`).
pub fn mmr(relevance: &[f32], vectors: &[&[f32]], k: usize, lambda: f32, already: &[&[f32]]) -> Vec<usize> {
    let mut selected: Vec<usize> = Vec::with_capacity(k);
    let mut remaining: Vec<usize> = (0..relevance.len()).collect();
    while selected.len() < k && !remaining.is_empty() {
        let (pos, _) = remaining
            .iter()
            .enumerate()
            .map(|(pos, &i)| {
                let redundancy = selected
                    .iter()
                    .map(|&s| cosine(vectors[i], vectors[s]))
                    .chain(already.iter().map(|a| cosine(vectors[i], a)))
                    .fold(f32::MIN, f32::max);
                let redundancy = if redundancy == f32::MIN { 0.0 } else { redundancy };
                (pos, lambda * relevance[i] - (1.0 - lambda) * redundancy)
            })
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .expect("remaining is non-empty");
        selected.push(remaining.swap_remove(pos));
    }
    selected
}

// ---------------------------------------------------------------------------------------------
// 3b. Taste clusters (weighted spherical K-means)
// ---------------------------------------------------------------------------------------------
//
// One averaged taste vector is a "smoothie": someone who loves both cosy sitcoms and bleak
// sci-fi gets a centroid between them that matches neither. Clustering the liked / watched
// titles first keeps each side of the taste intact; every cluster gets its own nearest-neighbour
// search and the results are interleaved in proportion to how much of the taste it holds.

/// Number of clusters for `n` positively weighted titles: one taste until there is enough
/// history to split it reliably.
pub fn cluster_count(n: usize) -> usize {
    match n {
        0 => 0,
        1..=10 => 1,
        11..=30 => 2,
        _ => 3,
    }
}

/// Small deterministic PRNG (xorshift64*) so a profile's clusters are stable between refreshes.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next_f64(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[derive(Debug, Clone)]
pub struct Clustering {
    /// Cluster index of every point.
    pub assignment: Vec<usize>,
    /// Unit centroids.
    pub centroids: Vec<Vec<f32>>,
    /// Total weight per cluster.
    pub mass: Vec<f64>,
}

const KMEANS_ITERATIONS: usize = 30;
const KMEANS_RESTARTS: u64 = 6;

/// Weighted spherical K-means (cosine distance) with K-means++ seeding. Points are normalised
/// first; weights are the titles' affinities (non-positive weights are ignored). Several seeded
/// restarts keep the best objective (total weighted cosine to the assigned centroid).
pub fn kmeans(points: &[&[f32]], weights: &[f64], k: usize, seed: u64) -> Option<Clustering> {
    let unit: Vec<Vec<f32>> = points.iter().filter_map(|p| normalized(p.to_vec())).collect();
    if unit.len() != points.len() || points.is_empty() {
        return None;
    }
    let w: Vec<f64> = weights.iter().map(|w| w.max(0.0)).collect();
    let k = k.clamp(1, points.len());
    let mut best: Option<(f64, Clustering)> = None;
    for restart in 0..KMEANS_RESTARTS {
        let mut rng = Rng::new(seed ^ (restart + 1).wrapping_mul(0xA24B_AED4_963E_E407));
        // K-means++: the heaviest title first, then sample ∝ weight · distance².
        let first = (0..unit.len()).max_by(|a, b| w[*a].partial_cmp(&w[*b]).unwrap_or(std::cmp::Ordering::Equal))?;
        let mut centroids = vec![unit[first].clone()];
        while centroids.len() < k {
            let d2: Vec<f64> = unit
                .iter()
                .zip(&w)
                .map(|(p, wi)| {
                    let near = centroids.iter().map(|c| dot(p, c)).fold(f32::MIN, f32::max);
                    wi * f64::from((1.0 - near).max(0.0)).powi(2)
                })
                .collect();
            let total: f64 = d2.iter().sum();
            if total <= 1e-12 {
                break; // every remaining point coincides with a centroid
            }
            let mut r = rng.next_f64() * total;
            let pick = d2.iter().position(|d| {
                r -= d;
                r <= 0.0
            });
            centroids.push(unit[pick.unwrap_or(unit.len() - 1)].clone());
        }

        let mut assignment = vec![usize::MAX; unit.len()];
        for _ in 0..KMEANS_ITERATIONS {
            let next: Vec<usize> = unit
                .iter()
                .map(|p| {
                    (0..centroids.len())
                        .max_by(|a, b| dot(p, &centroids[*a]).partial_cmp(&dot(p, &centroids[*b])).unwrap_or(std::cmp::Ordering::Equal))
                        .unwrap_or(0)
                })
                .collect();
            let changed = next != assignment;
            assignment = next;
            let updated: Vec<Option<Vec<f32>>> = (0..centroids.len())
                .map(|c| {
                    let mut acc = Vec::new();
                    for (i, p) in unit.iter().enumerate() {
                        if assignment[i] == c {
                            add_scaled(&mut acc, p, w[i].max(1e-6) as f32);
                        }
                    }
                    normalized(acc)
                })
                .collect();
            let mut reseeded = false;
            for (c, next_centroid) in updated.into_iter().enumerate() {
                match next_centroid {
                    Some(v) => centroids[c] = v,
                    // Empty cluster: re-seed it with the point its own centroid explains worst.
                    None => {
                        let worst = (0..unit.len()).min_by(|a, b| {
                            let fa = dot(&unit[*a], &centroids[assignment[*a]]);
                            let fb = dot(&unit[*b], &centroids[assignment[*b]]);
                            fa.partial_cmp(&fb).unwrap_or(std::cmp::Ordering::Equal)
                        });
                        if let Some(worst) = worst {
                            centroids[c] = unit[worst].clone();
                            reseeded = true;
                        }
                    }
                }
            }
            if !changed && !reseeded {
                break;
            }
        }

        let objective: f64 = unit.iter().zip(&assignment).zip(&w).map(|((p, &c), wi)| wi * f64::from(dot(p, &centroids[c]))).sum();
        let mut mass = vec![0.0; centroids.len()];
        for (i, &c) in assignment.iter().enumerate() {
            mass[c] += w[i];
        }
        // Drop clusters that ended up empty and re-index.
        let keep: Vec<usize> = (0..centroids.len()).filter(|c| mass[*c] > 0.0).collect();
        let remap: HashMap<usize, usize> = keep.iter().enumerate().map(|(new, old)| (*old, new)).collect();
        let clustering = Clustering {
            assignment: assignment.iter().map(|c| remap.get(c).copied().unwrap_or(0)).collect(),
            centroids: keep.iter().map(|c| centroids[*c].clone()).collect(),
            mass: keep.iter().map(|c| mass[*c]).collect(),
        };
        if best.as_ref().is_none_or(|(o, _)| objective > *o + 1e-9) {
            best = Some((objective, clustering));
        }
    }
    best.map(|(_, c)| c)
}

/// Splits `total` slots in proportion to `mass` (largest remainder), giving every cluster with
/// any mass at least one slot when there are enough slots to go round.
pub fn proportional_quotas(mass: &[f64], total: usize) -> Vec<usize> {
    let sum: f64 = mass.iter().filter(|m| **m > 0.0).sum();
    if sum <= 0.0 || mass.is_empty() {
        return vec![0; mass.len()];
    }
    let exact: Vec<f64> = mass.iter().map(|m| m.max(0.0) / sum * total as f64).collect();
    let mut q: Vec<usize> = exact.iter().map(|x| x.floor() as usize).collect();
    let mut order: Vec<usize> = (0..mass.len()).collect();
    order.sort_by(|a, b| (exact[*b] - exact[*b].floor()).partial_cmp(&(exact[*a] - exact[*a].floor())).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(b)));
    let mut left = total - q.iter().sum::<usize>();
    for &i in order.iter().cycle().take(mass.len() * 2) {
        if left == 0 {
            break;
        }
        if mass[i] > 0.0 {
            q[i] += 1;
            left -= 1;
        }
    }
    // Minimum one slot each: borrow from the largest cluster.
    if total >= mass.iter().filter(|m| **m > 0.0).count() {
        for i in 0..q.len() {
            if mass[i] > 0.0 && q[i] == 0 {
                if let Some(donor) = (0..q.len()).filter(|d| q[*d] > 1).max_by_key(|d| q[*d]) {
                    q[donor] -= 1;
                    q[i] += 1;
                }
            }
        }
    }
    q
}

/// Merges per-cluster lists so each cluster appears at an even rate in proportion to its length
/// (7/7/6 → A B C A B C …; 12/6/2 → A B A A B A …), never ending with a run of one cluster
/// while others still have items.
pub fn interleave_proportionally<T>(lists: Vec<Vec<T>>) -> Vec<T> {
    let lens: Vec<usize> = lists.iter().map(Vec::len).collect();
    let total: usize = lens.iter().sum();
    let mut iters: Vec<std::vec::IntoIter<T>> = lists.into_iter().map(Vec::into_iter).collect();
    let mut taken = vec![0usize; iters.len()];
    let mut out = Vec::with_capacity(total);
    for t in 0..total {
        let pick = (0..iters.len())
            .filter(|c| taken[*c] < lens[*c])
            .max_by(|a, b| {
                let deficit = |c: usize| lens[c] as f64 * (t + 1) as f64 / total as f64 - taken[c] as f64;
                deficit(*a).partial_cmp(&deficit(*b)).unwrap_or(std::cmp::Ordering::Equal).then(b.cmp(a))
            });
        let Some(c) = pick else { break };
        if let Some(item) = iters[c].next() {
            out.push(item);
        }
        taken[c] += 1;
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Public response types
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedItem {
    pub tmdb_id: i64,
    pub media_type: String,
    pub title: String,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub release_year: Option<i64>,
    pub vote_average: Option<f64>,
    pub score: f32,
    pub match_percent: u8,
    /// Title of the closest liked title, for "Because you liked …" micro-copy.
    pub because_of: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationRow {
    pub id: String,
    /// `taste` | `context` | `binge` | `because` | `comfort` | `popular` | `trending`
    pub kind: &'static str,
    pub title: String,
    pub subtitle: Option<String>,
    pub items: Vec<RecommendedItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationsResponse {
    pub app_profile_id: i64,
    pub model_id: String,
    pub context_bucket: &'static str,
    pub cold_start: bool,
    pub generated_at: String,
    pub rows: Vec<RecommendationRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasteTitle {
    pub tmdb_id: i64,
    pub media_type: String,
    pub title: Option<String>,
    pub affinity: Affinity,
    pub dominant_bucket: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasteSummary {
    pub app_profile_id: i64,
    pub titles: Vec<TasteTitle>,
    /// Share of positive affinity watched in each time-of-day bucket.
    pub bucket_weights: Vec<(&'static str, f64)>,
}

// ---------------------------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------------------------

pub struct Recommender {
    pub embeddings: EmbeddingService,
    results: Mutex<HashMap<i64, (Instant, Arc<RecommendationsResponse>)>>,
    run_lock: tokio::sync::Mutex<()>,
    /// (tmdb_id, media_type, region) -> provider ids with flatrate/free/ads availability.
    providers: Mutex<HashMap<(i64, String, String), (Instant, Vec<i64>)>>,
    /// "More Like This" results per (tmdb_id, media_type, kids); content-only, not per profile.
    similar: Mutex<SimilarCache>,
}

impl Recommender {
    pub fn new(embeddings: EmbeddingService) -> Self {
        Self {
            embeddings,
            results: Mutex::new(HashMap::new()),
            run_lock: tokio::sync::Mutex::new(()),
            providers: Mutex::new(HashMap::new()),
            similar: Mutex::new(HashMap::new()),
        }
    }

    /// Drops cached rows for a profile (e.g. after new telemetry or a history import).
    pub fn invalidate(&self, app_profile_id: i64) {
        self.results.lock().unwrap_or_else(|p| p.into_inner()).remove(&app_profile_id);
    }
}

// ---------------------------------------------------------------------------------------------
// Data loading (profile-scoped)
// ---------------------------------------------------------------------------------------------

struct Snapshot {
    history: Vec<WatchHistoryEntry>,
    events: Vec<PlaybackEvent>,
    watchlist: Vec<WatchlistItem>,
    favorites: Vec<WatchlistItem>,
    catalog: HashMap<TitleKey, MediaCatalogEntry>,
    region: String,
    subscriptions_only: bool,
    kids: bool,
    providers: Vec<i64>,
    stored_model_id: Option<String>,
}

fn load_snapshot(c: &rusqlite::Connection, app_profile_id: i64) -> rusqlite::Result<Option<Snapshot>> {
    let Some(profile) = queries::get_profile(c, app_profile_id)? else {
        return Ok(None);
    };
    let settings = queries::get_all_settings(c)?;
    let region = settings.get(queries::keys::REGION_CODE).cloned().unwrap_or_else(|| "US".into());
    let providers = queries::list_subscribed_providers(c, &region, true)?
        .into_iter()
        .map(|p| p.provider_id)
        .collect();
    let catalog = queries::list_interacted_media(c, app_profile_id)?
        .into_iter()
        .map(|m| ((m.tmdb_id, m.media_type.clone()), m))
        .collect();
    let kids_profile = profile.is_kids_profile;
    Ok(Some(Snapshot {
        kids: kids_profile || settings.get(queries::keys::KIDS_SAFE_MODE).map(String::as_str) == Some("true"),
        history: queries::list_history(c, app_profile_id, 1_000_000, 0)?,
        events: queries::list_playback_events(c, app_profile_id, None, 100_000)?,
        watchlist: queries::list_watchlist(c, app_profile_id)?,
        favorites: queries::list_favorites(c, app_profile_id)?,
        subscriptions_only: settings.get(queries::keys::SUBSCRIPTIONS_ONLY).map(String::as_str) == Some("true"),
        stored_model_id: settings.get(queries::keys::EMBEDDING_MODEL_ID).cloned(),
        catalog,
        region,
        providers,
    }))
}

// ---------------------------------------------------------------------------------------------
// TMDB candidate generation & enrichment
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Candidate {
    entry: MediaCatalogEntry,
    popularity: f64,
    /// Came from a provider-filtered discover query.
    provider_verified: bool,
}

fn is_rich(m: &MediaCatalogEntry) -> bool {
    matches!(&m.keywords, Some(v) if !v.is_null()) && matches!(&m.credits, Some(v) if !v.is_null())
}

fn entry_from_list_item(v: &Value, media_type: &str) -> Option<(MediaCatalogEntry, f64)> {
    if v["adult"].as_bool() == Some(true) {
        return None;
    }
    let movie = media_type == "movie";
    let title = v[if movie { "title" } else { "name" }].as_str()?.to_string();
    let date = v[if movie { "release_date" } else { "first_air_date" }].as_str().unwrap_or_default();
    Some((
        MediaCatalogEntry {
            tmdb_id: v["id"].as_i64()?,
            media_type: media_type.to_string(),
            title,
            original_title: v[if movie { "original_title" } else { "original_name" }].as_str().map(str::to_string),
            overview: v["overview"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
            poster_path: v["poster_path"].as_str().map(str::to_string),
            backdrop_path: v["backdrop_path"].as_str().map(str::to_string),
            release_year: date.get(0..4).and_then(|y| y.parse().ok()),
            runtime_mins: None,
            genres: Some(json!({ "ids": v["genre_ids"].clone() })),
            keywords: None,
            credits: None,
            vote_average: v["vote_average"].as_f64(),
            certification: None,
            updated_at: None,
        },
        v["popularity"].as_f64().unwrap_or(0.0),
    ))
}

/// Full metadata for the rich document: details + keywords + credits in one request.
async fn fetch_details(tmdb: &TmdbClient, tmdb_id: i64, media_type: &str) -> AppResult<MediaCatalogEntry> {
    let v = tmdb
        .get(&format!("/{media_type}/{tmdb_id}"), &[("append_to_response", "keywords,credits".to_string())])
        .await?;
    let movie = media_type == "movie";
    let names = |arr: &Value| -> Vec<Value> {
        arr.as_array()
            .map(|a| a.iter().filter_map(|x| x["name"].as_str()).map(|s| Value::String(s.to_string())).collect())
            .unwrap_or_default()
    };
    let keywords = if movie { names(&v["keywords"]["keywords"]) } else { names(&v["keywords"]["results"]) };
    let mut cast: Vec<(i64, String)> = v["credits"]["cast"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| Some((p["order"].as_i64().unwrap_or(999), p["name"].as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    cast.sort_by_key(|(o, _)| *o);
    let directors: Vec<Value> = v["credits"]["crew"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|c| c["job"].as_str() == Some("Director"))
                .filter_map(|c| c["name"].as_str())
                .take(3)
                .map(|s| Value::String(s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let mut studios = names(&v["production_companies"]);
    studios.extend(names(&v["networks"]));
    let date = v[if movie { "release_date" } else { "first_air_date" }].as_str().unwrap_or_default();
    let runtime = if movie {
        v["runtime"].as_i64()
    } else {
        v["episode_run_time"].as_array().and_then(|a| a.first()).and_then(Value::as_i64)
    };
    Ok(MediaCatalogEntry {
        tmdb_id,
        media_type: media_type.to_string(),
        title: v[if movie { "title" } else { "name" }].as_str().unwrap_or_default().to_string(),
        original_title: v[if movie { "original_title" } else { "original_name" }].as_str().map(str::to_string),
        overview: v["overview"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        poster_path: v["poster_path"].as_str().map(str::to_string),
        backdrop_path: v["backdrop_path"].as_str().map(str::to_string),
        release_year: date.get(0..4).and_then(|y| y.parse().ok()),
        runtime_mins: runtime.filter(|r| *r > 0),
        genres: Some(v["genres"].clone()),
        keywords: Some(Value::Array(keywords)),
        credits: Some(json!({
            "directors": directors,
            "creators": names(&v["created_by"]),
            "cast": cast.into_iter().take(5).map(|(_, n)| n).collect::<Vec<_>>(),
            "studios": studios.into_iter().take(4).collect::<Vec<_>>(),
        })),
        vote_average: v["vote_average"].as_f64(),
        certification: None,
        updated_at: None,
    })
}

/// Fetches details for every entry lacking rich metadata (bounded), caching them in SQLite.
async fn enrich(
    state: &AppState,
    tmdb: &TmdbClient,
    entries: Vec<MediaCatalogEntry>,
) -> AppResult<HashMap<TitleKey, MediaCatalogEntry>> {
    let mut out = HashMap::new();
    let mut need = Vec::new();
    for e in entries {
        if is_rich(&e) || need.len() >= MAX_DETAIL_FETCHES {
            out.insert((e.tmdb_id, e.media_type.clone()), e);
        } else {
            need.push(e);
        }
    }
    let sem = Arc::new(Semaphore::new(TMDB_CONCURRENCY));
    let mut set = JoinSet::new();
    for e in need {
        let (tmdb, sem) = (tmdb.clone(), sem.clone());
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            let fetched = fetch_details(&tmdb, e.tmdb_id, &e.media_type).await;
            (e, fetched)
        });
    }
    let mut fresh = Vec::new();
    while let Some(joined) = set.join_next().await {
        let (original, fetched) = joined.map_err(|e| AppError::Message(e.to_string()))?;
        match fetched {
            Ok(rich) => {
                out.insert((rich.tmdb_id, rich.media_type.clone()), rich.clone());
                fresh.push(rich);
            }
            Err(e) if e.to_string().contains("API key") => return Err(e),
            Err(_) => {
                out.insert((original.tmdb_id, original.media_type.clone()), original);
            }
        }
    }
    if !fresh.is_empty() {
        let keys: Vec<TitleKey> = fresh.iter().map(|m| (m.tmdb_id, m.media_type.clone())).collect();
        state.db.run(move |c| queries::upsert_media_batch(c, &fresh)).await?;
        state.recommender.embeddings.invalidate(&keys);
    }
    Ok(out)
}

fn discover_params(
    media_type: &str,
    snap: &Snapshot,
    page: u32,
    genre: Option<i64>,
) -> Vec<(&'static str, String)> {
    let mut p = vec![
        ("sort_by", "popularity.desc".to_string()),
        ("include_adult", "false".to_string()),
        ("page", page.to_string()),
        ("watch_region", snap.region.clone()),
        ("vote_count.gte", if media_type == "movie" { "100" } else { "40" }.to_string()),
    ];
    if snap.subscriptions_only && !snap.providers.is_empty() {
        p.push(("with_watch_providers", snap.providers.iter().map(i64::to_string).collect::<Vec<_>>().join("|")));
        p.push(("with_watch_monetization_types", "flatrate|free|ads".to_string()));
    }
    if snap.kids {
        if media_type == "movie" {
            p.push(("certification_country", "US".to_string()));
            p.push(("certification.lte", "PG".to_string()));
            p.push(("without_genres", "27|53|80|10752".to_string()));
        } else {
            p.push(("with_genres", "10762|10751|16".to_string()));
            p.push(("without_genres", "80|10768|9648".to_string()));
        }
    }
    if let Some(g) = genre {
        if !(snap.kids && media_type == "tv") {
            p.push(("with_genres", g.to_string()));
        }
    }
    p
}

fn genre_ids(entry: &MediaCatalogEntry) -> Vec<i64> {
    let Some(g) = &entry.genres else { return Vec::new() };
    let arr = g.as_array().or_else(|| g["ids"].as_array());
    arr.map(|a| {
        a.iter()
            .filter_map(|x| x.as_i64().or_else(|| x["id"].as_i64()))
            .collect()
    })
    .unwrap_or_default()
}

async fn gather_candidates(
    tmdb: &TmdbClient,
    snap: &Snapshot,
    seeds: &[TitleKey],
    top_genres: &[(String, i64)],
    exclude: &HashSet<TitleKey>,
) -> AppResult<Vec<Candidate>> {
    struct Query {
        path: String,
        params: Vec<(&'static str, String)>,
        media_type: Option<&'static str>,
        verified: bool,
    }
    let filtered = snap.subscriptions_only && !snap.providers.is_empty();
    let mut plan = Vec::new();
    for mt in ["movie", "tv"] {
        for page in 1..=2 {
            plan.push(Query { path: format!("/discover/{mt}"), params: discover_params(mt, snap, page, None), media_type: Some(mt), verified: true });
        }
    }
    for (mt, g) in top_genres {
        let mt: &'static str = if mt == "tv" { "tv" } else { "movie" };
        plan.push(Query { path: format!("/discover/{mt}"), params: discover_params(mt, snap, 1, Some(*g)), media_type: Some(mt), verified: true });
    }
    if !snap.kids {
        for mt in ["movie", "tv"] {
            plan.push(Query { path: format!("/trending/{mt}/week"), params: vec![], media_type: Some(mt), verified: !filtered });
        }
        for (id, mt) in seeds.iter().take(6) {
            let mt: &'static str = if mt == "tv" { "tv" } else { "movie" };
            plan.push(Query { path: format!("/{mt}/{id}/recommendations"), params: vec![], media_type: Some(mt), verified: !filtered });
        }
    }

    let sem = Arc::new(Semaphore::new(TMDB_CONCURRENCY));
    let mut set = JoinSet::new();
    for (order, q) in plan.into_iter().enumerate() {
        let (tmdb, sem) = (tmdb.clone(), sem.clone());
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            let res = tmdb.get(&q.path, &q.params).await;
            (order, q.media_type, q.verified, res)
        });
    }
    let mut batches = Vec::new();
    while let Some(joined) = set.join_next().await {
        let (order, mt, verified, res) = joined.map_err(|e| AppError::Message(e.to_string()))?;
        match res {
            Ok(body) => batches.push((order, mt, verified, body)),
            Err(e) if e.to_string().contains("API key") => return Err(e),
            Err(e) => log::debug!("candidate query failed: {e}"),
        }
    }
    batches.sort_by_key(|(order, ..)| *order);

    let mut seen: HashMap<TitleKey, usize> = HashMap::new();
    let mut out: Vec<Candidate> = Vec::new();
    for (_, mt, verified, body) in batches {
        for item in body["results"].as_array().map(Vec::as_slice).unwrap_or_default() {
            let media_type = mt.or_else(|| item["media_type"].as_str().filter(|t| *t == "movie" || *t == "tv").map(|t| if t == "tv" { "tv" } else { "movie" }));
            let Some(media_type) = media_type else { continue };
            let Some((entry, popularity)) = entry_from_list_item(item, media_type) else { continue };
            let key = (entry.tmdb_id, entry.media_type.clone());
            if exclude.contains(&key) {
                continue;
            }
            match seen.get(&key) {
                Some(&idx) => out[idx].provider_verified |= verified,
                None if out.len() < MAX_CANDIDATES => {
                    seen.insert(key, out.len());
                    out.push(Candidate { entry, popularity, provider_verified: verified });
                }
                None => {}
            }
        }
    }
    Ok(out)
}

/// Checks a title's flatrate/free/ads availability on the subscribed providers (cached 24h).
async fn available_on_subscriptions(state: &AppState, tmdb: &TmdbClient, key: &TitleKey, snap: &Snapshot) -> bool {
    let cache_key = (key.0, key.1.clone(), snap.region.clone());
    let cached = {
        let cache = state.recommender.providers.lock().unwrap_or_else(|p| p.into_inner());
        cache
            .get(&cache_key)
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(86_400))
            .map(|(_, ids)| ids.clone())
    };
    let ids = match cached {
        Some(ids) => ids,
        None => {
            let Ok(body) = tmdb.get(&format!("/{}/{}/watch/providers", key.1, key.0), &[]).await else {
                return false;
            };
            let region = &body["results"][snap.region.as_str()];
            let ids: Vec<i64> = ["flatrate", "free", "ads"]
                .iter()
                .flat_map(|k| region[*k].as_array().cloned().unwrap_or_default())
                .filter_map(|p| p["provider_id"].as_i64())
                .collect();
            state
                .recommender
                .providers
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(cache_key, (Instant::now(), ids.clone()));
            ids
        }
    };
    ids.iter().any(|id| snap.providers.contains(id))
}

// ---------------------------------------------------------------------------------------------
// 5. Ranking & rows
// ---------------------------------------------------------------------------------------------

fn match_percent(sim: f32) -> u8 {
    (50.0 + 50.0 * sim).clamp(1.0, 99.0).round() as u8
}

fn title_case(s: &str) -> String {
    s.split(' ')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// "Atmospheric Science Fiction" — the strongest mood + genre across liked titles.
fn taste_label(docs: &[(&MediaDocument, f64)]) -> Option<String> {
    let mut genres: HashMap<String, f64> = HashMap::new();
    let mut moods: HashMap<String, f64> = HashMap::new();
    for (doc, w) in docs {
        for g in &doc.genres {
            *genres.entry(g.clone()).or_default() += w;
        }
        for m in &doc.moods {
            *moods.entry(m.clone()).or_default() += w;
        }
    }
    let top = |m: HashMap<String, f64>| m.into_iter().max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)).map(|(k, _)| k);
    let genre = top(genres)?;
    Some(match top(moods) {
        Some(mood) => format!("{} {}", title_case(&mood), genre),
        None => genre,
    })
}

/// Largest relevance penalty for a dark title in a clearly light row (cosine sims are ~0.2-0.8,
/// so this sinks a clash well below on-tone picks without removing it outright).
const TONE_CLASH_PENALTY: f32 = 0.45;
/// Gentler penalty the other way round (a cartoon in a gritty-crime row).
const TONE_CLASH_PENALTY_REVERSE: f32 = 0.15;

/// Relevance penalty for a candidate whose tone conflicts with the row's intent. Proportional
/// rather than a genre filter: a dark comedy in a comedy row is docked less than a serial-killer
/// thriller, and nothing is excluded outright.
pub fn tone_penalty(intent: Tone, candidate: Tone) -> f32 {
    let intent_total = intent.light + intent.dark;
    let cand_total = candidate.light + candidate.dark;
    if intent_total < 0.5 || cand_total <= 0.0 {
        return 0.0;
    }
    // -1 = entirely dark row, +1 = entirely light row.
    let lean = (intent.light - intent.dark) / intent_total;
    // Saturates at two strong signals (e.g. Thriller + "serial killer").
    let strength = |x: f32| (x / 2.0).min(1.0);
    if lean >= 0.3 {
        TONE_CLASH_PENALTY * lean * strength(candidate.dark) * (candidate.dark / cand_total)
    } else if lean <= -0.3 {
        TONE_CLASH_PENALTY_REVERSE * -lean * strength(candidate.light) * (candidate.light / cand_total)
    } else {
        0.0
    }
}

struct Pool {
    keys: Vec<TitleKey>,
    entries: Vec<MediaCatalogEntry>,
    vectors: Vec<Arc<Vec<f32>>>,
    popularity: Vec<f32>,
    tones: Vec<Tone>,
}

impl Pool {
    fn item(&self, i: usize, score: f32, sim: f32, because_of: Option<String>) -> RecommendedItem {
        let e = &self.entries[i];
        RecommendedItem {
            tmdb_id: e.tmdb_id,
            media_type: e.media_type.clone(),
            title: e.title.clone(),
            overview: e.overview.clone(),
            poster_path: e.poster_path.clone(),
            backdrop_path: e.backdrop_path.clone(),
            release_year: e.release_year,
            vote_average: e.vote_average,
            score,
            match_percent: match_percent(sim),
            because_of,
        }
    }

    /// Ranks the pool against `query` with MMR, skipping already-used titles. `intent` is the
    /// row's tone; candidates that clash with it are penalised (see [`tone_penalty`]).
    fn rank(
        &self,
        query: &[f32],
        k: usize,
        used: &mut HashSet<usize>,
        seeds: &[(String, Arc<Vec<f32>>)],
        intent: Option<Tone>,
    ) -> Vec<RecommendedItem> {
        let idx: Vec<usize> = (0..self.keys.len()).filter(|i| !used.contains(i)).collect();
        if idx.is_empty() || k == 0 {
            return Vec::new();
        }
        let Some(query) = normalized(query.to_vec()) else { return Vec::new() };
        // Composite vectors have norm <= 1 (missing blocks count as no match), so the dot with a
        // unit query is the weighted block similarity. Penalised similarity drives both ranking
        // and the displayed match %.
        let sims: Vec<f32> = idx
            .iter()
            .map(|&i| dot(&query, &self.vectors[i]) - intent.map_or(0.0, |t| tone_penalty(t, self.tones[i])))
            .collect();
        let rel: Vec<f32> = idx
            .iter()
            .zip(&sims)
            .map(|(&i, s)| {
                let vote = self.entries[i].vote_average.unwrap_or(6.0) as f32 / 10.0;
                s + 0.04 * vote + 0.02 * self.popularity[i]
            })
            .collect();
        let vecs: Vec<&[f32]> = idx.iter().map(|&i| self.vectors[i].as_slice()).collect();
        mmr(&rel, &vecs, k, MMR_LAMBDA, &[])
            .into_iter()
            .map(|p| {
                let i = idx[p];
                used.insert(i);
                let because = seeds
                    .iter()
                    .map(|(t, v)| (t, dot(&self.vectors[i], v)))
                    .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
                    .filter(|(_, s)| *s >= 0.3)
                    .map(|(t, _)| t.clone());
                self.item(i, rel[p], sims[p], because)
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

/// One side of a profile's taste: its titles (strongest first), unit centroid and total weight.
struct TasteCluster {
    members: Vec<TitleKey>,
    centroid: Vec<f32>,
    mass: f64,
}

/// Clusters the profile's positively weighted titles (`seeds`, strongest first), heaviest
/// cluster first. Seeded by the profile id so the row is stable between refreshes.
fn taste_clusters(
    seeds: &[TitleKey],
    vectors: &HashMap<TitleKey, Arc<Vec<f32>>>,
    affinities: &HashMap<TitleKey, Affinity>,
    app_profile_id: i64,
) -> Vec<TasteCluster> {
    let points: Vec<(&TitleKey, &[f32], f64)> = seeds
        .iter()
        .filter_map(|k| Some((k, vectors.get(k)?.as_slice(), affinities.get(k)?.weight)))
        .filter(|(_, _, w)| *w > 0.0)
        .collect();
    let k = cluster_count(points.len());
    if k == 0 {
        return Vec::new();
    }
    let vecs: Vec<&[f32]> = points.iter().map(|p| p.1).collect();
    let weights: Vec<f64> = points.iter().map(|p| p.2).collect();
    let Some(c) = kmeans(&vecs, &weights, k, app_profile_id as u64) else { return Vec::new() };
    let mut clusters: Vec<TasteCluster> = c
        .centroids
        .into_iter()
        .zip(c.mass)
        .map(|(centroid, mass)| TasteCluster { members: Vec::new(), centroid, mass })
        .collect();
    for (p, &ci) in points.iter().zip(&c.assignment) {
        clusters[ci].members.push(p.0.clone());
    }
    clusters.sort_by(|a, b| b.mass.partial_cmp(&a.mass).unwrap_or(std::cmp::Ordering::Equal));
    clusters
}

/// Titles in the "We Think You'll Love These" row.
const LOVE_ROW_SIZE: usize = 20;

/// The aggregate taste row: a nearest-neighbour search around every cluster centroid (minus the
/// dislike centroid), each with the tone of its own titles, sized by cluster mass and
/// interleaved. Slots a cluster can't fill go to the others.
#[allow(clippy::too_many_arguments)]
fn cluster_row(
    clusters: &[TasteCluster],
    pool: &Pool,
    used: &mut HashSet<usize>,
    docs: &HashMap<TitleKey, MediaDocument>,
    vectors: &HashMap<TitleKey, Arc<Vec<f32>>>,
    affinities: &HashMap<TitleKey, Affinity>,
    taste: &TasteProfile,
    title_of: &dyn Fn(&TitleKey) -> Option<String>,
) -> Option<RecommendationRow> {
    if clusters.is_empty() {
        return None;
    }
    let mass: Vec<f64> = clusters.iter().map(|c| c.mass).collect();
    let quotas = proportional_quotas(&mass, LOVE_ROW_SIZE);
    struct Side {
        query: Vec<f32>,
        tone: Option<Tone>,
        seeds: Vec<(String, Arc<Vec<f32>>)>,
        label: Option<String>,
    }
    let sides: Vec<Side> = clusters
        .iter()
        .map(|c| {
            let mut query = c.centroid.clone();
            if let Some(neg) = &taste.negative {
                query.iter_mut().zip(neg).for_each(|(x, y)| *x -= NEGATIVE_PUSH * y);
            }
            let member_docs: Vec<(&MediaDocument, f64)> =
                c.members.iter().filter_map(|k| Some((docs.get(k)?, affinities.get(k)?.weight))).collect();
            Side {
                query,
                tone: Tone::blend(member_docs.iter().map(|(d, w)| (d.tone(), *w))),
                seeds: c.members.iter().take(8).filter_map(|k| Some((title_of(k)?, vectors.get(k)?.clone()))).collect(),
                label: taste_label(&member_docs),
            }
        })
        .collect();

    let mut lists: Vec<Vec<RecommendedItem>> =
        sides.iter().zip(&quotas).map(|(s, q)| pool.rank(&s.query, *q, used, &s.seeds, s.tone)).collect();
    // Top up from the heaviest clusters if a side ran out of neighbours.
    for (i, side) in sides.iter().enumerate() {
        let short = LOVE_ROW_SIZE.saturating_sub(lists.iter().map(Vec::len).sum());
        if short == 0 {
            break;
        }
        let extra = pool.rank(&side.query, short, used, &side.seeds, side.tone);
        lists[i].extend(extra);
    }
    let items = interleave_proportionally(lists);
    if items.is_empty() {
        return None;
    }

    let mut labels: Vec<String> = Vec::new();
    for l in sides.iter().filter_map(|s| s.label.clone()) {
        if !labels.contains(&l) {
            labels.push(l);
        }
    }
    let (title, subtitle) = if clusters.len() == 1 {
        (format!("{} matching your taste profile", labels.first().map_or("Top picks", String::as_str)), None)
    } else {
        (
            "Picks from every side of your taste".to_string(),
            Some(format!("Blending {} sides of your taste: {}", clusters.len(), labels.join(" · "))),
        )
    };
    Some(RecommendationRow { id: "taste".into(), kind: "taste", title, subtitle, items })
}

/// Composite vectors for `docs`: stored vectors whose content hash still matches are read back
/// from `title_vectors`; the rest are embedded (memory-cached) and written back. Content only.
async fn content_vectors(
    state: &AppState,
    embedder: &Arc<Embedder>,
    docs: &HashMap<TitleKey, MediaDocument>,
) -> AppResult<HashMap<TitleKey, Arc<Vec<f32>>>> {
    let model = embedder.model_id();
    let hashes: HashMap<TitleKey, String> = docs.iter().map(|(k, d)| (k.clone(), d.content_hash())).collect();
    let keys: Vec<TitleKey> = docs.keys().cloned().collect();
    let stored = state.db.run(move |c| queries::get_title_vectors(c, model, &keys)).await?;
    let mut out = HashMap::with_capacity(docs.len());
    let mut missing = Vec::new();
    for (k, d) in docs {
        match stored.get(k) {
            Some((hash, v)) if Some(hash) == hashes.get(k) && !v.is_empty() => {
                out.insert(k.clone(), Arc::new(v.clone()));
            }
            _ => missing.push((k.clone(), d.clone())),
        }
    }
    if missing.is_empty() {
        return Ok(out);
    }
    // A stale stored hash means the metadata changed: drop any in-memory copy too.
    let missing_keys: Vec<TitleKey> = missing.iter().map(|(k, _)| k.clone()).collect();
    state.recommender.embeddings.invalidate(&missing_keys);
    let fresh = state.recommender.embeddings.embed_keyed(embedder.clone(), missing).await?;
    let rows: Vec<(i64, String, String, Vec<f32>)> = fresh
        .iter()
        .filter_map(|(k, v)| Some((k.0, k.1.clone(), hashes.get(k)?.clone(), v.as_ref().clone())))
        .collect();
    state.db.run(move |c| queries::upsert_title_vectors(c, model, &rows)).await?;
    out.extend(fresh);
    Ok(out)
}

async fn sync_model_id(state: &AppState, stored: Option<String>, current: &'static str) -> AppResult<()> {
    if stored.as_deref() == Some(current) {
        return Ok(());
    }
    state
        .db
        .run(move |c| {
            let removed = queries::clear_all_embeddings(c)?;
            queries::prune_title_vectors(c, current)?;
            queries::set_setting(c, queries::keys::EMBEDDING_MODEL_ID, current)?;
            Ok(removed)
        })
        .await
        .map(|removed| {
            if removed > 0 {
                log::info!("embedding model changed to {current}; cleared {removed} stale vectors");
            }
        })
}

pub async fn generate(app: &AppHandle, app_profile_id: i64, force: bool) -> AppResult<RecommendationsResponse> {
    let state = app.state::<AppState>();
    let rec = &state.recommender;
    if !force {
        let cached = rec
            .results
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&app_profile_id)
            .filter(|(at, _)| at.elapsed() < RESULT_TTL)
            .map(|(_, r)| r.clone());
        if let Some(r) = cached {
            return Ok((*r).clone());
        }
    }
    let _run = rec.run_lock.lock().await;

    let snap = state
        .db
        .run(move |c| load_snapshot(c, app_profile_id))
        .await?
        .ok_or_else(|| AppError::Message(format!("profile {app_profile_id} not found")))?;
    let now = Utc::now();
    let context = bucket_for_hour(Local::now().hour());

    // 1-2. Signals & affinities.
    let mut signals = collect_signals(&snap.history, &snap.events, &snap.watchlist);
    apply_favorites(&mut signals, &snap.favorites);
    let affinities: HashMap<TitleKey, Affinity> = signals.iter().map(|(k, s)| (k.clone(), compute_affinity(s, now))).collect();

    // Embedding backend (and invalidate stored vectors if the model changed).
    let embedder = rec.embeddings.get().await;
    sync_model_id(&state, snap.stored_model_id.clone(), embedder.model_id()).await?;
    let tmdb = TmdbClient::from_settings(&state).await?;

    // Rich metadata for the profile's titles.
    let interacted: Vec<MediaCatalogEntry> = signals
        .keys()
        .filter_map(|k| snap.catalog.get(k).cloned())
        .collect();
    let interacted = enrich(&state, &tmdb, interacted).await?;

    // Seeds = strongest positive titles.
    let mut ranked_titles: Vec<(&TitleKey, &Affinity)> = affinities.iter().filter(|(k, _)| interacted.contains_key(*k)).collect();
    ranked_titles.sort_by(|a, b| b.1.weight.partial_cmp(&a.1.weight).unwrap_or(std::cmp::Ordering::Equal));
    let seeds: Vec<TitleKey> = ranked_titles.iter().filter(|(_, a)| a.weight > 0.0).map(|(k, _)| (*k).clone()).collect();

    // Genre targets weighted by affinity.
    let mut genre_mass: HashMap<(String, i64), f64> = HashMap::new();
    for key in &seeds {
        if let (Some(entry), Some(a)) = (interacted.get(key), affinities.get(key)) {
            for g in genre_ids(entry) {
                *genre_mass.entry((key.1.clone(), g)).or_default() += a.weight;
            }
        }
    }
    let mut top_genres: Vec<((String, i64), f64)> = genre_mass.into_iter().collect();
    top_genres.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top_genres: Vec<(String, i64)> = top_genres.into_iter().take(3).map(|(k, _)| k).collect();

    // Composite vectors for the profile's own titles, then the taste clusters (3b).
    let interacted_docs: HashMap<TitleKey, MediaDocument> =
        interacted.iter().map(|(k, e)| (k.clone(), MediaDocument::from_catalog(e))).collect();
    let mut vectors = content_vectors(&state, &embedder, &interacted_docs).await?;
    let clusters = taste_clusters(&seeds, &vectors, &affinities, app_profile_id);

    // 4. Candidates (excluding everything this profile already touched), seeded from the
    //    strongest titles of every cluster so each side of the taste brings its own neighbours.
    let exclude: HashSet<TitleKey> = signals.keys().cloned().collect();
    let candidate_seeds: Vec<TitleKey> = if clusters.is_empty() {
        seeds.iter().take(4).cloned().collect()
    } else {
        let per = if clusters.len() == 1 { 4 } else { 2 };
        clusters.iter().flat_map(|c| c.members.iter().take(per).cloned()).collect()
    };
    let candidates = gather_candidates(&tmdb, &snap, &candidate_seeds, &top_genres, &exclude).await?;
    let popularity_max = candidates.iter().map(|c| c.popularity).fold(1.0, f64::max);
    let verified: HashMap<TitleKey, bool> = candidates.iter().map(|c| ((c.entry.tmdb_id, c.entry.media_type.clone()), c.provider_verified)).collect();
    let popularity: HashMap<TitleKey, f64> = candidates.iter().map(|c| ((c.entry.tmdb_id, c.entry.media_type.clone()), c.popularity / popularity_max)).collect();
    let candidate_entries = enrich(&state, &tmdb, candidates.into_iter().map(|c| c.entry).collect()).await?;

    // Embed the candidates (stored composites are reused).
    let candidate_docs: HashMap<TitleKey, MediaDocument> =
        candidate_entries.iter().map(|(k, e)| (k.clone(), MediaDocument::from_catalog(e))).collect();
    vectors.extend(content_vectors(&state, &embedder, &candidate_docs).await?);
    let mut docs = interacted_docs;
    docs.extend(candidate_docs);

    // Persist this profile's vectors + affinities (profile-scoped table).
    let persist: Vec<(i64, String, Vec<f32>, f64)> = interacted
        .keys()
        .filter_map(|k| Some((k.0, k.1.clone(), vectors.get(k)?.as_ref().clone(), affinities.get(k)?.weight)))
        .collect();
    state.db.run(move |c| queries::upsert_embeddings_batch(c, app_profile_id, &persist)).await?;

    // 3. Taste centroids.
    let taste_items: Vec<(&[f32], f64, [f64; 5])> = interacted
        .keys()
        .filter_map(|k| Some((vectors.get(k)?.as_slice(), affinities.get(k)?.weight, signals.get(k)?.bucket_shares())))
        .collect();
    let taste = TasteProfile::build(&taste_items);

    // Candidate pool.
    let mut pool = Pool { keys: Vec::new(), entries: Vec::new(), vectors: Vec::new(), popularity: Vec::new(), tones: Vec::new() };
    for (k, e) in &candidate_entries {
        if let Some(v) = vectors.get(k) {
            pool.keys.push(k.clone());
            pool.entries.push(e.clone());
            pool.vectors.push(v.clone());
            pool.popularity.push(*popularity.get(k).unwrap_or(&0.0) as f32);
            pool.tones.push(MediaDocument::from_catalog(e).tone());
        }
    }

    // Subscriptions-only: verify unfiltered sources (trending / seed recommendations), best first.
    if snap.subscriptions_only && !snap.providers.is_empty() {
        let query = taste.query(None);
        let mut order: Vec<usize> = (0..pool.keys.len()).filter(|i| !verified.get(&pool.keys[*i]).copied().unwrap_or(false)).collect();
        if let Some(q) = &query {
            order.sort_by(|a, b| cosine(q, &pool.vectors[*b]).partial_cmp(&cosine(q, &pool.vectors[*a])).unwrap_or(std::cmp::Ordering::Equal));
        }
        let mut drop: HashSet<usize> = order.iter().skip(MAX_PROVIDER_CHECKS).copied().collect();
        for &i in order.iter().take(MAX_PROVIDER_CHECKS) {
            if !available_on_subscriptions(&state, &tmdb, &pool.keys[i], &snap).await {
                drop.insert(i);
            }
        }
        let keep: Vec<usize> = (0..pool.keys.len()).filter(|i| !drop.contains(i)).collect();
        pool = Pool {
            keys: keep.iter().map(|&i| pool.keys[i].clone()).collect(),
            entries: keep.iter().map(|&i| pool.entries[i].clone()).collect(),
            vectors: keep.iter().map(|&i| pool.vectors[i].clone()).collect(),
            popularity: keep.iter().map(|&i| pool.popularity[i]).collect(),
            tones: keep.iter().map(|&i| pool.tones[i]).collect(),
        };
    }

    // 5. Rows.
    let title_of = |k: &TitleKey| interacted.get(k).map(|e| e.title.clone());
    let seed_vectors: Vec<(String, Arc<Vec<f32>>)> = seeds
        .iter()
        .take(8)
        .filter_map(|k| Some((title_of(k)?, vectors.get(k)?.clone())))
        .collect();
    let mut rows = Vec::new();
    let mut used: HashSet<usize> = HashSet::new();
    let cold_start = taste.global.is_none();

    if let Some(q_global) = taste.query(None) {
        let liked_docs: Vec<(&MediaDocument, f64)> = seeds
            .iter()
            .filter_map(|k| Some((docs.get(k)?, affinities.get(k)?.weight)))
            .collect();
        // Row tone = what the liked titles feel like (a "Lighthearted Comedy" row stays light).
        let taste_tone = Tone::blend(liked_docs.iter().map(|(d, w)| (d.tone(), *w)));
        let seed_tone = |k: &TitleKey| docs.get(k).map(MediaDocument::tone);

        // "We Think You'll Love These": one nearest-neighbour search per taste cluster, each
        // with its own tone and dislike push, interleaved in proportion to cluster mass.
        if let Some(row) = cluster_row(&clusters, &pool, &mut used, &docs, &vectors, &affinities, &taste, &title_of) {
            rows.push(row);
        }

        // Time-of-day context row.
        if taste.bucket_weight(context) >= 0.15 {
            if let Some(q_ctx) = taste.query(Some(context)) {
                let items = pool.rank(&q_ctx, 15, &mut used, &seed_vectors, taste_tone);
                if !items.is_empty() {
                    rows.push(RecommendationRow {
                        id: format!("context-{}", BUCKETS[context].to_lowercase()),
                        kind: "context",
                        title: bucket_row_title(context).into(),
                        subtitle: Some(format!("Tuned to what you watch {}", bucket_phrase(context))),
                        items,
                    });
                }
            }
        }

        // Binge row.
        let binge_seed = seeds.iter().find(|k| signals.get(*k).is_some_and(|s| s.binge));
        if let Some(seed) = binge_seed {
            if let (Some(v), Some(title)) = (vectors.get(seed), title_of(seed)) {
                let mut q = v.as_ref().clone();
                q.iter_mut().zip(&q_global).for_each(|(x, g)| *x = 0.75 * *x + 0.25 * g);
                let items = pool.rank(&q, 15, &mut used, &seed_vectors, seed_tone(seed));
                if !items.is_empty() {
                    let when = signals
                        .get(seed)
                        .and_then(TitleSignals::dominant_bucket)
                        .map(|b| format!(" {}", bucket_phrase(b)))
                        .unwrap_or_default();
                    rows.push(RecommendationRow {
                        id: format!("binge-{}", seed.0),
                        kind: "binge",
                        title: format!("Because you binged {title}{when}"),
                        subtitle: None,
                        items,
                    });
                }
            }
        }

        // "Because you watched" rows for the strongest completed titles.
        for seed in seeds
            .iter()
            .filter(|k| Some(*k) != binge_seed && affinities.get(*k).is_some_and(|a| a.completion > 0.0))
            .take(2)
        {
            if let (Some(v), Some(title)) = (vectors.get(seed), title_of(seed)) {
                let items = pool.rank(v, 15, &mut used, &seed_vectors, seed_tone(seed));
                if items.len() >= 5 {
                    rows.push(RecommendationRow {
                        id: format!("because-{}-{}", seed.1, seed.0),
                        kind: "because",
                        title: format!("Because you watched {title}"),
                        subtitle: None,
                        items,
                    });
                }
            }
        }

        // Comfort Favorites: the profile's own rewatched titles.
        let mut comfort: Vec<(&TitleKey, &Affinity)> = affinities.iter().filter(|(_, a)| a.comfort > 0.0).collect();
        comfort.sort_by(|a, b| b.1.weight.partial_cmp(&a.1.weight).unwrap_or(std::cmp::Ordering::Equal));
        let comfort_items: Vec<RecommendedItem> = comfort
            .iter()
            .filter_map(|(k, a)| {
                let e = interacted.get(*k)?;
                Some(RecommendedItem {
                    tmdb_id: e.tmdb_id,
                    media_type: e.media_type.clone(),
                    title: e.title.clone(),
                    overview: e.overview.clone(),
                    poster_path: e.poster_path.clone(),
                    backdrop_path: e.backdrop_path.clone(),
                    release_year: e.release_year,
                    vote_average: e.vote_average,
                    score: a.weight as f32,
                    match_percent: 99,
                    because_of: None,
                })
            })
            .take(20)
            .collect();
        if !comfort_items.is_empty() {
            rows.push(RecommendationRow {
                id: "comfort".into(),
                kind: "comfort",
                title: "Rediscover your Comfort Favorites".into(),
                subtitle: Some("Titles you keep coming back to".into()),
                items: comfort_items,
            });
        }
    }

    // Cold start (or leftovers): popularity with MMR diversity.
    if cold_start || rows.is_empty() {
        let idx: Vec<usize> = (0..pool.keys.len()).filter(|i| !used.contains(i)).collect();
        let rel: Vec<f32> = idx.iter().map(|&i| pool.popularity[i]).collect();
        let vecs: Vec<&[f32]> = idx.iter().map(|&i| pool.vectors[i].as_slice()).collect();
        let items: Vec<RecommendedItem> = mmr(&rel, &vecs, 20, 0.8, &[])
            .into_iter()
            .map(|p| pool.item(idx[p], rel[p], 0.0, None))
            .collect();
        if !items.is_empty() {
            rows.push(RecommendationRow {
                id: "popular".into(),
                kind: "popular",
                title: if snap.subscriptions_only && !snap.providers.is_empty() {
                    "Popular on your services".into()
                } else {
                    format!("Popular in {}", snap.region)
                },
                subtitle: Some("Watch a few titles and Omnia will tune these rows to your taste".into()),
                items,
            });
        }
    }

    let response = RecommendationsResponse {
        app_profile_id,
        model_id: embedder.model_id().to_string(),
        context_bucket: BUCKETS[context],
        cold_start,
        generated_at: now.to_rfc3339(),
        rows,
    };
    rec.results
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(app_profile_id, (Instant::now(), Arc::new(response.clone())));
    Ok(response)
}

// ---------------------------------------------------------------------------------------------
// "More Like This": single-title nearest neighbours (info page)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarTitles {
    pub tmdb_id: i64,
    pub media_type: String,
    pub model_id: String,
    /// How many titles the search compared against.
    pub searched: usize,
    pub items: Vec<RecommendedItem>,
}

/// Most recently embedded titles searched per request (vectors read straight from SQLite).
const LOCAL_SEARCH_LIMIT: i64 = 2000;
const SIMILAR_TTL: Duration = Duration::from_secs(30 * 60);
const SIMILAR_LIMIT: usize = 20;
/// Similar is about the vibe, not the format, but a film page should lean toward films.
const SAME_TYPE_BONUS: f32 = 0.03;
const SIMILAR_MMR_LAMBDA: f32 = 0.85;
/// Genres a kids profile never gets from this search.
const KIDS_BLOCKED_GENRES: &[&str] = &["horror", "thriller", "crime", "war", "war & politics"];

/// Fetches TMDB list endpoints concurrently, returning their titles in plan order (deduplicated).
async fn fetch_lists(tmdb: &TmdbClient, plan: Vec<ListQuery>) -> AppResult<Vec<MediaCatalogEntry>> {
    let sem = Arc::new(Semaphore::new(TMDB_CONCURRENCY));
    let mut set = JoinSet::new();
    for (order, (path, params, mt)) in plan.into_iter().enumerate() {
        let (tmdb, sem) = (tmdb.clone(), sem.clone());
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            (order, mt, tmdb.get(&path, &params).await)
        });
    }
    let mut bodies = Vec::new();
    while let Some(joined) = set.join_next().await {
        let (order, mt, res) = joined.map_err(|e| AppError::Message(e.to_string()))?;
        match res {
            Ok(body) => bodies.push((order, mt, body)),
            Err(e) if e.to_string().contains("API key") => return Err(e),
            Err(e) => log::debug!("similar-titles query failed: {e}"),
        }
    }
    bodies.sort_by_key(|(order, ..)| *order);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (_, mt, body) in bodies {
        for item in body["results"].as_array().map(Vec::as_slice).unwrap_or_default() {
            if let Some((entry, _)) = entry_from_list_item(item, mt) {
                if seen.insert((entry.tmdb_id, entry.media_type.clone())) {
                    out.push(entry);
                }
            }
        }
    }
    Ok(out)
}

/// Local matches below this composite similarity aren't shown (a small catalog shouldn't pad
/// the row with unrelated titles; TMDB's list follows anyway).
const MIN_LOCAL_SIMILARITY: f32 = 0.15;
/// Local matches plus TMDB's own list, at most.
const SIMILAR_TOTAL: usize = 40;

fn similar_item(e: &MediaCatalogEntry, score: f32, match_percent: u8) -> RecommendedItem {
    RecommendedItem {
        tmdb_id: e.tmdb_id,
        media_type: e.media_type.clone(),
        title: e.title.clone(),
        overview: e.overview.clone(),
        poster_path: e.poster_path.clone(),
        backdrop_path: e.backdrop_path.clone(),
        release_year: e.release_year,
        vote_average: e.vote_average,
        score,
        match_percent,
        because_of: None,
    }
}

/// "More Like This" fast path (well under a second):
/// 1. Local ML matches: nearest neighbours of the title's composite vector, searched ONLY among
///    titles already embedded in `title_vectors` (nothing is embedded on the fly, except the
///    title itself when it has no stored vector yet: one document).
/// 2. Then TMDB's own recommendations / similar titles, appended in their raw TMDB order
///    (no match %), skipping anything already listed.
pub async fn similar_titles(app: &AppHandle, app_profile_id: i64, tmdb_id: i64, media_type: &str) -> AppResult<SimilarTitles> {
    let mt: &'static str = match media_type {
        "movie" => "movie",
        "tv" => "tv",
        other => return Err(AppError::Message(format!("invalid media type '{other}'"))),
    };
    let state = app.state::<AppState>();
    let rec = &state.recommender;
    let embedder = rec.embeddings.get().await;
    let model = embedder.model_id();

    let (kids, seed_entry, embedded) = state
        .db
        .run(move |c| {
            let settings = queries::get_all_settings(c)?;
            let kids = queries::get_profile(c, app_profile_id)?.is_some_and(|p| p.is_kids_profile)
                || settings.get(queries::keys::KIDS_SAFE_MODE).map(String::as_str) == Some("true");
            Ok((kids, queries::get_media(c, tmdb_id, mt)?, queries::list_embedded_media(c, model, LOCAL_SEARCH_LIMIT)?))
        })
        .await?;
    let cache_key = (tmdb_id, mt.to_string(), kids);
    let cached = rec
        .similar
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&cache_key)
        .filter(|(at, _)| at.elapsed() < SIMILAR_TTL)
        .map(|(_, r)| r.clone());
    if let Some(hit) = cached {
        return Ok((*hit).clone());
    }

    let tmdb = TmdbClient::from_settings(&state).await?;
    let seed_key: TitleKey = (tmdb_id, mt.to_string());
    let stored_seed = embedded
        .iter()
        .find(|(e, _)| e.tmdb_id == tmdb_id && e.media_type == mt)
        .map(|(e, v)| (e.clone(), v.clone()));

    // TMDB's list and (only if needed) the seed's metadata, concurrently.
    let plan: Vec<ListQuery> = vec![
        (format!("/{mt}/{tmdb_id}/recommendations"), vec![("page", "1".into())], mt),
        (format!("/{mt}/{tmdb_id}/similar"), vec![("page", "1".into())], mt),
    ];
    let seed_needs_details = stored_seed.is_none() && !seed_entry.as_ref().is_some_and(is_rich);
    let (tmdb_list, fetched_seed) = tokio::join!(fetch_lists(&tmdb, plan), async {
        if seed_needs_details {
            fetch_details(&tmdb, tmdb_id, mt).await.ok()
        } else {
            None
        }
    });
    let tmdb_list = tmdb_list.unwrap_or_default();

    // The seed's composite vector: stored, else embed this one document (and store it).
    let seed_vector: Option<(MediaCatalogEntry, Vec<f32>)> = match stored_seed {
        Some(hit) => Some(hit),
        None => match fetched_seed.or(seed_entry) {
            Some(entry) => {
                if seed_needs_details {
                    let fresh = entry.clone();
                    let _ = state.db.run(move |c| queries::upsert_media(c, &fresh)).await;
                }
                let docs: HashMap<TitleKey, MediaDocument> = HashMap::from([(seed_key.clone(), MediaDocument::from_catalog(&entry))]);
                content_vectors(&state, &embedder, &docs)
                    .await
                    .ok()
                    .and_then(|mut v| v.remove(&seed_key))
                    .map(|v| (entry, v.as_ref().clone()))
            }
            None => None,
        },
    };

    let blocked = |e: &MediaCatalogEntry| {
        kids && MediaDocument::from_catalog(e).genres.iter().any(|g| KIDS_BLOCKED_GENRES.contains(&g.to_lowercase().as_str()))
    };
    let mut items: Vec<RecommendedItem> = Vec::new();
    let mut searched = 0;

    // 1. Local ML matches.
    if let Some((seed, query)) = seed_vector.and_then(|(e, v)| Some((e, normalized(v)?))) {
        let seed_tone = MediaDocument::from_catalog(&seed).tone();
        let pool: Vec<&(MediaCatalogEntry, Vec<f32>)> = embedded
            .iter()
            .filter(|(e, v)| {
                !(e.tmdb_id == tmdb_id && e.media_type == mt) && e.poster_path.is_some() && v.len() == query.len() && !blocked(e)
            })
            .collect();
        searched = pool.len();
        let sims: Vec<f32> = pool
            .iter()
            .map(|(e, v)| dot(&query, v) - tone_penalty(seed_tone, MediaDocument::from_catalog(e).tone()))
            .collect();
        let rel: Vec<f32> = pool
            .iter()
            .zip(&sims)
            .map(|((e, _), s)| {
                s + 0.04 * e.vote_average.unwrap_or(6.0) as f32 / 10.0 + if e.media_type == mt { SAME_TYPE_BONUS } else { 0.0 }
            })
            .collect();
        let mut shortlist: Vec<usize> = (0..pool.len()).filter(|&i| sims[i] >= MIN_LOCAL_SIMILARITY).collect();
        shortlist.sort_by(|a, b| rel[*b].partial_cmp(&rel[*a]).unwrap_or(std::cmp::Ordering::Equal));
        shortlist.truncate(200);
        let short_rel: Vec<f32> = shortlist.iter().map(|&i| rel[i]).collect();
        let short_vecs: Vec<&[f32]> = shortlist.iter().map(|&i| pool[i].1.as_slice()).collect();
        for p in mmr(&short_rel, &short_vecs, SIMILAR_LIMIT, SIMILAR_MMR_LAMBDA, &[]) {
            let i = shortlist[p];
            items.push(similar_item(&pool[i].0, rel[i], match_percent(sims[i])));
        }
    }

    // 2. TMDB's own list, raw order, after the local matches.
    let mut seen: HashSet<TitleKey> = items.iter().map(|it| (it.tmdb_id, it.media_type.clone())).collect();
    seen.insert(seed_key);
    for e in tmdb_list {
        if items.len() >= SIMILAR_TOTAL {
            break;
        }
        if e.poster_path.is_some() && !blocked(&e) && seen.insert((e.tmdb_id, e.media_type.clone())) {
            items.push(similar_item(&e, 0.0, 0));
        }
    }

    let result = SimilarTitles { tmdb_id, media_type: mt.to_string(), model_id: model.to_string(), searched, items };
    rec.similar
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(cache_key, (Instant::now(), Arc::new(result.clone())));
    Ok(result)
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/// "More Like This" for the info page: local composite-vector nearest neighbours of one title.
#[tauri::command]
pub async fn get_similar_titles(app: AppHandle, app_profile_id: i64, tmdb_id: i64, media_type: String) -> AppResult<SimilarTitles> {
    similar_titles(&app, app_profile_id, tmdb_id, &media_type).await
}

#[tauri::command]
pub async fn get_recommendations(app: AppHandle, app_profile_id: i64, force_refresh: Option<bool>) -> AppResult<RecommendationsResponse> {
    generate(&app, app_profile_id, force_refresh.unwrap_or(false)).await
}

/// Explainability: the profile's titles with their affinity breakdowns (no network access).
#[tauri::command]
pub async fn get_taste_summary(state: State<'_, AppState>, app_profile_id: i64, limit: Option<usize>) -> AppResult<TasteSummary> {
    let snap = state
        .db
        .run(move |c| load_snapshot(c, app_profile_id))
        .await?
        .ok_or_else(|| AppError::Message(format!("profile {app_profile_id} not found")))?;
    let now = Utc::now();
    let mut signals = collect_signals(&snap.history, &snap.events, &snap.watchlist);
    apply_favorites(&mut signals, &snap.favorites);
    let mut titles: Vec<TasteTitle> = signals
        .iter()
        .map(|(k, s)| TasteTitle {
            tmdb_id: k.0,
            media_type: k.1.clone(),
            title: snap.catalog.get(k).map(|e| e.title.clone()),
            affinity: compute_affinity(s, now),
            dominant_bucket: s.dominant_bucket().map(|b| BUCKETS[b]),
        })
        .collect();
    titles.sort_by(|a, b| b.affinity.weight.partial_cmp(&a.affinity.weight).unwrap_or(std::cmp::Ordering::Equal));
    titles.truncate(limit.unwrap_or(50));

    let mut mass = [0f64; 5];
    for s in signals.values() {
        let w = compute_affinity(s, now).weight;
        if w > 0.0 {
            for (b, share) in s.bucket_shares().iter().enumerate() {
                mass[b] += w * share;
            }
        }
    }
    let total: f64 = mass.iter().sum();
    Ok(TasteSummary {
        app_profile_id,
        titles,
        bucket_weights: BUCKETS.iter().zip(mass).map(|(b, m)| (*b, if total > 0.0 { m / total } else { 0.0 })).collect(),
    })
}

#[tauri::command]
pub async fn get_embedding_status(state: State<'_, AppState>) -> AppResult<EmbeddingStatus> {
    Ok(state.recommender.embeddings.status())
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn history(tmdb_id: i64, mt: &str, s: i64, e: i64, ratio: f64, at: &str) -> WatchHistoryEntry {
        WatchHistoryEntry {
            id: 0,
            app_profile_id: 1,
            tmdb_id,
            media_type: mt.into(),
            season_number: s,
            episode_number: e,
            episode_title: None,
            provider_name: None,
            direct_url: None,
            progress_seconds: ratio * 3000.0,
            duration_seconds: 3000.0,
            completion_ratio: ratio,
            is_completed: ratio >= 0.95,
            watch_count: 1,
            abandoned: false,
            last_watched_at: at.into(),
            time_of_day_bucket: Some("LateNight".into()),
        }
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 12, 12, 0, 0).unwrap()
    }

    #[test]
    fn binge_detected_from_history_window() {
        let rows = vec![
            history(66732, "tv", 1, 1, 0.97, "2026-11-10 21:00:00"),
            history(66732, "tv", 1, 2, 0.97, "2026-11-10 22:00:00"),
            history(66732, "tv", 1, 3, 0.97, "2026-11-10 23:30:00"),
        ];
        let sig = collect_signals(&rows, &[], &[]);
        let s = &sig[&(66732, "tv".to_string())];
        assert!(s.binge);
        assert_eq!(s.completed_units, 3);
        assert_eq!(s.dominant_bucket(), Some(4));
        let a = compute_affinity(s, now());
        assert_eq!(a.binge_multiplier, BINGE_MULTIPLIER);
        assert!(a.weight > 2.0);
    }

    #[test]
    fn spread_out_episodes_are_not_a_binge() {
        let rows = vec![
            history(1, "tv", 1, 1, 0.97, "2026-11-01 21:00:00"),
            history(1, "tv", 1, 2, 0.97, "2026-11-05 21:00:00"),
            history(1, "tv", 1, 3, 0.97, "2026-11-09 21:00:00"),
        ];
        assert!(!collect_signals(&rows, &[], &[])[&(1, "tv".to_string())].binge);
    }

    #[test]
    fn abandonment_is_negative_and_rewatch_is_comfort() {
        let mut abandoned = history(10, "movie", 0, 0, 0.15, "2026-11-01 20:00:00");
        abandoned.abandoned = true;
        let mut rewatched = history(11, "movie", 0, 0, 1.0, "2026-11-11 20:00:00");
        rewatched.watch_count = 3;
        let sig = collect_signals(&[abandoned, rewatched], &[], &[]);
        let a = compute_affinity(&sig[&(10, "movie".to_string())], now());
        assert!(a.weight < 0.0, "abandoned title must push away: {a:?}");
        assert_eq!(a.abandonment, ABANDONMENT_PENALTY);
        let c = compute_affinity(&sig[&(11, "movie".to_string())], now());
        assert_eq!(c.comfort, COMFORT_BONUS);
        assert!(c.weight > 2.5);
    }

    #[test]
    fn events_feed_signals() {
        let ev = |t: &str, secs: f64| PlaybackEvent {
            id: 0,
            app_profile_id: 1,
            tmdb_id: 5,
            media_type: "tv".into(),
            event_type: t.into(),
            session_watch_duration_sec: secs,
            timestamp: "2026-11-11 22:00:00".into(),
        };
        let rows = vec![history(5, "tv", 1, 1, 0.5, "2026-11-11 22:00:00")];
        let sig = collect_signals(&rows, &[ev("binge_session", 4.0), ev("session_end", 7200.0), ev("seek_forward", 1200.0)], &[]);
        let s = &sig[&(5, "tv".to_string())];
        assert!(s.binge);
        assert_eq!(s.active_seconds, 7200.0);
        let a = compute_affinity(s, now());
        assert_eq!(a.skimming, SKIM_PENALTY);
        assert!(a.engagement > 0.0);
    }

    #[test]
    fn recency_decays_old_activity() {
        let recent = collect_signals(&[history(1, "movie", 0, 0, 1.0, "2026-11-10 20:00:00")], &[], &[]);
        let old = collect_signals(&[history(1, "movie", 0, 0, 1.0, "2025-06-01 20:00:00")], &[], &[]);
        let k = (1, "movie".to_string());
        assert!(compute_affinity(&recent[&k], now()).weight > 2.0 * compute_affinity(&old[&k], now()).weight);
    }

    #[test]
    fn centroid_shifts_with_time_of_day_and_negatives() {
        let scifi = [1.0f32, 0.0, 0.0];
        let sitcom = [0.0f32, 1.0, 0.0];
        let horror = [0.0f32, 0.0, 1.0];
        let mut late = [0.0; 5];
        late[4] = 1.0;
        let mut morning = [0.0; 5];
        morning[0] = 1.0;
        let taste = TasteProfile::build(&[(&scifi, 2.0, morning), (&sitcom, 1.5, late), (&horror, -0.8, late)]);
        let q_late = taste.query(Some(4)).unwrap();
        let q_morning = taste.query(Some(0)).unwrap();
        assert!(cosine(&q_late, &sitcom) > cosine(&q_morning, &sitcom));
        assert!(cosine(&q_morning, &scifi) > cosine(&q_late, &scifi));
        assert!(cosine(&taste.query(None).unwrap(), &horror) < 0.0);
    }

    #[test]
    fn tone_clashes_are_penalised_not_filtered() {
        let doc = |genres: &[&str], moods: &[&str], keywords: &[&str]| MediaDocument {
            title: String::new(),
            overview: String::new(),
            genres: genres.iter().map(|s| s.to_string()).collect(),
            keywords: keywords.iter().map(|s| s.to_string()).collect(),
            directors: vec![],
            cast: vec![],
            studios: vec![],
            moods: moods.iter().map(|s| s.to_string()).collect(),
        };
        let sitcom = doc(&["Comedy"], &["lighthearted", "funny"], &["sitcom", "friendship"]).tone();
        let comedy_row = Tone::blend([(sitcom, 2.0), (doc(&["Comedy", "Romance"], &["funny", "romantic"], &[]).tone(), 1.0)]).unwrap();

        let killer = doc(&["Thriller", "Crime"], &["suspenseful", "gritty", "dark"], &["serial killer", "detective"]).tone();
        let dark_comedy = doc(&["Comedy", "Crime"], &["funny", "gritty"], &["dark comedy"]).tone();
        let whodunit = doc(&["Comedy", "Mystery"], &["funny", "intriguing"], &["murder mystery", "whodunit"]).tone();
        let another_sitcom = doc(&["Comedy"], &["funny"], &["sitcom"]).tone();

        let p_killer = tone_penalty(comedy_row, killer);
        let p_dark_comedy = tone_penalty(comedy_row, dark_comedy);
        let p_whodunit = tone_penalty(comedy_row, whodunit);
        let p_sitcom = tone_penalty(comedy_row, another_sitcom);

        // Heavy for a clear clash (enough to sink a high-similarity title), proportional otherwise.
        assert!(p_killer > 0.3, "killer thriller penalty {p_killer}");
        assert!(p_dark_comedy > 0.0 && p_dark_comedy < p_killer, "dark comedy {p_dark_comedy} vs {p_killer}");
        assert!(p_whodunit < p_dark_comedy, "a whodunit is not a dark title: {p_whodunit}");
        assert_eq!(p_sitcom, 0.0);

        // A dark row barely minds a darker title, and only gently penalises a light one.
        let crime_row = killer;
        assert_eq!(tone_penalty(crime_row, killer), 0.0);
        let p_cartoon = tone_penalty(crime_row, doc(&["Animation", "Family"], &["wholesome", "feel-good"], &[]).tone());
        assert!(p_cartoon > 0.0 && p_cartoon < p_killer);

        // No tone signal, no penalty.
        assert_eq!(tone_penalty(Tone::default(), killer), 0.0);
        assert_eq!(tone_penalty(comedy_row, Tone::default()), 0.0);
    }

    #[test]
    fn cluster_count_grows_with_history() {
        assert_eq!(cluster_count(0), 0);
        assert_eq!(cluster_count(5), 1);
        assert_eq!(cluster_count(10), 1);
        assert_eq!(cluster_count(11), 2);
        assert_eq!(cluster_count(30), 2);
        assert_eq!(cluster_count(31), 3);
        assert_eq!(cluster_count(400), 3);
    }

    /// Three well-separated tastes (sitcoms, bleak sci-fi, anime) around three axes, with noise.
    fn three_tastes() -> (Vec<Vec<f32>>, Vec<usize>) {
        let mut rng = Rng::new(7);
        let mut points = Vec::new();
        let mut truth = Vec::new();
        for (axis, n) in [(0usize, 14usize), (1, 12), (2, 9)] {
            for _ in 0..n {
                let mut v: Vec<f32> = (0..6).map(|_| (rng.next_f64() as f32 - 0.5) * 0.3).collect();
                v[axis] += 1.0;
                points.push(v);
                truth.push(axis);
            }
        }
        (points, truth)
    }

    #[test]
    fn kmeans_finds_separate_tastes_instead_of_a_smoothie() {
        let (points, truth) = three_tastes();
        let refs: Vec<&[f32]> = points.iter().map(Vec::as_slice).collect();
        let weights = vec![1.0; points.len()];
        let c = kmeans(&refs, &weights, cluster_count(points.len()), 42).unwrap();
        assert_eq!(c.centroids.len(), 3);
        // Every true group lands in exactly one cluster.
        for axis in 0..3 {
            let labels: HashSet<usize> = truth.iter().zip(&c.assignment).filter(|(t, _)| **t == axis).map(|(_, a)| *a).collect();
            assert_eq!(labels.len(), 1, "taste {axis} was split: {labels:?}");
        }
        // Each centroid points at its own taste; the plain average points at none of them.
        for centroid in &c.centroids {
            assert!(centroid.iter().take(3).cloned().fold(f32::MIN, f32::max) > 0.9);
        }
        let mut mean = Vec::new();
        for p in &refs {
            add_scaled(&mut mean, p, 1.0);
        }
        let mean = normalized(mean).unwrap();
        assert!(mean.iter().take(3).cloned().fold(f32::MIN, f32::max) < 0.75, "the smoothie: {mean:?}");
        // Deterministic for a given seed.
        assert_eq!(kmeans(&refs, &weights, 3, 42).unwrap().assignment, c.assignment);
    }

    #[test]
    fn kmeans_weights_pull_centroids() {
        let a = [1.0f32, 0.0];
        let b = [0.0f32, 1.0];
        let c = kmeans(&[&a, &b], &[5.0, 1.0], 1, 1).unwrap();
        assert_eq!(c.centroids.len(), 1);
        assert!(c.centroids[0][0] > c.centroids[0][1] * 4.0);
        assert_eq!(c.mass, vec![6.0]);
    }

    #[test]
    fn quotas_are_proportional_and_complete() {
        assert_eq!(proportional_quotas(&[1.0, 1.0, 1.0], 20), vec![7, 7, 6]);
        assert_eq!(proportional_quotas(&[6.0, 3.0, 1.0], 20), vec![12, 6, 2]);
        assert_eq!(proportional_quotas(&[1.0], 20), vec![20]);
        // A tiny side still gets a slot.
        let q = proportional_quotas(&[100.0, 0.4], 20);
        assert_eq!(q.iter().sum::<usize>(), 20);
        assert_eq!(q[1], 1);
    }

    #[test]
    fn interleaving_follows_the_quotas() {
        let lists = vec![vec!['A'; 7], vec!['B'; 7], vec!['C'; 6]];
        let out: String = interleave_proportionally(lists).into_iter().collect();
        assert_eq!(out.len(), 20);
        assert!(out.starts_with("ABCABC"), "{out}");
        assert_eq!(out.matches('A').count(), 7);
        assert_eq!(out.matches('C').count(), 6);
        // Uneven: no long run of the big side at the end.
        let out: String = interleave_proportionally(vec![vec!['A'; 12], vec!['B'; 6], vec!['C'; 2]]).into_iter().collect();
        assert!(!out.contains("AAA"), "{out}");
        assert!(!out.ends_with("AA"), "{out}");
    }

    #[test]
    fn mmr_trades_relevance_for_diversity() {
        let a = [1.0f32, 0.0];
        let a2 = [0.99f32, 0.14];
        let b = [0.0f32, 1.0];
        let vecs: Vec<&[f32]> = vec![&a, &a2, &b];
        let rel = [0.9, 0.89, 0.6];
        assert_eq!(mmr(&rel, &vecs, 2, 1.0, &[]), vec![0, 1]);
        assert_eq!(mmr(&rel, &vecs, 2, 0.5, &[]), vec![0, 2]);
    }

    #[test]
    fn snapshot_is_isolated_per_profile() {
        let mut c = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::configure(&c).unwrap();
        crate::db::migrate(&mut c).unwrap();
        queries::ensure_default_profile(&c).unwrap();
        let mom = queries::create_profile(&c, "Mom", None, false).unwrap();
        let upd = |profile: i64, tmdb: i64| queries::ProgressUpdate {
            app_profile_id: profile,
            tmdb_id: tmdb,
            media_type: "movie".into(),
            season_number: 0,
            episode_number: 0,
            episode_title: None,
            provider_name: None,
            direct_url: None,
            progress_seconds: 3000.0,
            duration_seconds: 6000.0,
        };
        queries::record_progress(&c, &upd(1, 100)).unwrap();
        queries::record_progress(&c, &upd(mom.profile_id, 200)).unwrap();
        queries::insert_playback_event(&c, mom.profile_id, 200, "movie", "binge_session", 3.0).unwrap();
        queries::add_to_watchlist(&c, mom.profile_id, 300, "movie").unwrap();

        let mine = load_snapshot(&c, 1).unwrap().unwrap();
        let sig = collect_signals(&mine.history, &mine.events, &mine.watchlist);
        assert_eq!(sig.keys().cloned().collect::<Vec<_>>(), vec![(100, "movie".to_string())]);
        let theirs = load_snapshot(&c, mom.profile_id).unwrap().unwrap();
        let sig = collect_signals(&theirs.history, &theirs.events, &theirs.watchlist);
        assert_eq!(sig.len(), 2);
        assert!(sig[&(200, "movie".to_string())].binge);
    }
}

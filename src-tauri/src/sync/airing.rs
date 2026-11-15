//! Airing-show auto-return.
//!
//! When you're caught up on a series that is still airing, it eventually drops off Continue
//! Watching (Up Next only lasts 30 days, and imported history is silent). On Home load the
//! catalog asks Rust to check those series on TMDB: if the episode right after the furthest one
//! you finished has aired since you last watched, the series is recorded in `airing_checks` and
//! `continue_watching` brings it back with a "New Episode" card.
//!
//! Privacy: only TMDB series ids are sent (to TMDB, the catalog source); nothing about the
//! profile or its history leaves the machine. Each series is re-checked at most every 12 hours.

use std::sync::Arc;

use chrono::Local;
use serde_json::Value;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::db::queries::{self, AiringCandidate, NewEpisode};
use crate::sync::history_importer::TmdbClient;
use crate::{AppResult, AppState};

/// Only series watched in the last 18 months are considered.
const WITHIN_DAYS: i64 = 540;
const RECHECK_HOURS: i64 = 12;
const MAX_CHECKS: i64 = 40;
const CONCURRENCY: usize = 4;

/// `(season, episode, air_date)` of an episode object, when it has all three.
fn episode_triplet(v: &Value) -> Option<(i64, i64, String)> {
    let date = v["air_date"].as_str().filter(|d| d.len() >= 10)?.get(..10)?.to_string();
    Some((v["season_number"].as_i64()?, v["episode_number"].as_i64()?, date))
}

/// The episode after (`season`, `episode`) with its air date: the next one in the same season,
/// else episode 1 of the next season. `None` when TMDB doesn't list it yet.
async fn following_episode(tmdb: &TmdbClient, tv_id: i64, season: i64, episode: i64) -> AppResult<Option<(i64, i64, String)>> {
    let same = tmdb.get(&format!("/tv/{tv_id}/season/{season}"), &[]).await?;
    let in_season = same["episodes"]
        .as_array()
        .and_then(|eps| eps.iter().find(|e| e["episode_number"].as_i64() == Some(episode + 1)))
        .and_then(|e| e["air_date"].as_str().filter(|d| d.len() >= 10).map(|d| (season, episode + 1, d[..10].to_string())));
    if in_season.is_some() {
        return Ok(in_season);
    }
    let next = match tmdb.get(&format!("/tv/{tv_id}/season/{}", season + 1), &[]).await {
        Ok(v) => v,
        Err(_) => return Ok(None), // no next season yet
    };
    Ok(next["episodes"]
        .as_array()
        .and_then(|eps| eps.iter().find(|e| e["episode_number"].as_i64() == Some(1)))
        .and_then(|e| e["air_date"].as_str().filter(|d| d.len() >= 10).map(|d| (season + 1, 1, d[..10].to_string()))))
}

/// The new episode for one candidate, if one aired after the last watch (and by today).
async fn check_one(tmdb: &TmdbClient, cand: &AiringCandidate, today: &str) -> AppResult<Option<NewEpisode>> {
    let show = tmdb.get(&format!("/tv/{}", cand.tmdb_id), &[]).await?;
    // Cheap pre-check: nothing aired after the last watch, or nothing beyond what was watched.
    let Some((ls, le, last_date)) = episode_triplet(&show["last_episode_to_air"]) else {
        return Ok(None);
    };
    if last_date.as_str() <= cand.last_watched_date.as_str() || (ls, le) <= (cand.season_number, cand.episode_number) {
        return Ok(None);
    }
    // Caught up when they stopped: the very next episode must have aired *after* the last watch.
    // (If it had already aired, the user stopped mid-way rather than running out of episodes.)
    let Some((s, e, date)) = following_episode(tmdb, cand.tmdb_id, cand.season_number, cand.episode_number).await? else {
        return Ok(None);
    };
    if date.as_str() > cand.last_watched_date.as_str() && date.as_str() <= today {
        Ok(Some(NewEpisode { season_number: s, episode_number: e, air_date: date }))
    } else {
        Ok(None)
    }
}

/// Checks the profile's caught-up series; returns how many now have a new episode out.
pub async fn check_airing_shows(state: &AppState, app_profile_id: i64) -> AppResult<usize> {
    let candidates = state
        .db
        .run(move |c| queries::airing_candidates(c, app_profile_id, WITHIN_DAYS, RECHECK_HOURS, MAX_CHECKS))
        .await?;
    if candidates.is_empty() {
        return Ok(0);
    }
    let Ok(tmdb) = TmdbClient::from_settings(state).await else {
        return Ok(0); // no TMDB key yet
    };
    let today = Local::now().format("%Y-%m-%d").to_string();
    let sem = Arc::new(Semaphore::new(CONCURRENCY));
    let mut set = JoinSet::new();
    for cand in candidates {
        let (tmdb, sem, today) = (tmdb.clone(), sem.clone(), today.clone());
        set.spawn(async move {
            let _permit = sem.acquire_owned().await;
            let result = check_one(&tmdb, &cand, &today).await;
            (cand.tmdb_id, result)
        });
    }
    let mut found = 0;
    while let Some(joined) = set.join_next().await {
        let Ok((tmdb_id, result)) = joined else { continue };
        match result {
            Ok(new) => {
                found += usize::from(new.is_some());
                state
                    .db
                    .run(move |c| queries::record_airing_check(c, app_profile_id, tmdb_id, new.as_ref()))
                    .await?;
            }
            // Leave it unrecorded so the next Home load retries it.
            Err(e) => log::debug!("airing check for tv {tmdb_id} failed: {e}"),
        }
    }
    if found > 0 {
        log::info!("airing shows: {found} caught-up series have a new episode (profile {app_profile_id})");
    }
    Ok(found)
}

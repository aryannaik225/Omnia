//! Text feature extraction & local vectorization.
//!
//! Every title is turned into a rich semantic document (overview, TMDB keywords, genres,
//! director/creators, top-5 cast, studios/networks and derived mood/tone descriptors) and embedded
//! into a normalised 384-dimensional vector:
//!
//! * **Primary:** `sentence-transformers/all-MiniLM-L6-v2` (uint8-quantised ONNX) running on the
//!   local CPU through ONNX Runtime (`ort`), with an in-crate BERT WordPiece tokenizer and
//!   attention-masked mean pooling, exactly like `sentence-transformers` does.
//! * **Fallback:** sublinear-TF signed feature hashing into the same 384 dimensions. Used when the
//!   model can't be fetched/loaded. A fixed hashing projection is chosen over TF-IDF+SVD because an
//!   SVD basis drifts as the local corpus grows, which would silently invalidate every stored
//!   vector; hashing keeps vectors stable forever.
//!
//! The two backends live in different vector spaces, so the active `model_id` is recorded in
//! `app_settings` and stored embeddings are rebuilt whenever it changes.
//!
//! Runtime: ONNX Runtime is loaded dynamically (`ort` `load-dynamic`) from Microsoft's official
//! `onnxruntime.dll`, so Omnia has no link-time dependency on it (or on DirectML / the C++
//! runtime): if the library can't be provisioned or loaded, the app still starts and uses the
//! hashing fallback.
//!
//! Privacy: inference is 100% local. The only network access is a one-time download of public
//! files — the model (Hugging Face, pinned commit) and the runtime (official GitHub release) —
//! each verified by SHA-256. No user data is sent. ONNX Runtime's telemetry is disabled.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;
use unicode_normalization::UnicodeNormalization;

use crate::db::queries::MediaCatalogEntry;
use crate::{AppError, AppResult};

pub const EMBEDDING_DIM: usize = 384;
pub const ONNX_MODEL_ID: &str = "all-MiniLM-L6-v2-quint8@1110a24";
pub const HASHED_MODEL_ID: &str = "hashed-sublinear-tf-384-v1";

const MODEL_REVISION: &str = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41";
const MODEL_FILE: &str = "model_quint8_avx2.onnx";
const VOCAB_FILE: &str = "vocab.txt";
const MODEL_SHA256: &str = "b941bf19f1f1283680f449fa6a7336bb5600bdcd5f84d10ddc5cd72218a0fd21";
const VOCAB_SHA256: &str = "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3";

/// Official ONNX Runtime release matching `ort` 2.0.0-rc.15 (ONNX Runtime API 1.31).
const ORT_DLL: &str = "onnxruntime.dll";
#[cfg(all(windows, target_arch = "x86_64"))]
const ORT_ZIP_URL: &str =
    "https://github.com/microsoft/onnxruntime/releases/download/v1.31.0/onnxruntime-win-x64-1.31.0.zip";
#[cfg(all(windows, target_arch = "x86_64"))]
const ORT_ZIP_SHA256: &str = "3958d8a44984160692c1b4ffd0de3cb48f8c39f9d34bb31e433db06e30b82195";
#[cfg(all(windows, target_arch = "x86_64"))]
const ORT_ZIP_ENTRY: &str = "onnxruntime-win-x64-1.31.0/lib/onnxruntime.dll";
#[cfg(all(windows, target_arch = "x86_64"))]
const ORT_DLL_SHA256: &str = "0c42dc4e278f0968fdf9ebf1b1e54a74c657a9942e70803e453c91993451cf4c";
/// all-MiniLM-L6-v2 was trained with 256-token inputs; longer text is truncated.
const MAX_SEQ_LEN: usize = 256;
const BATCH_SIZE: usize = 16;

fn ml_err(e: impl std::fmt::Display) -> AppError {
    AppError::Message(format!("embedding model: {e}"))
}

// ---------------------------------------------------------------------------------------------
// Rich media document
// ---------------------------------------------------------------------------------------------

/// The semantic document for one title. Built from cached TMDB metadata in any of the shapes
/// Omnia stores (raw TMDB responses, compact name lists, or genre-id lists).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaDocument {
    pub title: String,
    pub overview: String,
    pub genres: Vec<String>,
    pub keywords: Vec<String>,
    pub directors: Vec<String>,
    pub cast: Vec<String>,
    pub studios: Vec<String>,
    pub moods: Vec<String>,
}

/// TMDB genre ids (movie + tv) -> names, for entries cached with ids only.
pub fn genre_name(id: i64) -> Option<&'static str> {
    Some(match id {
        28 => "Action",
        12 => "Adventure",
        16 => "Animation",
        35 => "Comedy",
        80 => "Crime",
        99 => "Documentary",
        18 => "Drama",
        10751 => "Family",
        14 => "Fantasy",
        36 => "History",
        27 => "Horror",
        10402 => "Music",
        9648 => "Mystery",
        10749 => "Romance",
        878 => "Science Fiction",
        10770 => "TV Movie",
        53 => "Thriller",
        10752 => "War",
        37 => "Western",
        10759 => "Action & Adventure",
        10762 => "Kids",
        10763 => "News",
        10764 => "Reality",
        10765 => "Sci-Fi & Fantasy",
        10766 => "Soap",
        10767 => "Talk",
        10768 => "War & Politics",
        _ => return None,
    })
}

/// Mood/tone descriptors derived from genres.
fn genre_moods(genre: &str) -> &'static [&'static str] {
    match genre.to_lowercase().as_str() {
        "action" | "action & adventure" => &["high-octane", "adrenaline-fuelled"],
        "adventure" => &["sweeping", "adventurous"],
        "animation" => &["animated", "imaginative"],
        "comedy" => &["lighthearted", "funny"],
        "crime" => &["gritty", "tense"],
        "documentary" => &["factual", "eye-opening"],
        "drama" => &["emotional", "character-driven"],
        "family" | "kids" => &["wholesome", "feel-good"],
        "fantasy" | "sci-fi & fantasy" => &["otherworldly", "imaginative"],
        "history" | "war" | "war & politics" => &["epic", "sobering"],
        "horror" => &["dark", "frightening"],
        "music" => &["musical", "uplifting"],
        "mystery" => &["intriguing", "suspenseful"],
        "romance" => &["romantic", "heartfelt"],
        "science fiction" => &["cerebral", "atmospheric"],
        "thriller" => &["suspenseful", "edge-of-your-seat"],
        "western" => &["rugged", "frontier"],
        "reality" | "talk" | "soap" => &["bingeable", "light"],
        _ => &[],
    }
}

/// Mood/tone descriptors derived from TMDB keyword substrings.
const KEYWORD_MOODS: &[(&str, &str)] = &[
    ("dystopia", "bleak"),
    ("post-apocalyptic", "bleak"),
    ("time travel", "mind-bending"),
    ("mind", "mind-bending"),
    ("psychological", "psychological"),
    ("serial killer", "dark"),
    ("murder", "dark"),
    ("coming of age", "nostalgic"),
    ("friendship", "warm"),
    ("love", "romantic"),
    ("supernatural", "eerie"),
    ("ghost", "eerie"),
    ("space", "atmospheric"),
    ("heist", "slick"),
    ("revenge", "intense"),
    ("superhero", "spectacle"),
    ("based on comic", "spectacle"),
    ("satire", "witty"),
    ("parody", "witty"),
    ("survival", "intense"),
    ("magic", "whimsical"),
    ("small town", "cosy"),
    ("based on novel", "literary"),
    ("true story", "grounded"),
    ("biography", "grounded"),
    ("anime", "anime"),
];

/// How light vs dark a title reads. Used to penalise tone clashes in ranking (a serial-killer
/// thriller in a lighthearted-comedy row) without hard genre filtering.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Tone {
    pub light: f32,
    pub dark: f32,
}

impl Tone {
    /// Weighted average of several tones (e.g. a row's seed titles).
    pub fn blend(items: impl IntoIterator<Item = (Tone, f64)>) -> Option<Tone> {
        let (mut light, mut dark, mut total) = (0.0f64, 0.0f64, 0.0f64);
        for (t, w) in items {
            if w <= 0.0 {
                continue;
            }
            light += f64::from(t.light) * w;
            dark += f64::from(t.dark) * w;
            total += w;
        }
        (total > 0.0).then(|| Tone { light: (light / total) as f32, dark: (dark / total) as f32 })
    }
}

const LIGHT_GENRES: &[&str] = &["comedy", "family", "kids", "animation", "music", "romance"];
const DARK_GENRES: &[&str] = &["horror", "crime", "thriller", "war", "war & politics"];
const LIGHT_MOODS: &[&str] = &[
    "lighthearted", "funny", "wholesome", "feel-good", "whimsical", "cosy", "warm", "uplifting", "witty", "light", "heartfelt",
];
const DARK_MOODS: &[&str] = &["dark", "frightening", "gritty", "bleak", "sobering", "intense", "eerie", "tense", "psychological"];
/// Keyword substrings that make a title dark whatever its genre tags say.
const DARK_KEYWORDS: &[&str] = &[
    "serial killer", "murder", "psychopath", "torture", "gore", "slasher", "rape", "sexual abuse", "child abuse",
    "suicide", "drug cartel", "drug addiction", "kidnapping", "genocide", "massacre", "cannibal", "home invasion",
    "violence", "dark comedy",
];
const LIGHT_KEYWORDS: &[&str] = &["sitcom", "feel-good", "romantic comedy", "slapstick", "parody", "spoof", "friendship", "christmas"];

fn json_names(v: &Value) -> Vec<String> {
    let arr = match v {
        Value::Array(a) => a.as_slice(),
        Value::Object(o) => match ["keywords", "results", "genres", "ids", "names"].iter().find_map(|k| o.get(*k)) {
            Some(inner) => return json_names(inner),
            None => return Vec::new(),
        },
        _ => return Vec::new(),
    };
    arr.iter()
        .filter_map(|item| match item {
            Value::String(s) => Some(s.trim().to_string()),
            Value::Number(n) => n.as_i64().and_then(genre_name).map(str::to_string),
            Value::Object(o) => o
                .get("name")
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
                .or_else(|| o.get("id").and_then(Value::as_i64).and_then(genre_name).map(str::to_string)),
            _ => None,
        })
        .filter(|s| !s.is_empty())
        .collect()
}

fn dedupe(mut v: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    v.retain(|s| seen.insert(s.to_lowercase()));
    v
}

impl MediaDocument {
    pub fn from_catalog(entry: &MediaCatalogEntry) -> Self {
        let genres = dedupe(entry.genres.as_ref().map(json_names).unwrap_or_default());
        let keywords: Vec<String> = dedupe(entry.keywords.as_ref().map(json_names).unwrap_or_default())
            .into_iter()
            .take(20)
            .collect();

        let (mut directors, mut cast, mut studios) = (Vec::new(), Vec::new(), Vec::new());
        if let Some(credits) = &entry.credits {
            // Compact shape written by the recommender: {directors, creators, cast, studios}.
            directors.extend(json_names(&credits["directors"]));
            directors.extend(json_names(&credits["creators"]));
            studios.extend(json_names(&credits["studios"]));
            match &credits["cast"] {
                Value::Array(people) => {
                    // Raw TMDB `credits.cast` is ordered by billing (`order`).
                    let mut billed: Vec<(i64, String)> = people
                        .iter()
                        .filter_map(|p| match p {
                            Value::String(s) => Some((0, s.clone())),
                            Value::Object(o) => Some((
                                o.get("order").and_then(Value::as_i64).unwrap_or(999),
                                o.get("name")?.as_str()?.to_string(),
                            )),
                            _ => None,
                        })
                        .collect();
                    billed.sort_by_key(|(order, _)| *order);
                    cast.extend(billed.into_iter().map(|(_, n)| n));
                }
                _ => {}
            }
            if let Some(crew) = credits["crew"].as_array() {
                directors.extend(
                    crew.iter()
                        .filter(|c| c["job"].as_str() == Some("Director"))
                        .filter_map(|c| c["name"].as_str().map(str::to_string)),
                );
            }
        }

        let mut moods: Vec<String> = genres
            .iter()
            .flat_map(|g| genre_moods(g).iter().map(|m| m.to_string()))
            .collect();
        for kw in &keywords {
            let k = kw.to_lowercase();
            moods.extend(KEYWORD_MOODS.iter().filter(|(needle, _)| k.contains(needle)).map(|(_, m)| m.to_string()));
        }

        Self {
            title: entry.title.clone(),
            overview: entry.overview.clone().unwrap_or_default(),
            genres,
            keywords,
            directors: dedupe(directors).into_iter().take(3).collect(),
            cast: dedupe(cast).into_iter().take(5).collect(),
            studios: dedupe(studios).into_iter().take(4).collect(),
            moods: dedupe(moods).into_iter().take(8).collect(),
        }
    }

    /// Light-vs-dark tone of the title (genres, derived moods and strongly toned keywords).
    pub fn tone(&self) -> Tone {
        let mut t = Tone::default();
        for g in &self.genres {
            let g = g.to_lowercase();
            if LIGHT_GENRES.contains(&g.as_str()) {
                t.light += 1.0;
            }
            if DARK_GENRES.contains(&g.as_str()) {
                t.dark += 1.0;
            }
        }
        // Moods partly restate genres, so they count less.
        for m in &self.moods {
            let m = m.to_lowercase();
            if LIGHT_MOODS.contains(&m.as_str()) {
                t.light += 0.35;
            }
            if DARK_MOODS.contains(&m.as_str()) {
                t.dark += 0.35;
            }
        }
        let (mut dark_kw, mut light_kw) = (0.0f32, 0.0f32);
        for k in &self.keywords {
            let k = k.to_lowercase();
            // A whodunit is a puzzle, not a dark title ("murder mystery", "cozy mystery").
            let puzzle = k.contains("mystery") || k.contains("whodunit");
            if !puzzle && DARK_KEYWORDS.iter().any(|d| k.contains(d)) {
                dark_kw += 1.0;
            }
            if LIGHT_KEYWORDS.iter().any(|l| k.contains(l)) {
                light_kw += 0.75;
            }
        }
        t.dark += dark_kw.min(3.0);
        t.light += light_kw.min(2.25);
        t
    }

    /// Natural-language rendering consumed by the transformer.
    pub fn to_text(&self) -> String {
        let mut parts = vec![format!("{}.", self.title)];
        let mut push = |label: &str, items: &[String]| {
            if !items.is_empty() {
                parts.push(format!("{label}: {}.", items.join(", ")));
            }
        };
        push("Genres", &self.genres);
        push("Mood", &self.moods);
        push("Themes", &self.keywords);
        push("Directed by", &self.directors);
        push("Starring", &self.cast);
        push("Studios", &self.studios);
        if !self.overview.is_empty() {
            parts.push(self.overview.clone());
        }
        parts.join(" ")
    }

    /// Weighted sparse features consumed by the hashing fallback.
    fn weighted_features(&self) -> Vec<(String, f32)> {
        let mut out = Vec::new();
        let mut field = |prefix: &str, items: &[String], w: f32| {
            for it in items {
                out.push((format!("{prefix}:{}", it.to_lowercase()), w));
            }
        };
        field("g", &self.genres, 2.0);
        field("k", &self.keywords, 1.5);
        field("m", &self.moods, 1.5);
        field("d", &self.directors, 1.2);
        field("c", &self.cast, 0.8);
        field("s", &self.studios, 0.8);
        let mut tf: HashMap<String, f32> = HashMap::new();
        for word in basic_tokenize(&self.overview) {
            if word.chars().count() >= 3 && !is_stopword(&word) && word.chars().any(char::is_alphanumeric) {
                *tf.entry(format!("w:{word}")).or_default() += 1.0;
            }
        }
        out.extend(tf.into_iter().map(|(w, n)| (w, 1.0 + n.ln())));
        out
    }
}

fn is_stopword(w: &str) -> bool {
    matches!(
        w,
        "the" | "and" | "for" | "with" | "his" | "her" | "their" | "they" | "she" | "him" | "from" | "that"
            | "this" | "into" | "when" | "who" | "what" | "where" | "while" | "after" | "before" | "has"
            | "have" | "had" | "but" | "are" | "was" | "were" | "its" | "one" | "two" | "all" | "out"
            | "about" | "them" | "than" | "then" | "must" | "will" | "can" | "only" | "own" | "new"
    )
}

// ---------------------------------------------------------------------------------------------
// BERT WordPiece tokenizer (uncased, accent-stripping — matches all-MiniLM-L6-v2's config)
// ---------------------------------------------------------------------------------------------

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x20000..=0x2A6DF | 0x2A700..=0x2B73F
        | 0x2B740..=0x2B81F | 0x2B820..=0x2CEAF | 0xF900..=0xFAFF | 0x2F800..=0x2FA1F)
}

fn is_punctuation(c: char) -> bool {
    let cp = c as u32;
    (33..=47).contains(&cp)
        || (58..=64).contains(&cp)
        || (91..=96).contains(&cp)
        || (123..=126).contains(&cp)
        || (!c.is_alphanumeric() && !c.is_whitespace() && !c.is_control() && !is_combining_mark(c))
}

fn is_combining_mark(c: char) -> bool {
    unicode_normalization::char::is_combining_mark(c)
}

/// BERT "basic tokenizer": clean, lowercase, strip accents, isolate CJK chars and punctuation.
pub fn basic_tokenize(text: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(text.len() + 16);
    for c in text.chars() {
        if c == '\0' || c == '\u{FFFD}' || (c.is_control() && !c.is_whitespace()) {
            continue;
        }
        if is_cjk(c) {
            spaced.push(' ');
            spaced.push(c);
            spaced.push(' ');
        } else if c.is_whitespace() {
            spaced.push(' ');
        } else {
            spaced.push(c);
        }
    }
    let mut tokens = Vec::new();
    for word in spaced.split_whitespace() {
        let normalized: String = word.to_lowercase().nfd().filter(|c| !is_combining_mark(*c)).collect();
        let mut current = String::new();
        for c in normalized.chars() {
            if is_punctuation(c) {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                tokens.push(c.to_string());
            } else {
                current.push(c);
            }
        }
        if !current.is_empty() {
            tokens.push(current);
        }
    }
    tokens
}

pub struct WordPieceTokenizer {
    vocab: HashMap<String, i64>,
    unk: i64,
    cls: i64,
    sep: i64,
    pad: i64,
}

impl WordPieceTokenizer {
    pub fn from_vocab(text: &str) -> AppResult<Self> {
        let vocab: HashMap<String, i64> = text
            .lines()
            .enumerate()
            .map(|(i, tok)| (tok.trim_end_matches('\r').to_string(), i as i64))
            .collect();
        let id = |t: &str| vocab.get(t).copied().ok_or_else(|| ml_err(format!("vocab missing {t}")));
        Ok(Self { unk: id("[UNK]")?, cls: id("[CLS]")?, sep: id("[SEP]")?, pad: id("[PAD]")?, vocab })
    }

    fn wordpiece(&self, word: &str, out: &mut Vec<i64>) {
        let chars: Vec<char> = word.chars().collect();
        if chars.len() > 100 {
            out.push(self.unk);
            return;
        }
        let mut pieces = Vec::new();
        let mut start = 0;
        while start < chars.len() {
            let mut end = chars.len();
            let mut found = None;
            while start < end {
                let mut sub: String = chars[start..end].iter().collect();
                if start > 0 {
                    sub.insert_str(0, "##");
                }
                if let Some(&id) = self.vocab.get(&sub) {
                    found = Some(id);
                    break;
                }
                end -= 1;
            }
            match found {
                Some(id) => pieces.push(id),
                None => {
                    out.push(self.unk);
                    return;
                }
            }
            start = end;
        }
        out.extend(pieces);
    }

    /// `[CLS] tokens… [SEP]`, truncated to `max_len`.
    pub fn encode(&self, text: &str, max_len: usize) -> Vec<i64> {
        let mut ids = vec![self.cls];
        for word in basic_tokenize(text) {
            self.wordpiece(&word, &mut ids);
            if ids.len() >= max_len - 1 {
                break;
            }
        }
        ids.truncate(max_len - 1);
        ids.push(self.sep);
        ids
    }
}

// ---------------------------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------------------------

pub fn l2_normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-12 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
}

fn fnv1a64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Signed feature hashing (deterministic random projection) into `EMBEDDING_DIM`.
pub fn hashed_embedding(doc: &MediaDocument) -> Vec<f32> {
    let mut v = vec![0f32; EMBEDDING_DIM];
    for (feature, weight) in doc.weighted_features() {
        let h = fnv1a64(&feature);
        let idx = (h % EMBEDDING_DIM as u64) as usize;
        let sign = if (h >> 63) & 1 == 1 { -1.0 } else { 1.0 };
        v[idx] += sign * weight;
    }
    l2_normalize(&mut v);
    v
}

struct OnnxEmbedder {
    // Held so the ONNX Runtime environment outlives the session.
    _env: ort::environment::Environment,
    session: Mutex<ort::session::Session>,
    tokenizer: WordPieceTokenizer,
    input_names: Vec<String>,
}

impl OnnxEmbedder {
    /// `runtime_path` is the ONNX Runtime shared library; it is loaded once per process.
    fn load(runtime_path: &Path, model_path: &Path, vocab_text: &str) -> AppResult<Self> {
        use ort::session::builder::GraphOptimizationLevel;
        let env = ort::init_from(runtime_path)
            .map_err(ml_err)?
            .with_name("omnia")
            .with_telemetry(false)
            .build()
            .map_err(ml_err)?;
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(1, 4);
        let mut builder = ort::session::Session::builder(&env)
            .map_err(ml_err)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(ml_err)?
            .with_intra_threads(threads)
            .map_err(ml_err)?;
        let session = builder.commit_from_file(model_path).map_err(ml_err)?;
        let input_names = session.inputs().iter().map(|i| i.name().to_string()).collect();
        Ok(Self {
            _env: env,
            session: Mutex::new(session),
            tokenizer: WordPieceTokenizer::from_vocab(vocab_text)?,
            input_names,
        })
    }

    fn embed(&self, texts: &[String]) -> AppResult<Vec<Vec<f32>>> {
        use ort::value::Tensor;
        let mut out = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(BATCH_SIZE) {
            let encoded: Vec<Vec<i64>> = chunk.iter().map(|t| self.tokenizer.encode(t, MAX_SEQ_LEN)).collect();
            let batch = encoded.len();
            let seq = encoded.iter().map(Vec::len).max().unwrap_or(2);
            let mut ids = vec![self.tokenizer.pad; batch * seq];
            let mut mask = vec![0i64; batch * seq];
            for (b, row) in encoded.iter().enumerate() {
                for (t, id) in row.iter().enumerate() {
                    ids[b * seq + t] = *id;
                    mask[b * seq + t] = 1;
                }
            }

            let mut inputs: Vec<(String, ort::session::SessionInputValue<'static>)> = Vec::new();
            for name in &self.input_names {
                let data = match name.as_str() {
                    "input_ids" => ids.clone(),
                    "attention_mask" => mask.clone(),
                    "token_type_ids" => vec![0i64; batch * seq],
                    other => return Err(ml_err(format!("unexpected model input '{other}'"))),
                };
                let tensor = Tensor::from_array(([batch, seq], data)).map_err(ml_err)?;
                inputs.push((name.clone(), tensor.into()));
            }

            let mut session = self.session.lock().unwrap_or_else(|p| p.into_inner());
            let outputs = session.run(inputs).map_err(ml_err)?;
            let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(ml_err)?;
            let dims: &[i64] = shape;
            match dims {
                // last_hidden_state [batch, seq, dim] -> attention-masked mean pooling.
                [b, s, d] if *b as usize == batch && *d as usize == EMBEDDING_DIM => {
                    let (s, d) = (*s as usize, *d as usize);
                    for bi in 0..batch {
                        let mut pooled = vec![0f32; d];
                        let mut count = 0f32;
                        for ti in 0..s.min(seq) {
                            if mask[bi * seq + ti] == 1 {
                                let base = (bi * s + ti) * d;
                                pooled.iter_mut().zip(&data[base..base + d]).for_each(|(p, x)| *p += x);
                                count += 1.0;
                            }
                        }
                        pooled.iter_mut().for_each(|p| *p /= count.max(1.0));
                        l2_normalize(&mut pooled);
                        out.push(pooled);
                    }
                }
                // Already pooled sentence embeddings [batch, dim].
                [b, d] if *b as usize == batch && *d as usize == EMBEDDING_DIM => {
                    for row in data.chunks(EMBEDDING_DIM) {
                        let mut v = row.to_vec();
                        l2_normalize(&mut v);
                        out.push(v);
                    }
                }
                other => return Err(ml_err(format!("unexpected output shape {other:?}"))),
            }
        }
        Ok(out)
    }
}

enum Backend {
    Onnx(OnnxEmbedder),
    Hashed,
}

/// A loaded embedding backend. `embed` is CPU-bound: call it from `spawn_blocking`.
pub struct Embedder {
    backend: Backend,
}

impl Embedder {
    pub fn hashed() -> Self {
        Self { backend: Backend::Hashed }
    }

    pub fn model_id(&self) -> &'static str {
        match self.backend {
            Backend::Onnx(_) => ONNX_MODEL_ID,
            Backend::Hashed => HASHED_MODEL_ID,
        }
    }

    pub fn embed(&self, docs: &[MediaDocument]) -> AppResult<Vec<Vec<f32>>> {
        match &self.backend {
            Backend::Onnx(model) => {
                let texts: Vec<String> = docs.iter().map(MediaDocument::to_text).collect();
                model.embed(&texts)
            }
            Backend::Hashed => Ok(docs.iter().map(hashed_embedding).collect()),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Service: lazy model provisioning + in-memory vector cache
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingStatus {
    pub ready: bool,
    pub model_id: Option<&'static str>,
    pub backend: Option<&'static str>,
    pub model_dir: String,
}

pub struct EmbeddingService {
    models_dir: PathBuf,
    cell: OnceCell<Arc<Embedder>>,
    /// (tmdb_id, media_type, model_id) -> vector; content-only, never user data.
    cache: Mutex<HashMap<(i64, String), Arc<Vec<f32>>>>,
}

const CACHE_LIMIT: usize = 6000;

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

async fn file_matches(path: &Path, sha256: &str) -> bool {
    match tokio::fs::read(path).await {
        Ok(bytes) => sha256_hex(&bytes) == sha256,
        Err(_) => false,
    }
}

/// Streams `url` to `dest` (via a `.part` file), hashing as it goes; nothing unverified is kept.
async fn download_verified(url: &str, dest: &Path, sha256: &str) -> AppResult<()> {
    use tokio::io::AsyncWriteExt;
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(1800))
        .build()?;
    let mut resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(ml_err(format!("download failed (HTTP {}) for {url}", resp.status())));
    }
    let tmp = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp).await?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = resp.chunk().await? {
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);
    let actual: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if actual != sha256 {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(ml_err(format!("checksum mismatch for {url} (got {actual})")));
    }
    tokio::fs::rename(&tmp, dest).await?;
    Ok(())
}

async fn ensure_file(dir: &Path, name: &str, url: &str, sha256: &str) -> AppResult<PathBuf> {
    let path = dir.join(name);
    if file_matches(&path, sha256).await {
        return Ok(path);
    }
    tokio::fs::create_dir_all(dir).await?;
    log::info!("downloading {name} (one-time, verified)");
    download_verified(url, &path, sha256).await?;
    Ok(path)
}

/// Extracts one entry from a zip archive and verifies it (blocking).
#[cfg(all(windows, target_arch = "x86_64"))]
fn extract_verified(zip_path: &Path, entry: &str, dest: &Path, sha256: &str) -> AppResult<()> {
    use std::io::Read;
    let mut archive = zip::ZipArchive::new(std::fs::File::open(zip_path)?).map_err(ml_err)?;
    let mut file = archive.by_name(entry).map_err(ml_err)?;
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut bytes)?;
    if sha256_hex(&bytes) != sha256 {
        return Err(ml_err(format!("{entry} checksum mismatch")));
    }
    let tmp = dest.with_extension("part");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

/// Locates or provisions the ONNX Runtime library, in order:
/// 1. `onnxruntime.dll` shipped next to the Omnia executable (installer-bundled builds);
/// 2. a previously verified copy in the models folder;
/// 3. Microsoft's official release, downloaded once (archive and DLL both hash-verified).
async fn ensure_runtime(dir: &Path) -> AppResult<PathBuf> {
    if let Some(bundled) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join(ORT_DLL)))
        .filter(|p| p.is_file())
    {
        return Ok(bundled);
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        let dll = dir.join(ORT_DLL);
        if file_matches(&dll, ORT_DLL_SHA256).await {
            return Ok(dll);
        }
        tokio::fs::create_dir_all(dir).await?;
        let archive = dir.join("onnxruntime-win-x64-1.31.0.zip");
        log::info!("downloading ONNX Runtime 1.31.0 (one-time, verified)");
        download_verified(ORT_ZIP_URL, &archive, ORT_ZIP_SHA256).await?;
        let (zip_path, dest) = (archive.clone(), dll.clone());
        let extracted =
            tauri::async_runtime::spawn_blocking(move || extract_verified(&zip_path, ORT_ZIP_ENTRY, &dest, ORT_DLL_SHA256))
                .await;
        let _ = tokio::fs::remove_file(&archive).await;
        extracted??;
        Ok(dll)
    }
    #[cfg(not(all(windows, target_arch = "x86_64")))]
    {
        let _ = dir;
        Err(ml_err("no ONNX Runtime library available for this platform"))
    }
}

impl EmbeddingService {
    pub fn new(models_dir: PathBuf) -> Self {
        Self { models_dir, cell: OnceCell::new(), cache: Mutex::new(HashMap::new()) }
    }

    /// Returns the embedder, provisioning the ONNX model on first use. Falls back to hashing
    /// (for this run) if the model can't be downloaded or loaded.
    pub async fn get(&self) -> Arc<Embedder> {
        self.cell
            .get_or_init(|| async {
                match self.load_onnx().await {
                    Ok(e) => {
                        log::info!("local embedding model ready ({ONNX_MODEL_ID})");
                        Arc::new(e)
                    }
                    Err(e) => {
                        log::warn!("ONNX embeddings unavailable, using hashed fallback: {e}");
                        Arc::new(Embedder::hashed())
                    }
                }
            })
            .await
            .clone()
    }

    async fn load_onnx(&self) -> AppResult<Embedder> {
        let dir = self.models_dir.join("all-MiniLM-L6-v2");
        let base = format!("https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/{MODEL_REVISION}");
        let model = ensure_file(&dir, MODEL_FILE, &format!("{base}/onnx/{MODEL_FILE}"), MODEL_SHA256).await?;
        let vocab = ensure_file(&dir, VOCAB_FILE, &format!("{base}/{VOCAB_FILE}"), VOCAB_SHA256).await?;
        let runtime = ensure_runtime(&self.models_dir.join("onnxruntime-1.31.0")).await?;
        let vocab_text = tokio::fs::read_to_string(&vocab).await?;
        let onnx =
            tauri::async_runtime::spawn_blocking(move || OnnxEmbedder::load(&runtime, &model, &vocab_text)).await??;
        Ok(Embedder { backend: Backend::Onnx(onnx) })
    }

    pub fn status(&self) -> EmbeddingStatus {
        let current = self.cell.get();
        EmbeddingStatus {
            ready: current.is_some(),
            model_id: current.map(|e| e.model_id()),
            backend: current.map(|e| match e.backend {
                Backend::Onnx(_) => "onnx",
                Backend::Hashed => "hashed",
            }),
            model_dir: self.models_dir.display().to_string(),
        }
    }

    /// Embeds documents keyed by (tmdb_id, media_type), serving repeats from the memory cache.
    pub async fn embed_keyed(
        &self,
        embedder: Arc<Embedder>,
        items: Vec<((i64, String), MediaDocument)>,
    ) -> AppResult<HashMap<(i64, String), Arc<Vec<f32>>>> {
        let model = embedder.model_id();
        let mut result = HashMap::new();
        let mut missing = Vec::new();
        {
            let cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
            for (key, doc) in items {
                let cache_key = (key.0, format!("{}|{model}", key.1));
                match cache.get(&cache_key) {
                    Some(v) => {
                        result.insert(key, v.clone());
                    }
                    None => missing.push((key, doc)),
                }
            }
        }
        if missing.is_empty() {
            return Ok(result);
        }
        let docs: Vec<MediaDocument> = missing.iter().map(|(_, d)| d.clone()).collect();
        let vectors = tauri::async_runtime::spawn_blocking(move || embedder.embed(&docs)).await??;
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        if cache.len() + vectors.len() > CACHE_LIMIT {
            cache.clear();
        }
        for ((key, _), v) in missing.into_iter().zip(vectors) {
            let v = Arc::new(v);
            cache.insert((key.0, format!("{}|{model}", key.1)), v.clone());
            result.insert(key, v);
        }
        Ok(result)
    }

    /// Drops cached vectors for titles whose metadata changed.
    pub fn invalidate(&self, keys: &[(i64, String)]) {
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        cache.retain(|(id, kind), _| !keys.iter().any(|(kid, kt)| kid == id && kind.starts_with(&format!("{kt}|"))));
    }
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(title: &str, genres: Value, keywords: Value, overview: &str) -> MediaCatalogEntry {
        MediaCatalogEntry {
            tmdb_id: 1,
            media_type: "movie".into(),
            title: title.into(),
            original_title: None,
            overview: Some(overview.into()),
            poster_path: None,
            backdrop_path: None,
            release_year: None,
            runtime_mins: None,
            genres: Some(genres),
            keywords: Some(keywords),
            credits: Some(json!({
                "cast": [{"name": "B Actor", "order": 1}, {"name": "A Lead", "order": 0}],
                "crew": [{"job": "Director", "name": "Denis Villeneuve"}, {"job": "Writer", "name": "X"}]
            })),
            vote_average: None,
            certification: None,
            updated_at: None,
        }
    }

    #[test]
    fn documents_accept_every_stored_shape() {
        let raw = entry("Arrival", json!([{"id": 878, "name": "Science Fiction"}]), json!({"keywords": [{"name": "time travel"}]}), "Linguist.");
        let doc = MediaDocument::from_catalog(&raw);
        assert_eq!(doc.genres, vec!["Science Fiction"]);
        assert_eq!(doc.keywords, vec!["time travel"]);
        assert_eq!(doc.directors, vec!["Denis Villeneuve"]);
        assert_eq!(doc.cast, vec!["A Lead", "B Actor"]);
        assert!(doc.moods.contains(&"mind-bending".to_string()));
        assert!(doc.to_text().contains("Directed by: Denis Villeneuve."));

        let ids_only = entry("X", json!({"ids": [27, 53]}), json!(["haunted house"]), "");
        assert_eq!(MediaDocument::from_catalog(&ids_only).genres, vec!["Horror", "Thriller"]);
    }

    #[test]
    fn basic_tokenizer_matches_bert() {
        assert_eq!(basic_tokenize("Amélie's  CAFÉ!"), vec!["amelie", "'", "s", "cafe", "!"]);
        assert_eq!(basic_tokenize("千と千尋"), vec!["千", "と", "千", "尋"]);
    }

    #[test]
    fn wordpiece_greedy_longest_match() {
        let vocab = "[PAD]\n[UNK]\n[CLS]\n[SEP]\nun\n##aff\n##able\nplay\n##ing\n";
        let tok = WordPieceTokenizer::from_vocab(vocab).unwrap();
        assert_eq!(tok.encode("unaffable playing xyz", 16), vec![2, 4, 5, 6, 7, 8, 1, 3]);
        assert_eq!(tok.encode("playing playing playing", 4), vec![2, 7, 8, 3]);
    }

    /// Real ONNX inference. Runs only when `OMNIA_MODEL_DIR` points at a folder containing the
    /// pinned `model_quint8_avx2.onnx` + `vocab.txt`, and `OMNIA_ORT_DLL` at an `onnxruntime.dll`
    /// (skipped in normal test runs).
    #[test]
    fn onnx_model_end_to_end() {
        let (Ok(dir), Ok(runtime)) = (std::env::var("OMNIA_MODEL_DIR"), std::env::var("OMNIA_ORT_DLL")) else {
            return;
        };
        let dir = PathBuf::from(dir);
        let vocab = std::fs::read_to_string(dir.join(VOCAB_FILE)).unwrap();
        let tok = WordPieceTokenizer::from_vocab(&vocab).unwrap();
        // Reference ids from the BERT uncased vocabulary.
        assert_eq!(tok.encode("Hello, world!", 16), vec![101, 7592, 1010, 2088, 999, 102]);

        let model = OnnxEmbedder::load(Path::new(&runtime), &dir.join(MODEL_FILE), &vocab).unwrap();
        let texts = [
            "A crew of astronauts travels through a wormhole to find a new home for humanity.",
            "Space explorers journey across distant galaxies aboard a starship.",
            "Two best friends plan a chaotic wedding full of romantic mix-ups.",
        ]
        .map(String::from);
        let v = model.embed(&texts).unwrap();
        assert_eq!(v.len(), 3);
        assert!(v.iter().all(|x| x.len() == EMBEDDING_DIM));
        let dot = |x: &[f32], y: &[f32]| x.iter().zip(y).map(|(p, q)| p * q).sum::<f32>();
        assert!((dot(&v[0], &v[0]) - 1.0).abs() < 1e-4);
        let (related, unrelated) = (dot(&v[0], &v[1]), dot(&v[0], &v[2]));
        eprintln!("cos(space, space) = {related:.3}, cos(space, wedding) = {unrelated:.3}");
        assert!(related > unrelated + 0.2);
    }

    #[test]
    fn hashed_embeddings_are_normalized_and_semantic() {
        let scifi = MediaDocument::from_catalog(&entry("A", json!(["Science Fiction"]), json!(["space", "alien"]), "astronauts explore space"));
        let scifi2 = MediaDocument::from_catalog(&entry("B", json!(["Science Fiction"]), json!(["space"]), "a crew in deep space"));
        let romcom = MediaDocument::from_catalog(&entry("C", json!(["Romance", "Comedy"]), json!(["wedding"]), "two strangers fall in love"));
        let (a, b, c) = (hashed_embedding(&scifi), hashed_embedding(&scifi2), hashed_embedding(&romcom));
        let dot = |x: &[f32], y: &[f32]| x.iter().zip(y).map(|(p, q)| p * q).sum::<f32>();
        assert!((dot(&a, &a) - 1.0).abs() < 1e-5);
        assert!(dot(&a, &b) > dot(&a, &c));
    }
}

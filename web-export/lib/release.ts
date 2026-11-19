import "server-only";

export const REPO = "aryannaik225/Omnia";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface ReleaseAsset {
  /** Public download URL (works once the repository is public). */
  url: string;
  /** API URL of the asset: with GITHUB_TOKEN it yields a signed download URL, even while the repo is private. */
  apiUrl?: string;
  name: string;
  sizeBytes: number | null;
}

export interface ReleaseInfo {
  /** "1.1.0" */
  version: string;
  /** "v1.1.0" */
  tag: string;
  name: string;
  publishedAt: string | null;
  pageUrl: string;
  exe: ReleaseAsset | null;
  msi: ReleaseAsset | null;
  setup: ReleaseAsset | null;
  notes: string;
  /** false when the GitHub API was unreachable (private repo, rate limit) and the fallback is shown. */
  live: boolean;
}

/** Shown while the repository is private (the API answers 404) or GitHub is unreachable. */
const FALLBACK: ReleaseInfo = {
  version: "1.1.0",
  tag: "v1.1.0",
  name: "Omnia v1.1.0",
  publishedAt: "2026-11-18T00:00:00Z",
  pageUrl: `${RELEASES_URL}/latest`,
  exe: null,
  msi: null,
  setup: null,
  notes: [
    "## What's new in 1.1.0",
    "- **Tap-to-top navigation**: re-clicking the open view in the sidebar or phone tab bar smooth-scrolls to the top.",
    "- **Collapsible episode lists**: seasons with 10+ episodes fold behind *Show all N episodes* / *Show less*.",
    "- **Oscar badges**: a shimmering gold *Oscar Best Picture* badge and a gold-trimmed *Oscar Winner* badge on movie info pages.",
    "",
    "## Also in this line",
    "- Signed auto-updates from GitHub Releases with a *Restart to Install* prompt.",
    "- `Omnia_*_x64-setup.exe` is the recommended per-user installer (no admin needed); the `.msi` is there for managed installs.",
  ].join("\n"),
  live: false,
};

type GhAsset = { name: string; url?: string; browser_download_url: string; size?: number };
type GhRelease = { tag_name: string; name?: string | null; body?: string | null; html_url: string; published_at?: string | null; assets?: GhAsset[] };

const pick = (assets: GhAsset[], test: (name: string) => boolean): ReleaseAsset | null => {
  const a = assets.find((x) => test(x.name.toLowerCase()));
  return a ? { url: a.browser_download_url, apiUrl: a.url, name: a.name, sizeBytes: a.size ?? null } : null;
};

/**
 * Latest GitHub release, fetched on the server and cached for an hour (ISR), so visitors never
 * hit GitHub's anonymous rate limit. `GITHUB_TOKEN` is optional (raises the server's limit).
 */
export function githubHeaders(accept = "application/vnd.github+json"): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "omnia-website" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

export async function getLatestRelease(): Promise<ReleaseInfo> {
  try {
    const headers = githubHeaders();
    const res = await fetch(LATEST_API, { headers, next: { revalidate: 3600 } });
    if (!res.ok) return FALLBACK; // 404 while the repository is private
    const r = (await res.json()) as GhRelease;
    if (!r?.tag_name) return FALLBACK;
    const assets = r.assets ?? [];
    return {
      version: r.tag_name.replace(/^v/i, ""),
      tag: r.tag_name,
      name: r.name || `Omnia ${r.tag_name}`,
      publishedAt: r.published_at ?? null,
      pageUrl: r.html_url,
      exe: pick(assets, (n) => n.endsWith(".exe") && !n.endsWith(".sig")),
      msi: pick(assets, (n) => n.endsWith(".msi") && !n.endsWith(".sig")),
      setup: pick(assets, (n) => n === "setup_instructions.txt"),
      notes: (r.body ?? "").trim() || FALLBACK.notes,
      live: true,
    };
  } catch {
    return FALLBACK;
  }
}

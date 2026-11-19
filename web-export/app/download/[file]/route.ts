import { NextResponse } from "next/server";
import { getLatestRelease, githubHeaders } from "@/lib/release";

/**
 * `/download/exe` and `/download/msi`: a direct installer download from the latest GitHub release.
 *
 * - With `GITHUB_TOKEN` set, GitHub hands back a short-lived signed URL for the asset, so the
 *   download works even while the repository is private.
 * - Otherwise it redirects to the asset's public download URL (works once the repo is public).
 * - If the release or the asset can't be found, it falls back to the GitHub Releases page.
 *
 * GitHub serves assets as attachments, so the browser downloads the file and stays on the page.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const release = await getLatestRelease();
  const asset = file === "exe" ? release.exe : file === "msi" ? release.msi : null;
  if (!asset) return NextResponse.redirect(release.pageUrl, 302);

  if (process.env.GITHUB_TOKEN && asset.apiUrl) {
    try {
      const res = await fetch(asset.apiUrl, { headers: githubHeaders("application/octet-stream"), redirect: "manual", cache: "no-store" });
      const signed = res.headers.get("location");
      if (signed) return NextResponse.redirect(signed, 302);
    } catch {
      // fall through to the public URL
    }
  }
  return NextResponse.redirect(asset.url, 302);
}

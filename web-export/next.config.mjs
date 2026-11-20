import { fileURLToPath } from "node:url";

/**
 * Secret-key guard. Next inlines every `NEXT_PUBLIC_*` variable into the browser bundle, so the
 * build refuses to run if a secret could end up there:
 *   - a server-only key under a public name (TMDB key, Supabase service-role / secret key);
 *   - a Supabase *secret* key (`sb_secret_…`, or a legacy JWT whose role is `service_role`)
 *     pasted into NEXT_PUBLIC_SUPABASE_ANON_KEY.
 * Only the project URL and the anon / publishable key may be public (RLS protects every row).
 */
function assertNoPublicSecrets() {
  const env = process.env;
  const forbidden = Object.keys(env).filter((k) => k.startsWith("NEXT_PUBLIC_") && /(SERVICE_ROLE|SECRET|TMDB|GITHUB_TOKEN|PRIVATE)/i.test(k));
  if (forbidden.length) {
    throw new Error(`Refusing to build: ${forbidden.join(", ")} would be exposed to the browser. Rename without NEXT_PUBLIC_ (server-only).`);
  }
  const anon = (env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  if (anon.startsWith("sb_secret_")) throw new Error("Refusing to build: NEXT_PUBLIC_SUPABASE_ANON_KEY is a Supabase secret key. Use the anon / publishable key.");
  const parts = anon.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      if (payload?.role && payload.role !== "anon") throw new Error(`Refusing to build: NEXT_PUBLIC_SUPABASE_ANON_KEY has role "${payload.role}". Use the anon key.`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Refusing")) throw e;
    }
  }
}
assertNoPublicSecrets();

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [{ protocol: "https", hostname: "image.tmdb.org", pathname: "/t/p/**" }],
  },
  poweredByHeader: false,
  // Never ship source maps of server code or client bundles to the browser.
  productionBrowserSourceMaps: false,
  // A standalone project inside the Omnia repo: trace files from this folder only.
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
};

export default nextConfig;

/** True when the Supabase project is configured (the landing page deploys fine without it). */
export const supabaseConfigured = () => Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

/** Where the web app lives inside the site. */
export const APP_BASE = "/app";

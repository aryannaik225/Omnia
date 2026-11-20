import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { APP_BASE } from "@/lib/supabase/env";

/**
 * E-mail confirmation and Google OAuth landing: exchanges the PKCE code for a session cookie.
 * The guest library in this browser is merged into the account by TrackerProvider afterwards.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const oauthError = searchParams.get("error_description") ?? searchParams.get("error");
  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${APP_BASE}`);
  }
  const message = oauthError ? oauthError.slice(0, 200) : "That sign-in link is invalid or expired.";
  return NextResponse.redirect(`${origin}${APP_BASE}/login?error=${encodeURIComponent(message)}`);
}

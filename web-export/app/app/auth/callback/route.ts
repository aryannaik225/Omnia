import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { APP_BASE } from "@/lib/supabase/env";

/** E-mail confirmation / magic-link landing: exchanges the code for a session cookie. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${APP_BASE}`);
  }
  return NextResponse.redirect(`${origin}${APP_BASE}/login?error=${encodeURIComponent("That sign-in link is invalid or expired.")}`);
}

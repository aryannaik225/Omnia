import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { APP_BASE } from "@/lib/supabase/env";

export async function POST(request: NextRequest) {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL(`${APP_BASE}/login`, request.url), { status: 303 });
}

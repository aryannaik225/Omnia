import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Runs only for the web app under /app (the landing page at / is public and static).
 * Refreshes the Supabase session cookie and keeps signed-out users on /app/login.
 */
export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublic = path.startsWith("/app/login") || path.startsWith("/app/auth");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Not configured yet (e.g. a fresh Vercel deploy): the login page explains what's missing.
  if (!url || !anon) {
    if (isPublic) return NextResponse.next();
    const to = request.nextUrl.clone();
    to.pathname = "/app/login";
    return NextResponse.redirect(to);
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list: CookieToSet[]) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublic) {
    const to = request.nextUrl.clone();
    to.pathname = "/app/login";
    return NextResponse.redirect(to);
  }
  return response;
}

export const config = {
  matcher: ["/app", "/app/:path*"],
};

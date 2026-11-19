import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Runs only for the web app under /app (the landing page at / is public and static).
 *
 * There is no login wall: guests can browse, search and track in their own browser. When
 * Supabase is configured this only refreshes a signed-in user's session cookie.
 */
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return NextResponse.next();

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
  // Touching the session refreshes an expiring token; signed-out visitors pass straight through.
  await supabase.auth.getUser();
  return response;
}

export const config = {
  // Skip the title-summary API (it never needs the session).
  matcher: ["/app", "/app/((?!api/).*)"],
};

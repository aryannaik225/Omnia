import "server-only";
import { supabaseConfigured } from "@/lib/supabase/env";
import { supabaseServer } from "@/lib/supabase/server";

/** The signed-in user, or null for guests (and whenever Supabase isn't configured). */
export async function currentUser(): Promise<{ id: string; email: string | null } | null> {
  if (!supabaseConfigured()) return null;
  try {
    const supabase = await supabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user ? { id: user.id, email: user.email ?? null } : null;
  } catch {
    return null;
  }
}

"use client";
import { createBrowserClient } from "@supabase/ssr";

/** Supabase client for Client Components (row access is limited by RLS to the signed-in user). */
export const supabaseBrowser = () => createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

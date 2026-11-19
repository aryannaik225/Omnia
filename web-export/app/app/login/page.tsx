import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { APP_BASE, supabaseConfigured } from "@/lib/supabase/env";

async function signIn(formData: FormData) {
  "use server";
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (error) redirect(`${APP_BASE}/login?error=${encodeURIComponent(error.message)}`);
  redirect(APP_BASE);
}

async function signUp(formData: FormData) {
  "use server";
  const supabase = await supabaseServer();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { error } = await supabase.auth.signUp({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    options: { emailRedirectTo: `${origin}${APP_BASE}/auth/callback` },
  });
  if (error) redirect(`${APP_BASE}/login?error=${encodeURIComponent(error.message)}`);
  redirect(`${APP_BASE}/login?message=${encodeURIComponent("Check your e-mail to confirm your account.")}`);
}

export const metadata = { title: "Sign in · Omnia" };

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const { error, message } = await searchParams;
  const configured = supabaseConfigured();
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form className="glass w-full max-w-[400px] rounded-panel p-8 text-center">
        <h1 className="text-[28px] font-bold tracking-tight">Omnia</h1>
        <p className="mt-1 text-label-secondary">Sign in to your library</p>
        {configured ? (
          <>
            <input name="email" type="email" required autoComplete="email" placeholder="E-mail" className="glass-input mt-6" />
            <input name="password" type="password" required minLength={8} autoComplete="current-password" placeholder="Password" className="glass-input mt-3" />
            {error && <p className="mt-3 text-[14px] text-[#ff6961]">{error}</p>}
            {message && <p className="mt-3 text-[14px] text-[#30d158]">{message}</p>}
            <div className="mt-6 flex flex-col gap-3">
              <button formAction={signIn} className="glass-button-primary">
                Sign in
              </button>
              <button formAction={signUp} className="glass-button">
                Create account
              </button>
            </div>
          </>
        ) : (
          <p className="mt-6 text-[14px] leading-relaxed text-label-secondary">
            The browser edition isn&apos;t connected to a Supabase project yet. Set <code className="text-label-primary">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code className="text-label-primary">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> for this deployment, or grab the desktop app in the meantime.
          </p>
        )}
        <Link href="/" className="mt-6 inline-block text-[13px] text-label-tertiary hover:text-label-primary">
          ← Back to omnia
        </Link>
      </form>
    </main>
  );
}

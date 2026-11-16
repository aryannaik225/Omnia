import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

async function signIn(formData: FormData) {
  "use server";
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect("/");
}

async function signUp(formData: FormData) {
  "use server";
  const supabase = await supabaseServer();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { error } = await supabase.auth.signUp({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect(`/login?message=${encodeURIComponent("Check your e-mail to confirm your account.")}`);
}

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const { error, message } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form className="glass w-full max-w-[400px] rounded-panel p-8 text-center">
        <h1 className="text-[28px] font-bold tracking-tight">Omnia</h1>
        <p className="mt-1 text-label-secondary">Sign in to your library</p>
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
      </form>
    </main>
  );
}

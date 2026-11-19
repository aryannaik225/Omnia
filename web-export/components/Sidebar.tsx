import Link from "next/link";

const NAV = [
  { href: "/app", label: "Home" },
  { href: "/app#your-list", label: "Your List" },
  { href: "/", label: "About Omnia" },
];

/** Floating Liquid Glass navigation (a top bar on phones). */
export function Sidebar({ email }: { email: string | null }) {
  return (
    <nav className="glass fixed inset-x-3 top-3 z-40 flex items-center gap-2 rounded-[20px] px-4 py-3 md:inset-x-auto md:bottom-4 md:left-4 md:top-4 md:w-[220px] md:flex-col md:items-stretch md:rounded-card md:px-3 md:py-5">
      <Link href="/app" className="px-2 text-[20px] font-bold tracking-tight md:mb-6">
        Omnia
      </Link>
      <ul className="flex flex-1 gap-1 md:flex-col">
        {NAV.map((n) => (
          <li key={n.href}>
            <Link href={n.href} className="block rounded-pill px-3 py-2 text-[15px] font-medium text-label-secondary hover:bg-white/[0.08] hover:text-label-primary">
              {n.label}
            </Link>
          </li>
        ))}
      </ul>
      <form action="/app/auth/signout" method="post" className="md:mt-auto">
        <button className="w-full truncate rounded-pill px-3 py-2 text-left text-[13px] text-label-tertiary hover:bg-white/[0.08]" title={email ?? undefined}>
          Sign out
        </button>
      </form>
    </nav>
  );
}

import { redirect } from "next/navigation";

/** Old title links: titles now open as the detail sheet over Home (`/app?t=movie:603`). */
export default async function TitlePage({ params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await params;
  if ((type === "movie" || type === "tv") && /^\d{1,9}$/.test(id)) redirect(`/app?t=${type}:${id}`);
  redirect("/app");
}

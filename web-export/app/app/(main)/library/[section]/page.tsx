import { redirect } from "next/navigation";
import { LibrarySectionView } from "@/omnia/components/views/LibraryView";

const SECTIONS = ["watchlist", "upcoming", "ongoing", "completed", "movies"];

export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!SECTIONS.includes(section)) redirect("/app/library");
  return <LibrarySectionView section={section} />;
}

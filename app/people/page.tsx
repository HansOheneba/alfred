import { redirect } from "next/navigation";

/** Retired people-note bookmarks lead back to the conversation. Saved notes are kept. */
export default function PeoplePage() {
  redirect("/chat");
}

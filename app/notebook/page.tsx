import { redirect } from "next/navigation";

/** Retired Notebook bookmarks lead back to the conversation. Saved notes are kept. */
export default function NotebookPage() {
  redirect("/chat");
}

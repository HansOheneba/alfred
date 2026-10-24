import { redirect } from "next/navigation";

/** Chat now lives on the home page; keep old links working. */
export default function ChatPage() {
  redirect("/");
}

import { redirect } from "next/navigation";

/** People notes now live in the Notebook. */
export default function PeoplePage() {
  redirect("/notebook");
}

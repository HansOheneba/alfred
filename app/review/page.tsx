import { redirect } from "next/navigation";

export default function ReviewPage() { redirect("/accounts?tab=needs-attention"); }

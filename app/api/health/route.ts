import { connection } from "next/server";

import { readPublicStatus } from "@/lib/env";

export async function GET(): Promise<Response> {
  await connection();
  const checks = readPublicStatus();
  return Response.json({ status: "ok", checks });
}

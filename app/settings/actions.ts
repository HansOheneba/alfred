"use server";

import { cookies } from "next/headers";

import { HOME_COOKIE, readHome, type HomeScreen } from "@/lib/web/home";

/** Remembers which screen "/" opens on, for this browser, for a year. */
export async function setHomeScreen(choice: HomeScreen): Promise<HomeScreen> {
  const home = readHome(choice);
  (await cookies()).set(HOME_COOKIE, home, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
  });
  return home;
}

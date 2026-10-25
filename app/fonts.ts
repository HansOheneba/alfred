import { Instrument_Sans } from "next/font/google";

/**
 * Interface type. Instrument Sans is the primary face, including display type.
 * Aktiv Grotesk is not in the repo (no licensed files were provided).
 *
 * To add Aktiv Grotesk later, put the licensed files in `fonts/aktiv-grotesk/`,
 * load them with `next/font/local`, and add `aktiv.variable` on `<html>` in `app/layout.tsx`.
 * `font-display` already reads `--font-aktiv` and falls back to Instrument Sans while it is unset.
 * Do not assign a different family to `--font-aktiv` and call it Aktiv Grotesk.
 *
 * import localFont from "next/font/local";
 *
 * export const aktiv = localFont({
 *   src: [
 *     { path: "../fonts/aktiv-grotesk/AktivGrotesk-Regular.woff2", weight: "400", style: "normal" },
 *     { path: "../fonts/aktiv-grotesk/AktivGrotesk-Medium.woff2", weight: "500", style: "normal" },
 *     { path: "../fonts/aktiv-grotesk/AktivGrotesk-Bold.woff2", weight: "700", style: "normal" },
 *   ],
 *   variable: "--font-aktiv",
 *   display: "swap",
 *   adjustFontFallback: false,
 * });
 */
export const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-instrument",
  adjustFontFallback: true,
});

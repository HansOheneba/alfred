import type { Metadata, Viewport } from "next";

import { PwaRegister } from "@/app/components/pwa";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alfred",
  description: "A personal finance assistant for the website and Telegram.",
  appleWebApp: { capable: true, title: "Alfred", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfcfe" },
    { media: "(prefers-color-scheme: dark)", color: "#18151f" },
  ],
  // Lets iPhone content reach the safe areas and keeps the composer above the Android keyboard.
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

// Applies the saved appearance and privacy mask before first paint so dark mode and hidden amounts don't flash.
const themeScript = `try{if(localStorage.getItem("alfred-appearance")==="dark")document.documentElement.dataset.theme="dark";if(localStorage.getItem("alfred-privacy")==="masked")document.documentElement.dataset.privacy="masked"}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex min-h-full flex-col bg-bg text-ink">
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}

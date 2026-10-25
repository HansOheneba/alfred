import type { Metadata, Viewport } from "next";

import { PwaRegister } from "@/app/components/pwa";
import { instrumentSans } from "@/app/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alfred",
  description: "A personal finance assistant for the website and Telegram.",
  appleWebApp: { capable: true, title: "Alfred", statusBarStyle: "black-translucent" },
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
  themeColor: "#0b0b0c",
  // Lets iPhone content reach the safe areas and keeps the composer above the Android keyboard.
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

// Applies the saved theme before first paint so light mode doesn't flash dark.
const themeScript = `try{if(localStorage.getItem("alfred-theme")==="light")document.documentElement.dataset.theme="light"}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${instrumentSans.variable} h-full antialiased`}
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

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Alfred",
    short_name: "Alfred",
    description: "Your personal finance butler. Log spending, ask where your money goes, and keep the books with Alfred.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#fcfcfe",
    theme_color: "#fcfcfe",
    categories: ["finance", "productivity"],
    icons: [
      { src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
      { src: "/maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Chat", url: "/chat" },
      { name: "Overview", url: "/dashboard" },
      { name: "Settings", url: "/settings" },
    ],
  };
}

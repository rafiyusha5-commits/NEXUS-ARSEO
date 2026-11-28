import type { MetadataRoute } from "next";

// The mobile warehouse as an app on the home screen (202611280500): full screen, starts at /m. No offline work in the
// first version (owner decision В2): there is no service worker and no queue.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nexus · Склад",
    short_name: "Nexus Склад",
    description: "Склад с телефона: поиск по коду, этикетки, складские операции",
    start_url: "/m",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f6f4",
    theme_color: "#009B77",
    lang: "ru",
    icons: [
      { src: "/icons/nexus-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/nexus-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/nexus-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

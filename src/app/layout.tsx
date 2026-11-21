import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import "./globals.css";

// ARSEO brand type: Jost (close to the site's geometric headings) and Golos Text for interface text.
// Vendored originals include Latin/Cyrillic; neither builds nor browsers need Google Fonts.
const display = localFont({ src: "./fonts/Jost-Variable.ttf", weight: "500 700", style: "normal", variable: "--font-display", display: "swap" });
const body = localFont({ src: "./fonts/GolosText-Variable.ttf", weight: "400 700", style: "normal", variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "Nexus-ARSEO",
  description: "Управление импортом, экспортом и логистикой ТОО ARSEO",
};

// Reading the request headers renders every page per request, so each response carries the nonce of its own
// Content-Security-Policy (src/proxy.ts); Next.js adds the nonce to its scripts itself.
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await headers();
  return <html lang="ru" data-scroll-behavior="smooth" className={`${display.variable} ${body.variable}`}><body>{children}</body></html>;
}

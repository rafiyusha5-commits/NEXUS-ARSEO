import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// ARSEO brand type: Jost (close to the site's geometric headings) and Golos Text for interface text.
// Vendored originals include Latin/Cyrillic; neither builds nor browsers need Google Fonts.
const display = localFont({ src: "./fonts/Jost-Variable.ttf", weight: "500 700", style: "normal", variable: "--font-display", display: "swap" });
const body = localFont({ src: "./fonts/GolosText-Variable.ttf", weight: "400 700", style: "normal", variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "Nexus-ARSEO",
  description: "Управление импортом, экспортом и логистикой ТОО ARSEO",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" data-scroll-behavior="smooth" className={`${display.variable} ${body.variable}`}><body>{children}</body></html>;
}

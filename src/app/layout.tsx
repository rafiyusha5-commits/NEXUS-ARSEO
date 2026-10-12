import type { Metadata } from "next";
import { Golos_Text, Jost } from "next/font/google";
import "./globals.css";

// ARSEO brand type: Jost (close to the site's geometric headings) and Golos Text for interface text.
// Both are self-hosted by next/font at build time; no request goes to Google from the browser.
const display = Jost({ subsets: ["latin", "cyrillic"], weight: ["500", "600", "700"], variable: "--font-display", display: "swap" });
const body = Golos_Text({ subsets: ["latin", "cyrillic"], weight: ["400", "500", "600", "700"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "Nexus-ARSEO",
  description: "Управление импортом, экспортом и логистикой ТОО ARSEO",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" data-scroll-behavior="smooth" className={`${display.variable} ${body.variable}`}><body>{children}</body></html>;
}

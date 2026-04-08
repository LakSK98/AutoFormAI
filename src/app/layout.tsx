import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";

const outfit = Outfit({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Form Automation Engine",
  description: "Generate and schedule mock responses with AI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${outfit.className} min-h-screen antialiased selection:bg-blue-500/30`}>
        {children}
      </body>
    </html>
  );
}

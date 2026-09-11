import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  ),
  title: "3DGS Converter · PLY to 3D Tiles",
  description:
    "Convert a Gaussian Splatting PLY to 3D Tiles or simplify it directly in your browser.",
  openGraph: {
    title: "3DGS Converter",
    description: "Convert a Gaussian Splatting PLY to 3D Tiles or simplify it in your browser.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "3DGS Converter",
    description: "Convert a Gaussian Splatting PLY to 3D Tiles or simplify it in your browser.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

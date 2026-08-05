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
    images: [
      {
        url: "/og.png",
        width: 1731,
        height: 909,
        alt: "Point cloud data converted into 3D Tiles",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "3DGS Converter",
    description: "Convert a Gaussian Splatting PLY to 3D Tiles or simplify it in your browser.",
    images: ["/og.png"],
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

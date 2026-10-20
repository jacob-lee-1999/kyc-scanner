import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "신분증 촬영",
  description: "신분증을 이 기기 안에서만 맞춰 잘라 둡니다.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "신분증 촬영",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#000000",
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

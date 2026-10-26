import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "카드 번호 인식",
  description: "카드 번호를 이 기기 안에서만 읽습니다.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "카드 번호 인식",
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

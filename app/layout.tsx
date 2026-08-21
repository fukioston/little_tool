import type { Metadata } from "next";
import "./globals.css";
import OfflineRegistration from "./OfflineRegistration";

export const metadata: Metadata = {
  title: { default: "私人工作台", template: "%s · 私人工作台" },
  description: "职迹、拾词、适练，以及之后属于你的本地优先私人空间。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN"><body>{children}<OfflineRegistration /></body></html>
  );
}

import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'DockerManager · 宿主机管理台',
  description: '容器、镜像升级与 Compose 管理界面',
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
    shortcut: '/favicon.svg',
  },
};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="zh-CN"><body>{children}</body></html>}

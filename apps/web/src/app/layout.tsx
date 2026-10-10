import type { Metadata } from 'next';
import { AppProvider } from '../components/store';
import { AppShell } from '../components/shell';
import { ConfirmProvider } from '../components/confirm';
import './globals.css';

export const metadata: Metadata = {
  title: '每日三省 · 把所学变成所得',
  description: '一个安静的个人学习空间。复述、追问、检验与间隔复习。',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" data-scroll-behavior="smooth"><body><ConfirmProvider><AppProvider><AppShell>{children}</AppShell></AppProvider></ConfirmProvider></body></html>;
}

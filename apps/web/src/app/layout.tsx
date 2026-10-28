import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AppProvider } from '../components/store';
import { AppShell } from '../components/shell';
import { ConfirmProvider } from '../components/confirm';
import { RouteScreen } from '../components/screens';
import { ComposerProvider } from '../components/composer-context';
import { ImageImportProvider } from '../components/image-import';
import { FeedbackProvider } from '../components/feedback';
import './globals.css';
import './v3.css';

export const metadata: Metadata = {
  title: '每日三省 · 把所学变成所得',
  description: '一个安静的个人学习空间。复述、追问、检验与间隔复习。',
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" data-scroll-behavior="smooth"><body><ConfirmProvider><FeedbackProvider><AppProvider><ImageImportProvider><ComposerProvider><AppShell><Suspense fallback={<p>正在打开学习记录…</p>}><RouteScreen />{children}</Suspense></AppShell></ComposerProvider></ImageImportProvider></AppProvider></FeedbackProvider></ConfirmProvider></body></html>;
}

import { Suspense } from 'react';
import { RouteScreen } from '../../components/screens';
export default function Page() { return <Suspense fallback={<p>正在打开学习记录…</p>}><RouteScreen /></Suspense>; }

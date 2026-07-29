import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Nimble Agent V2 × Vercel AI SDK',
  description: 'A model-driven Agent API V2 lifecycle playground.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

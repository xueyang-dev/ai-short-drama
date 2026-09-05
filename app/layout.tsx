import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import './globals.css'

export const metadata: Metadata = {
  title: 'Arabic Short Drama Studio',
  description: 'Windows-first local Arabic short drama production studio',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  )
}

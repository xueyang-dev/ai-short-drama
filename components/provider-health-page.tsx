'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Activity, ArrowLeft, CheckCircle2, Loader2, RefreshCw, TriangleAlert, XCircle } from 'lucide-react'
import type { ProviderHealth } from '@/lib/providers/contracts'
import { requestJson } from './studio/client'

const STATUS = {
  available: { label: '可用', icon: CheckCircle2, className: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
  degraded: { label: '部分可用', icon: TriangleAlert, className: 'border-amber-200 bg-amber-50 text-amber-800' },
  unavailable: { label: '不可用', icon: XCircle, className: 'border-red-200 bg-red-50 text-red-800' },
} as const

export function ProviderHealthPage() {
  const [providers, setProviders] = useState<ProviderHealth[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setProviders(await requestJson<ProviderHealth[]>('/api/providers'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '健康检查失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <main className="min-h-screen bg-[var(--stage)] px-4 py-6 md:px-8 md:py-10">
      <div className="mx-auto max-w-6xl">
        <header className="panel flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between md:p-7">
          <div>
            <Link href="/" className="mb-4 inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-[var(--muted)] transition hover:text-[var(--ink)]"><ArrowLeft className="h-3.5 w-3.5" /> 返回项目页</Link>
            <div className="label">Local runtime diagnostics</div>
            <h1 className="display-type flex items-center gap-3 text-3xl font-semibold"><Activity className="h-7 w-7 text-[var(--projector)]" /> Provider 健康状态</h1>
            <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">只检测 localhost 服务和本机可执行文件。该页面不会安装、更新或清理 ComfyUI。</p>
          </div>
          <button className="btn-primary cursor-pointer self-start sm:self-center" onClick={() => void refresh()} disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} 重新检测</button>
        </header>

        {error && <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}
        {loading && providers.length === 0 ? (
          <div className="panel mt-5 flex min-h-48 items-center justify-center text-sm text-[var(--muted)]" role="status"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在检测本地运行环境…</div>
        ) : (
          <section className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Provider 状态">
            {providers.map(provider => {
              const status = STATUS[provider.availability]
              const Icon = status.icon
              return (
                <article key={provider.id} className="panel min-w-0 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><div className="timecode text-[10px] text-[var(--muted)]">{provider.id}</div><h2 className="mt-1 truncate font-semibold">{provider.name}</h2></div>
                    <span className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold ${status.className}`}><Icon className="h-3.5 w-3.5" /> {status.label}</span>
                  </div>
                  <p className="mt-4 min-h-10 break-words text-sm leading-5 text-[var(--muted)]">{provider.message || '没有附加信息'}</p>
                  <dl className="mt-4 space-y-2 border-t border-[var(--line)] pt-4 text-xs">
                    {provider.endpoint && <div><dt className="label">Endpoint</dt><dd className="break-all font-mono text-[var(--ink)]">{provider.endpoint}</dd></div>}
                    {provider.version && <div><dt className="label">Version</dt><dd className="break-words text-[var(--ink)]">{provider.version}</dd></div>}
                    <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">Latency</dt><dd>{provider.latencyMs === undefined ? '—' : `${provider.latencyMs} ms`}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-[var(--muted)]">Checked</dt><dd>{new Date(provider.checkedAt).toLocaleTimeString('zh-CN')}</dd></div>
                  </dl>
                </article>
              )
            })}
          </section>
        )}
      </div>
    </main>
  )
}

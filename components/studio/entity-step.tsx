'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImagePlus, Loader2, Maximize2, Plus, RefreshCw, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { confirmToast } from '@/components/confirm-toast'
import { ImageLightbox } from '@/components/image-lightbox'
import type { Entity, EntityKind, ProjectBundle } from '@/lib/types'
import { fileAsDataUrl, requestJson } from './client'

interface Props {
  kind: EntityKind
  bundle: ProjectBundle
  refresh: (quiet?: boolean) => Promise<void>
}

const CONFIG = {
  character: { title: '角色造型', eyebrow: 'Cast bible', empty: '剧本生成后会自动整理角色；也可以手动添加造型。', accent: '#8b7cf7' },
  scene: { title: '空镜场景', eyebrow: 'Location bible', empty: '在这里建立可重复使用的空间与光线设定。', accent: '#41a99e' },
  prop: { title: '关键道具', eyebrow: 'Prop bible', empty: '只保留跨镜头需要维持一致的关键物件。', accent: '#d79833' },
} as const

export function EntityStep({ kind, bundle, refresh }: Props) {
  const config = CONFIG[kind]
  const entities = useMemo(() => bundle.entities.filter(entity => entity.kind === kind), [bundle.entities, kind])
  const [showAdd, setShowAdd] = useState(false)
  const [threeView, setThreeView] = useState(kind !== 'scene')
  const workingIdsRef = useRef(new Set<string>())
  const [workingIds, setWorkingIds] = useState<Set<string>>(() => new Set())
  const [batching, setBatching] = useState(false)
  const [form, setForm] = useState({ name: '', variant: '', description: '', episodes: '', category: 'item' })

  useEffect(() => {
    if (!showAdd) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowAdd(false)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [showAdd])

  const setEntityWorking = (entityId: string, working: boolean) => {
    const next = new Set(workingIdsRef.current)
    if (working) next.add(entityId)
    else next.delete(entityId)
    workingIdsRef.current = next
    setWorkingIds(next)
  }

  const create = async () => {
    if (!form.name.trim() || !form.description.trim()) return toast.error('名称和视觉描述不能为空')
    try {
      await requestJson(`/api/projects/${bundle.project.id}/entities`, {
        method: 'POST',
        body: JSON.stringify({
          kind,
          name: form.name,
          variant: kind === 'character' ? form.variant || '默认造型' : '',
          description: form.description,
          episodes: form.episodes.split(/[,，\s]+/).map(Number).filter(Number.isFinite),
          category: kind === 'prop' ? form.category : '',
        }),
      })
      setShowAdd(false)
      setForm({ name: '', variant: '', description: '', episodes: '', category: 'item' })
      await refresh(true)
      toast.success('素材档案已添加')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '添加失败')
    }
  }

  const update = async (entity: Entity, fields: Partial<Entity>) => {
    try {
      await requestJson(`/api/projects/${bundle.project.id}/entities`, {
        method: 'PATCH',
        body: JSON.stringify({ entityId: entity.id, ...fields }),
      })
      await refresh(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新失败')
    }
  }

  const remove = async (entity: Entity) => {
    const entityLabel = `${entity.name}${entity.variant ? ` / ${entity.variant}` : ''}`
    if (!await confirmToast({
      title: `删除“${entityLabel}”？`,
      description: '该素材档案及其图片版本记录将被删除；本地图片文件仍会保留。',
      confirmLabel: '删除素材',
    })) return
    try {
      await requestJson(`/api/projects/${bundle.project.id}/entities?entityId=${entity.id}`, { method: 'DELETE' })
      await refresh(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败')
    }
  }

  const generate = async (entity: Entity, referenceCurrent = false, silent = false, refreshAfter = true) => {
    if (workingIdsRef.current.has(entity.id)) return
    setEntityWorking(entity.id, true)
    try {
      await requestJson(`/api/entities/${entity.id}/image`, {
        method: 'POST',
        body: JSON.stringify({ action: 'generate', referenceCurrent, threeView }),
      })
      if (!silent) toast.success('Seedream 图片已保存到本地')
      if (refreshAfter) await refresh(true)
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : '生图失败')
      throw error
    } finally {
      setEntityWorking(entity.id, false)
    }
  }

  const batchGenerate = async () => {
    const missingImages = entities.filter(entity => !entity.selectedImage)
    if (!missingImages.length) return toast.info('所有素材都已有选定图片')
    const pending = missingImages.filter(entity => !workingIdsRef.current.has(entity.id))
    if (!pending.length) return toast.info('缺图素材均正在生成中')
    if (!await confirmToast({
      title: `批量生成 ${pending.length} 个素材？`,
      description: '任务将并行调用 Seedream 生成图片，期间请保持应用运行。',
      confirmLabel: '开始生成',
      tone: 'warning',
    })) return
    setBatching(true)
    try {
      const targets = pending.filter(entity => !workingIdsRef.current.has(entity.id))
      if (!targets.length) return toast.info('缺图素材均正在生成中')
      const results = await Promise.allSettled(
        targets.map(entity => generate(entity, false, true, false)),
      )
      const succeeded = results.filter(result => result.status === 'fulfilled').length
      await refresh(true)
      if (succeeded === targets.length) toast.success(`批量生成完成：${succeeded}/${targets.length}`)
      else toast.error(`批量生成完成：${succeeded} 成功，${targets.length - succeeded} 失败`)
    } finally {
      setBatching(false)
    }
  }

  const upload = async (entity: Entity, file: File) => {
    if (workingIdsRef.current.has(entity.id)) return
    setEntityWorking(entity.id, true)
    try {
      const dataUrl = await fileAsDataUrl(file)
      await requestJson(`/api/entities/${entity.id}/image`, {
        method: 'POST', body: JSON.stringify({ action: 'upload', dataUrl }),
      })
      await refresh(true)
      toast.success('图片已保存到本地')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传失败')
    } finally {
      setEntityWorking(entity.id, false)
    }
  }

  const selectVersion = async (entity: Entity, imageId: string) => {
    try {
      await requestJson(`/api/entities/${entity.id}/image`, {
        method: 'POST', body: JSON.stringify({ action: 'select', imageId }),
      })
      await refresh(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '切换版本失败')
    }
  }

  const deleteVersion = async (entity: Entity, imageId: string) => {
    if (!await confirmToast({
      title: '删除这个图片版本？',
      description: '该图片版本将软删除且本地文件保留；若它是当前版本，将自动切换到最近版本。',
      confirmLabel: '删除版本',
    })) return
    try {
      await requestJson(`/api/entities/${entity.id}/image`, {
        method: 'POST', body: JSON.stringify({ action: 'delete', imageId }),
      })
      await refresh(true)
      toast.success('图片版本已删除')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除图片版本失败')
    }
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-5">
      <section className="panel flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between md:p-6">
        <div>
          <div className="label">{config.eyebrow}</div>
          <h3 className="display-type text-2xl font-semibold">{config.title}</h3>
          <p className="mt-1 max-w-2xl text-sm text-[var(--muted)]">Seedream 5.0 Lite 只返回 Base64，服务端随即写入本地媒体目录；所有版本可回看和切换。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {kind !== 'scene' && <label className="mr-2 flex items-center gap-2 text-xs text-[var(--muted)]"><input type="checkbox" checked={threeView} disabled={batching} onChange={e => setThreeView(e.target.checked)} /> 三视图设定稿</label>}
          <button className="btn-secondary" disabled={batching} onClick={() => void batchGenerate()}>{batching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} 批量补齐图片</button>
          <button className="btn-primary" disabled={batching} onClick={() => setShowAdd(true)}><Plus className="h-4 w-4" /> 添加{kind === 'character' ? '造型' : kind === 'scene' ? '场景' : '道具'}</button>
        </div>
      </section>

      {entities.length === 0 ? (
        <button className="panel flex w-full flex-col items-center border-dashed py-24 text-center hover:border-[var(--projector)]" disabled={batching} onClick={() => setShowAdd(true)}>
          <ImagePlus className="mb-4 h-10 w-10" style={{ color: config.accent }} />
          <strong>{config.empty}</strong>
          <span className="mt-2 text-sm text-[var(--muted)]">点击添加第一份档案。</span>
        </button>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {entities.map(entity => (
            <EntityCard
              key={entity.id}
              entity={entity}
              accent={config.accent}
              working={workingIds.has(entity.id)}
              locked={workingIds.has(entity.id)}
              onGenerate={generate}
              onUpload={upload}
              onSelect={selectVersion}
              onDeleteVersion={deleteVersion}
              onUpdate={update}
              onDelete={remove}
            />
          ))}
        </div>
      )}

      {showAdd && createPortal(
        <div className="fixed inset-0 z-[100] flex h-[100dvh] w-screen items-center justify-center bg-[#09101d]/80 p-3 backdrop-blur-md md:p-6" onMouseDown={() => setShowAdd(false)}>
          <section role="dialog" aria-modal="true" aria-labelledby="add-entity-dialog-title" className="panel scrollbar-thin max-h-[calc(100dvh-1.5rem)] w-full max-w-4xl overflow-y-auto p-5 shadow-[0_36px_100px_-24px_rgba(0,0,0,.75)] md:max-h-[calc(100dvh-3rem)] md:p-7 lg:p-8" onMouseDown={event => event.stopPropagation()}>
            <header className="flex items-start justify-between gap-4">
              <div>
                <div className="label">New {kind}</div>
                <h3 id="add-entity-dialog-title" className="display-type text-2xl font-semibold">添加{config.title}</h3>
                <p className="mt-1 text-sm text-[var(--muted)]">完善稳定视觉描述，后续生成和跨镜头引用会以这份档案为准。</p>
              </div>
              <button type="button" aria-label="关闭新增素材弹窗" onClick={() => setShowAdd(false)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--line)] text-[var(--muted)] transition hover:border-[#aeb8c6] hover:text-[var(--ink)]"><X className="h-4 w-4" /></button>
            </header>
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              <label className={kind === 'scene' ? 'md:col-span-2' : undefined}><span className="label">名称</span><input className="field" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} autoFocus /></label>
              {kind === 'character' && <label><span className="label">造型阶段</span><input className="field" value={form.variant} onChange={e => setForm({ ...form, variant: e.target.value })} placeholder="默认造型 / 雨夜造型" /></label>}
              {kind === 'prop' && <label><span className="label">分类</span><select className="field" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}><option value="item">物品</option><option value="weapon">武器</option><option value="vehicle">载具</option><option value="clothing">服装</option><option value="accessory">饰品</option></select></label>}
              <label><span className="label">出场集数</span><input className="field" value={form.episodes} onChange={e => setForm({ ...form, episodes: e.target.value })} placeholder="1, 2, 3" /></label>
              <label className="md:col-span-3"><span className="label">稳定视觉描述</span><textarea className="field min-h-52 resize-y leading-6" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="描述材质、颜色、轮廓、结构和识别细节…" /></label>
            </div>
            <div className="mt-6 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setShowAdd(false)}>取消</button><button className="btn-primary" onClick={() => void create()}>添加档案</button></div>
          </section>
        </div>,
        document.body,
      )}
    </div>
  )
}

function EntityCard({ entity, accent, working, locked, onGenerate, onUpload, onSelect, onDeleteVersion, onUpdate, onDelete }: {
  entity: Entity
  accent: string
  working: boolean
  locked: boolean
  onGenerate: (entity: Entity, referenceCurrent?: boolean) => Promise<void>
  onUpload: (entity: Entity, file: File) => Promise<void>
  onSelect: (entity: Entity, imageId: string) => Promise<void>
  onDeleteVersion: (entity: Entity, imageId: string) => Promise<void>
  onUpdate: (entity: Entity, fields: Partial<Entity>) => Promise<void>
  onDelete: (entity: Entity) => Promise<void>
}) {
  const uploadRef = useRef<HTMLInputElement>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const previewAlt = `${entity.name}${entity.variant ? ` / ${entity.variant}` : ''}`

  return (
    <>
      <article className="panel overflow-hidden">
        <div className="relative aspect-[4/3] bg-[#e8ebef]">
          {entity.selectedImage ? (
            <button
              type="button"
              className="group relative h-full w-full cursor-zoom-in overflow-hidden"
              onClick={() => setPreviewUrl(entity.selectedImage?.url ?? null)}
              aria-label={`查看${previewAlt}大图`}
            >
              <img src={entity.selectedImage.url} alt={previewAlt} className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.02]" />
              <span className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-[var(--navy)]/80 px-2.5 py-1.5 text-[10px] font-semibold text-white opacity-0 shadow-lg backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Maximize2 className="h-3 w-3" /> 查看大图
              </span>
            </button>
          ) : <div className="flex h-full flex-col items-center justify-center text-sm text-[var(--muted)]"><ImagePlus className="mb-3 h-8 w-8" style={{ color: accent }} />尚无定稿图</div>}
          {working && <div className="absolute inset-0 flex items-center justify-center bg-[var(--navy)]/70 text-sm font-semibold text-white backdrop-blur-sm"><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在处理图片…</div>}
          <span className="timecode absolute left-3 top-3 rounded-md bg-[var(--navy)]/85 px-2 py-1 text-[9px] text-white">{entity.kind.toUpperCase()} / {String(entity.images.length).padStart(2, '0')} VER</span>
        </div>
        <div className="p-4">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <input className="w-full border-0 bg-transparent p-0 font-semibold outline-none" defaultValue={entity.name} disabled={locked} onBlur={e => { if (e.target.value !== entity.name) void onUpdate(entity, { name: e.target.value }) }} />
              {entity.kind === 'character' && <input className="mt-1 w-full border-0 bg-transparent p-0 text-xs text-[var(--muted)] outline-none" defaultValue={entity.variant} disabled={locked} onBlur={e => { if (e.target.value !== entity.variant) void onUpdate(entity, { variant: e.target.value }) }} />}
            </div>
            <button className="btn-quiet !min-h-7 !px-1.5 hover:!text-[var(--danger)]" disabled={locked} onClick={() => void onDelete(entity)}><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
          <textarea className={`mt-3 w-full resize-y rounded-lg border border-transparent bg-[var(--panel-muted)] p-2.5 text-xs leading-5 outline-none focus:border-[var(--projector)] ${entity.kind === 'character' ? 'min-h-36' : 'min-h-24'}`} defaultValue={entity.description} disabled={locked} onBlur={e => { if (e.target.value !== entity.description) void onUpdate(entity, { description: e.target.value }) }} />
          {entity.images.length > 0 && <div className="scrollbar-thin mt-3 flex gap-2 overflow-x-auto pb-1">{entity.images.map((image, index) => <div key={image.id} className="relative h-12 w-12 shrink-0"><button disabled={locked} onClick={() => void onSelect(entity, image.id)} className={`h-full w-full overflow-hidden rounded-lg border-2 ${image.id === entity.selectedImage?.id ? 'border-[var(--projector)]' : 'border-transparent opacity-65 hover:opacity-100'}`}><img src={image.url} alt={`版本 ${index + 1}`} className="h-full w-full object-cover" /></button><button className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-[10px] text-white shadow" disabled={locked} onClick={() => void onDeleteVersion(entity, image.id)} aria-label={`删除图片版本 ${index + 1}`}>×</button></div>)}</div>}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button className="btn-primary" disabled={locked} onClick={() => void onGenerate(entity, false)}><Sparkles className="h-3.5 w-3.5" /> {entity.selectedImage ? '生成新版本' : '生成图片'}</button>
            <button className="btn-secondary" disabled={locked || !entity.selectedImage} onClick={() => void onGenerate(entity, true)}><RefreshCw className="h-3.5 w-3.5" /> 参考重绘</button>
            <button className="btn-secondary col-span-2" disabled={locked} onClick={() => uploadRef.current?.click()}><Upload className="h-3.5 w-3.5" /> 上传本地图</button>
            <input ref={uploadRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; if (file) void onUpload(entity, file); event.target.value = '' }} />
          </div>
        </div>
      </article>
      {previewUrl && <ImageLightbox src={previewUrl} alt={previewAlt} onClose={() => setPreviewUrl(null)} />}
    </>
  )
}

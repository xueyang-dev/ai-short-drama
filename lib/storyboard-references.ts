import type { Entity } from './types'

type ReferenceEntity = Pick<Entity, 'id' | 'kind' | 'name' | 'variant' | 'metadata'>

function encodeTagSegment(value: string): string {
  return value.trim().replace(/\s+/g, '_')
}

/** 与 XuefengAI 分镜 Skill 一致的素材标签。 */
export function getStoryboardReferenceTag(entity: Pick<ReferenceEntity, 'kind' | 'name' | 'variant'>): string {
  if (entity.kind === 'character') {
    return `@${encodeTagSegment(entity.name)}-${encodeTagSegment(entity.variant || '默认形象')}`
  }
  return `@${entity.name.trim()}`
}

function kindPriority(entity: ReferenceEntity): number {
  return entity.kind === 'prop' ? 0 : entity.kind === 'character' ? 1 : 2
}

function hasTagBoundary(prompt: string, end: number): boolean {
  const nextCharacter = prompt[end]
  return !nextCharacter || !/[\p{L}\p{N}_-]/u.test(nextCharacter)
}

function includesExactTag(prompt: string, tag: string): boolean {
  let fromIndex = 0
  while (fromIndex < prompt.length) {
    const index = prompt.indexOf(tag, fromIndex)
    if (index < 0) return false
    const end = index + tag.length
    if (hasTagBoundary(prompt, end)) return true
    fromIndex = end
  }
  return false
}

function replaceExactTag(prompt: string, tag: string, replacement: string): string {
  let fromIndex = 0
  let result = ''
  while (fromIndex < prompt.length) {
    const index = prompt.indexOf(tag, fromIndex)
    if (index < 0) return result + prompt.slice(fromIndex)
    const end = index + tag.length
    result += prompt.slice(fromIndex, index)
    if (hasTagBoundary(prompt, end)) {
      result += replacement
    } else {
      result += prompt.slice(index, end)
    }
    fromIndex = end
  }
  return result
}

/**
 * 从 prompt 的 @ 标签解析引用实体。长标签优先，避免 @医馆 误匹配
 * @医馆_日；返回顺序就是图片提交与“图片N”编号顺序。
 */
export function resolveStoryboardReferenceEntities<T extends ReferenceEntity>(
  prompt: string,
  entities: readonly T[],
): T[] {
  const occupied: Array<{ start: number; end: number }> = []
  const matches: Array<{ index: number; entity: T }> = []
  const candidates = entities
    .map(entity => ({ entity, tag: getStoryboardReferenceTag(entity) }))
    .filter(candidate => candidate.tag.length > 1)
    .sort((left, right) => (
      right.tag.length - left.tag.length
      || kindPriority(left.entity) - kindPriority(right.entity)
    ))

  for (const { entity, tag } of candidates) {
    let fromIndex = 0
    while (fromIndex < prompt.length) {
      const index = prompt.indexOf(tag, fromIndex)
      if (index < 0) break
      const end = index + tag.length
      if (hasTagBoundary(prompt, end) && !occupied.some(range => index < range.end && end > range.start)) {
        occupied.push({ start: index, end })
        matches.push({ index, entity })
      }
      fromIndex = end
    }
  }

  const seen = new Set<string>()
  return matches
    .sort((left, right) => left.index - right.index)
    .map(match => match.entity)
    .filter(entity => {
      if (seen.has(entity.id)) return false
      seen.add(entity.id)
      return true
    })
}

function fallbackDefinition(entity: ReferenceEntity, imageNumber: number): string {
  if (entity.kind === 'character') {
    const role = typeof entity.metadata.role === 'string' && /protagonist|主角/i.test(entity.metadata.role)
      ? '主角'
      : '角色'
    return `- 将 图片${imageNumber} 定义为${role}「${entity.name}」，保持面部、发型和服装一致`
  }
  if (entity.kind === 'scene') {
    return `- 将 图片${imageNumber} 定义为场景「${entity.name}」，保持空间结构、陈设和光影氛围一致`
  }
  return `- 将 图片${imageNumber} 定义为道具「${entity.name}」，保持形状、材质和颜色一致`
}

/**
 * Seedance API 不认识业务素材名。提交前把 @标签按图片输入顺序确定性替换成
 * 图片1、图片2……；手动勾选但未写标签的素材会补入主体定义段。
 */
export function bindStoryboardReferencesForSeedance(
  prompt: string,
  references: readonly ReferenceEntity[],
): string {
  const numbered = references.map((entity, index) => ({
    entity,
    imageNumber: index + 1,
    tag: getStoryboardReferenceTag(entity),
  }))
  const replacementByTag = new Map<string, number>()
  for (const item of numbered) {
    if (!replacementByTag.has(item.tag)) replacementByTag.set(item.tag, item.imageNumber)
  }

  let result = prompt
  for (const [tag, imageNumber] of [...replacementByTag.entries()].sort((left, right) => right[0].length - left[0].length)) {
    result = replaceExactTag(result, tag, `图片${imageNumber}`)
  }

  const missingDefinitions = numbered
    .filter(item => !includesExactTag(prompt, item.tag))
    .map(item => fallbackDefinition(item.entity, item.imageNumber))
  if (!missingDefinitions.length) return result

  const header = /^素材引用与主体定义[:：][ \t]*$/m
  if (header.test(result)) {
    return result.replace(header, match => `${match}\n${missingDefinitions.join('\n')}`)
  }
  return `素材引用与主体定义:\n${missingDefinitions.join('\n')}\n\n${result}`
}

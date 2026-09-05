import { describe, expect, it } from 'vitest'
import {
  bindStoryboardReferencesForH3,
  getStoryboardReferenceTag,
  resolveStoryboardReferenceEntities,
} from './storyboard-references'

const entities = [
  { id: 'character-yang', kind: 'character' as const, name: '杨凌', variant: '默认形象', metadata: { role: 'protagonist' } },
  { id: 'character-lin', kind: 'character' as const, name: '林婉儿', variant: '默认形象', metadata: { role: 'supporting' } },
  { id: 'scene-clinic', kind: 'scene' as const, name: '医馆_日', variant: '', metadata: {} },
  { id: 'scene-clinic-short', kind: 'scene' as const, name: '医馆', variant: '', metadata: {} },
]

const prompt = `素材引用与主体定义:
- 将 @杨凌-默认形象 定义为主角「杨凌」，保持面部、发型和服装一致
- 将 @林婉儿-默认形象 定义为角色「林婉儿」，保持面部、发型和服装一致
- 将 @医馆_日 定义为场景「医馆_日」，保持空间结构、陈设和光影氛围一致

分镜提示词:
场景：医馆_日
镜头1：中景缓推，杨凌站在木桌旁。
镜头2：切近景，林婉儿抬眼看他。`

describe('storyboard reference binding', () => {
  it('使用与 XuefengAI 一致的 @素材标签', () => {
    expect(getStoryboardReferenceTag(entities[0])).toBe('@杨凌-默认形象')
    expect(getStoryboardReferenceTag({
      kind: 'character', name: 'John Smith', variant: 'Daily Look',
    })).toBe('@John_Smith-Daily_Look')
    expect(getStoryboardReferenceTag(entities[2])).toBe('@医馆_日')
  })

  it('按标签出现顺序解析实体，且长场景名不会误匹配短名称', () => {
    expect(resolveStoryboardReferenceEntities(prompt, entities).map(entity => entity.id)).toEqual([
      'character-yang',
      'character-lin',
      'scene-clinic',
    ])
  })

  it('不存在长名称实体时，也不会把短标签当作长标签前缀', () => {
    const shortScene = entities[3]
    const unknownLongTag = '素材引用与主体定义:\n- 将 @医馆_夜 定义为场景「医馆_夜」'

    expect(resolveStoryboardReferenceEntities(unknownLongTag, [shortScene])).toEqual([])
    expect(bindStoryboardReferencesForH3(unknownLongTag, [shortScene])).toContain('@医馆_夜')
    expect(bindStoryboardReferencesForH3(unknownLongTag, [shortScene])).toContain('- 将 图片1 定义为场景「医馆」')
  })

  it('提交 H3 前将 @标签替换为与图片输入顺序一致的图片编号', () => {
    const references = resolveStoryboardReferenceEntities(prompt, entities)
    const bound = bindStoryboardReferencesForH3(prompt, references)

    expect(bound).toContain('将 图片1 定义为主角「杨凌」')
    expect(bound).toContain('将 图片2 定义为角色「林婉儿」')
    expect(bound).toContain('将 图片3 定义为场景「医馆_日」')
    expect(bound).not.toContain('@杨凌-默认形象')
    expect(bound).not.toContain('@林婉儿-默认形象')
    expect(bound).not.toContain('@医馆_日')
  })

  it('为手动勾选但未写 @标签的参考图补充主体定义', () => {
    const bound = bindStoryboardReferencesForH3('镜头1：杨凌走入医馆。', [entities[0], entities[2]])

    expect(bound).toMatch(/^素材引用与主体定义:/)
    expect(bound).toContain('- 将 图片1 定义为主角「杨凌」')
    expect(bound).toContain('- 将 图片2 定义为场景「医馆_日」')
  })
})

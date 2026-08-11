import { describe, expect, it } from 'vitest'
import { VIDEO_STYLES } from '@/config/video-styles'
import type { Entity, EntityKind, Project } from './types'
import { buildEntityImagePrompt } from './prompts'

const createdAt = '2026-08-11T00:00:00.000Z'
const project: Project = {
  id: 'project-1', title: '提示词测试', brief: '', synopsis: '', genre: '都市情感',
  visualStyle: VIDEO_STYLES[0].promptValue, ratio: '9:16', plannedEpisodes: 3,
  createdAt, updatedAt: createdAt,
}

function entity(kind: EntityKind, input: Partial<Entity> = {}): Entity {
  return {
    id: `${kind}-1`, projectId: project.id, kind, name: '', variant: '', description: '', episodes: [],
    category: '', metadata: {}, selectedImageId: null, images: [], selectedImage: null,
    createdAt, updatedAt: createdAt, ...input,
  }
}

describe('entity image prompts', () => {
  it('角色三视图对齐 XuefengAI 的姿态、完整性和一致性约束', () => {
    const prompt = buildEntityImagePrompt(entity('character', {
      name: '叶辰', variant: '总裁造型', description: '黑色正装，冷峻神情。', metadata: { gender: 'male' },
    }), project, true)

    expect(prompt).toContain('叶辰，总裁造型（男性角色）全身形象：黑色正装，冷峻神情。')
    expect(prompt).toContain('自然表情，正对镜头站立，眼神直视镜头，双手自然下垂')
    expect(prompt).toContain('背景：纯净中性背景，无场景、无道具、无其他人物')
    expect(prompt).not.toContain('纯白色背景')
    expect(prompt).toContain('正面、侧面（90度）、背面三个角度')
    expect(prompt).toContain('五官、发型、服装、体型和配饰')
    expect(prompt).toContain('完整展示全身，双脚可见')
    expect(prompt).toContain('手部完整，无文字、无水印、无 LOGO')
    expect(prompt.endsWith(`统一视觉风格：${VIDEO_STYLES[0].generationPrompt}。`)).toBe(true)
  })

  it('关闭角色三视图时仍要求正面完整全身', () => {
    const prompt = buildEntityImagePrompt(entity('character', {
      name: '林夏', description: '红色礼服', metadata: { gender: 'female' },
    }), project, false)

    expect(prompt).toContain('正面全身构图：角色居中，完整展示全身，双脚可见')
    expect(prompt).not.toContain('三视图构图')
  })

  it('场景对齐无人空镜、空间关系和专业摄影构图约束', () => {
    const prompt = buildEntityImagePrompt(entity('scene', {
      name: '盛世集团大堂', description: '挑高空间，黑色大理石地面',
    }), project, true)

    expect(prompt).toContain('盛世集团大堂，空镜场景')
    expect(prompt).toContain('不出现人物或主体角色，环境信息完整，空间关系清晰')
    expect(prompt).toContain('专业摄影构图，无文字、无水印、无 LOGO')
    expect(prompt).not.toContain('三视图')
  })

  it('道具根据开关使用三视图或单体居中构图', () => {
    const prop = entity('prop', {
      name: '银色戒指', description: '简洁素圈，表面有细微划痕',
    })
    const threeViewPrompt = buildEntityImagePrompt(prop, project, true)
    const singleViewPrompt = buildEntityImagePrompt(prop, project, false)

    expect(threeViewPrompt).toContain('银色戒指特写')
    expect(threeViewPrompt).toContain('背景：纯净中性背景，无手持者、无其他物体')
    expect(threeViewPrompt).toContain('正面、侧面（90度）、背面三个角度')
    expect(threeViewPrompt).toContain('同一道具保持完全一致的造型、材质、颜色和细节')
    expect(singleViewPrompt).toContain('单体居中构图：完整展示道具外观和关键细节')
    expect(singleViewPrompt).not.toContain('三视图构图')
    expect(singleViewPrompt).toContain('光照均匀，材质和结构细节清晰，无文字、无水印、无 LOGO')
  })
})

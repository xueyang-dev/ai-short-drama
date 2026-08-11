import { resolveVideoStylePrompt } from '@/config/video-styles'
import type { Entity, Project } from './types'

const CHARACTER_THREE_VIEW_PROMPT = '三视图构图：从左到右依次展示正面、侧面（90度）、背面三个角度。同一角色保持完全一致的五官、发型、服装、体型和配饰，完整展示全身，双脚可见。'
const CHARACTER_SINGLE_VIEW_PROMPT = '正面全身构图：角色居中，完整展示全身，双脚可见。'
const PROP_THREE_VIEW_PROMPT = '三视图构图：从左到右依次展示正面、侧面（90度）、背面三个角度。同一道具保持完全一致的造型、材质、颜色和细节。'
const PROP_SINGLE_VIEW_PROMPT = '单体居中构图：完整展示道具外观和关键细节。'

function cleanPart(value?: string | null): string {
  return value?.trim().replace(/[。；，,\s]+$/, '') ?? ''
}

function sanitizeVisualStyle(style: string): string {
  return style
    .replace(/[\n\r]/g, ' ')
    .replace(/[^一-鿿　-〿a-zA-Z0-9,，.、\s-]/g, '')
    .trim()
}

function stylePart(project: Project): string {
  const style = sanitizeVisualStyle(resolveVideoStylePrompt(project.visualStyle))
  return style ? `统一视觉风格：${style}。` : ''
}

function characterPrompt(entity: Entity, project: Project, threeView: boolean): string {
  const genderLabels: Record<string, string> = {
    male: '男性角色',
    female: '女性角色',
    other: '非人类角色',
    unknown: '',
  }
  const gender = typeof entity.metadata.gender === 'string' ? genderLabels[entity.metadata.gender] ?? '' : ''
  const identity = [cleanPart(entity.name), cleanPart(entity.variant)].filter(Boolean).join('，')
  const subject = `${identity || '角色'}${gender ? `（${gender}）` : ''}全身形象`
  return [
    `${subject}：${cleanPart(entity.description)}。`,
    '表情与姿态：自然表情，正对镜头站立，眼神直视镜头，双手自然下垂。',
    '背景：纯净中性背景，无场景、无道具、无其他人物。',
    threeView ? CHARACTER_THREE_VIEW_PROMPT : CHARACTER_SINGLE_VIEW_PROMPT,
    '光照均匀，高画质，手部完整，无文字、无水印、无 LOGO。',
    stylePart(project),
  ].filter(Boolean).join('\n\n')
}

function scenePrompt(entity: Entity, project: Project): string {
  const name = cleanPart(entity.name)
  const subject = name ? `${name}，空镜场景` : '空镜场景'
  return [
    `${subject}：${cleanPart(entity.description)}。`,
    '画面中不出现人物或主体角色，环境信息完整，空间关系清晰。',
    '画面干净，清晰度高，细节清晰，专业摄影构图，无文字、无水印、无 LOGO。',
    stylePart(project),
  ].filter(Boolean).join('\n\n')
}

function propPrompt(entity: Entity, project: Project, threeView: boolean): string {
  const name = cleanPart(entity.name)
  const subject = name ? `${name}特写` : '道具特写'
  return [
    `${subject}：${cleanPart(entity.description)}。`,
    '背景：纯净中性背景，无手持者、无其他物体。',
    threeView ? PROP_THREE_VIEW_PROMPT : PROP_SINGLE_VIEW_PROMPT,
    '高清精致，光照均匀，材质和结构细节清晰，无文字、无水印、无 LOGO。',
    stylePart(project),
  ].filter(Boolean).join('\n\n')
}

export function buildEntityImagePrompt(entity: Entity, project: Project, threeView: boolean): string {
  if (entity.kind === 'character') return characterPrompt(entity, project, threeView)
  if (entity.kind === 'scene') return scenePrompt(entity, project)
  return propPrompt(entity, project, threeView)
}

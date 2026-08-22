import { describe, expect, it } from 'vitest'
import {
  auditSkill,
  CREATION_SKILLS,
  evaluateSkillResult,
} from './test-skill'

describe('短剧创作 Skill 质量测试器', () => {
  it.each(CREATION_SKILLS)('%s 通过专业合同审计', async skill => {
    const report = await auditSkill(skill)
    expect(report.passed, report.checks.filter(check => !check.passed).map(check => check.label).join('；')).toBe(true)
  })

  it('识别满足绝对集号、场次和资产解耦要求的续写结果', () => {
    const content = Array.from({ length: 10 }, (_, index) => (
      `[${index + 1}] 内 地点${index + 1} 日\n人物：顾沉、周宁\n△ 顾沉把证据放到桌面，周宁立即看向文件。\n顾沉（冷静）：「这一次，证据不会再消失。」`
    )).join('\n\n')
    const result = {
      project: { title: '归来', synopsis: '顾沉继续追查旧案。', genre: '重生复仇' },
      episodes: [{ episodeNumber: 11, title: '证据', content }],
      characters: [{
        name: '顾沉', variant: '默认形象', role: 'protagonist', gender: 'male',
        voiceDescription: '青年男声，音调中低，吐字克制，气息稳定',
        description: '黑色短发，眉骨清晰，深灰西装，正面全身中性站姿，双手自然下垂',
        episodes: [11],
      }],
      scenes: [{
        name: '会议室_白天', episodes: [11],
        description: '平视机位，长桌位于中央，灰色石材地面，落地窗引入冷白日光，空间层次清晰',
      }],
      props: [{
        name: '旧文件袋', category: 'item', episodes: [11],
        description: '泛黄牛皮纸文件袋，封口磨损，红色编号印章清晰，纯色中性背景',
      }],
    }
    const report = evaluateSkillResult('drama-script', result, {
      startEpisode: 11,
      episodeCount: 1,
      minScenes: 8,
      maxScenes: 15,
      finale: false,
      mustInclude: ['顾沉', '旧文件袋'],
    })
    expect(report.passed, report.checks.filter(check => !check.passed).map(check => check.label).join('；')).toBe(true)
  })

  it('拒绝时长越界且标签出现在正文中的分镜结果', () => {
    const result = {
      shots: [{
        shotOrder: 1,
        sceneName: '会议室_白天',
        characters: ['顾沉'],
        action: '顾沉出示证据',
        dialogue: '顾沉：证据在这里。',
        duration: 20,
        prompt: `素材引用与主体定义:\n- 将 @顾沉-默认形象 定义为主角「顾沉」\n- 将 @会议室_白天 定义为场景「会议室_白天」\n\n分镜提示词:\n镜头1：中景缓推，@顾沉-默认形象 说：{证据在这里。}\n\n风格与画质:\n真人写实\n\n约束条件:\n无字幕`,
      }],
    }
    const report = evaluateSkillResult('drama-shot-prompt', result)
    expect(report.passed).toBe(false)
    expect(report.checks.find(check => check.id === 'shot-duration')?.passed).toBe(false)
    expect(report.checks.find(check => check.id === 'shot-reference-scope')?.passed).toBe(false)
  })

  it('场次空行检查只计算相邻场景，不把首场前内容误判为多余分隔', () => {
    const scenes = Array.from({ length: 8 }, (_, index) => (
      `[${index + 1}] 内 急诊区${index + 1} 日\n人物：沈知微\n△ 沈知微核对第${index + 1}份记录。\n沈知微：「证据还在。」`
    )).join('\n\n')
    const result = {
      project: { title: '重启七日', synopsis: '沈知微追查事故。', genre: '重生复仇' },
      episodes: [{ episodeNumber: 1, title: '倒计时', content: `【VO（沈知微）：只剩七天。】\n\n${scenes}` }],
      characters: [],
      scenes: [],
      props: [],
    }

    const report = evaluateSkillResult('drama-script', result, { minScenes: 8, maxScenes: 15 })
    expect(report.checks.find(check => check.id === 'script-scene-spacing')?.passed).toBe(true)
  })
})

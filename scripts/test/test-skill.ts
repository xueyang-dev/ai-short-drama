#!/usr/bin/env tsx
/**
 * 短剧创作 Skill 质量测试
 *
 * audit（默认）：离线审计 script-brief、drama-script、drama-shot-prompt 的专业合同。
 * result：对已生成的 JSON 做确定性质量检查，不调用模型。
 * live：复用当前项目的 DeepSeek 生产调用链，必须显式确认可能产生费用。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSkill, loadSkillPrompt, type StandardSkill } from '../../lib/skills'
import type { EntityKind } from '../../lib/types'
import type {
  ScriptGenerationInput,
  ShortDramaSkillQualityJudgement,
} from '../../lib/providers/deepseek'

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = resolve(dirname(scriptPath), '../..')

export const CREATION_SKILLS = [
  'script-brief',
  'drama-script',
  'drama-shot-prompt',
] as const

export type CreationSkillName = typeof CREATION_SKILLS[number]
type TestMode = 'audit' | 'result' | 'live' | 'workflow'
type CheckSeverity = 'error' | 'warning'
type WorkflowResumeFrom = 'drama-script' | 'ai-judge'

export interface QualityExpectation {
  startEpisode?: number
  episodeCount?: number
  minScenes?: number
  maxScenes?: number
  finale?: boolean
  mustInclude?: string[]
  mustExclude?: string[]
}

export interface QualityCheck {
  id: string
  label: string
  severity: CheckSeverity
  weight: number
  passed: boolean
  evidence: string
}

export interface QualityReport {
  skill: CreationSkillName
  mode: 'audit' | 'result' | 'live'
  score: number
  passed: boolean
  summary: {
    passed: number
    failed: number
    errors: number
    warnings: number
  }
  checks: QualityCheck[]
}

interface CliOptions {
  mode: TestMode
  skill: CreationSkillName | 'all'
  inputPath: string | null
  resultPath: string | null
  expectationPath: string | null
  outputDir: string | null
  resumeDir: string | null
  resumeFrom: WorkflowResumeFrom
  saveArtifacts: boolean
  allowPaidCall: boolean
  json: boolean
}

interface WorkflowCase {
  name: string
  title: string
  originalBrief: string
  genre: string
  visualStyle: string
  ratio: '9:16' | '16:9'
  plannedEpisodes: number
  scriptInstruction: string
  briefMustInclude: string[]
  storyMustInclude: string[]
  mustExclude: string[]
}

interface WorkflowTiming {
  step: CreationSkillName | 'ai-judge'
  durationMs: number
}

interface WorkflowResult {
  testCase: WorkflowCase
  outputs: {
    scriptBrief: unknown
    dramaScript: unknown
    dramaShotPrompt: unknown
  }
  timings: WorkflowTiming[]
  aiJudge: ShortDramaSkillQualityJudgement
}

const DEFAULT_WORKFLOW_CASE: WorkflowCase = {
  name: '重生复仇硬约束与证据链',
  title: '重启七日',
  originalBrief: '女主沈知微，28岁急诊医生，被未婚夫贺云舟和继妹沈雨桐联手陷害，背负医疗事故后重生回婚礼前七天。必须保留祖母留下的旧怀表作为证据载体；结局必须揭露院长利益链并让沈知微重建急诊团队；禁止超能力、失忆和真千金设定。',
  genre: '重生复仇',
  visualStyle: '电影感写实',
  ratio: '9:16',
  plannedEpisodes: 12,
  scriptInstruction: '本次只创作第1集，写8–15场完整戏，默认优先采用推荐值10场。前三场内建立陷害危机和七天倒计时，旧怀表必须实际进入剧情并承载第一条可验证线索；本集只能推进第一轮反击，结尾保留强钩子，禁止剧终。',
  briefMustInclude: ['沈知微', '贺云舟', '沈雨桐', '旧怀表', '院长利益链', '重建急诊团队', '超能力', '失忆', '真千金'],
  storyMustInclude: ['沈知微', '贺云舟', '沈雨桐', '旧怀表'],
  mustExclude: ['超能力觉醒', '突然失忆', '真千金身份'],
}

interface CheckInput {
  id: string
  label: string
  passed: boolean
  evidence: string
  severity?: CheckSeverity
  weight?: number
}

function check(input: CheckInput): QualityCheck {
  return {
    severity: 'error',
    weight: 1,
    ...input,
  }
}

function summarizeReport(
  skill: CreationSkillName,
  mode: QualityReport['mode'],
  checks: QualityCheck[],
): QualityReport {
  const totalWeight = checks.reduce((sum, item) => sum + item.weight, 0)
  const passedWeight = checks.reduce((sum, item) => sum + (item.passed ? item.weight : 0), 0)
  const score = totalWeight === 0 ? 0 : Math.round((passedWeight / totalWeight) * 100)
  const failed = checks.filter(item => !item.passed)
  const errors = failed.filter(item => item.severity === 'error').length
  const warnings = failed.filter(item => item.severity === 'warning').length
  return {
    skill,
    mode,
    score,
    passed: errors === 0 && score >= 80,
    summary: {
      passed: checks.length - failed.length,
      failed: failed.length,
      errors,
      warnings,
    },
    checks,
  }
}

function hasAll(source: string, values: readonly string[]): boolean {
  return values.every(value => source.includes(value))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => Number.isInteger(item) && item > 0)
    : []
}

function readJsonValue(filePath: string): unknown {
  const resolvedPath = resolveReadablePath(filePath)
  try {
    return JSON.parse(readFileSync(resolvedPath, 'utf8'))
  } catch (error) {
    throw new Error(`JSON 文件无法解析：${resolvedPath}\n${(error as Error).message}`)
  }
}

function readJsonObject(filePath: string): Record<string, unknown> {
  const resolvedPath = resolveReadablePath(filePath)
  const parsed = readJsonValue(resolvedPath)
  const record = asRecord(parsed)
  if (!record) throw new Error(`JSON 文件根节点必须是 object：${resolvedPath}`)
  return record
}

function resolveReadablePath(filePath: string): string {
  const candidates = isAbsolute(filePath)
    ? [filePath]
    : [resolve(process.cwd(), filePath), resolve(projectRoot, filePath)]
  const resolvedPath = candidates.find(candidate => existsSync(candidate))
  if (!resolvedPath) throw new Error(`找不到文件：${filePath}`)
  return resolvedPath
}

function commonAuditChecks(skill: StandardSkill, prompt: string): QualityCheck[] {
  return [
    check({
      id: 'standard-metadata',
      label: 'Skill 使用可独立加载的标准元数据',
      passed: skill.name.length > 0 && skill.description.length > 20,
      evidence: `name=${skill.name}，description=${skill.description.length} 字符`,
    }),
    check({
      id: 'substantial-instructions',
      label: 'Skill 正文具备可执行的专业规则',
      passed: skill.instructions.length >= 1_000 && !skill.instructions.includes('[TODO'),
      evidence: `正文 ${skill.instructions.length} 字符`,
    }),
    check({
      id: 'json-contract',
      label: 'Skill 明确要求可解析 JSON 输出',
      passed: /JSON/.test(prompt) && /(只输出|严格输出|默认只输出).{0,20}(合法|可解析)/s.test(prompt),
      evidence: '检查 JSON-only 输出约束',
    }),
    check({
      id: 'configuration-independent',
      label: 'Skill frontmatter 不绑定模型、Token 或响应参数',
      passed: true,
      evidence: '已通过 loadSkill 校验：frontmatter 仅允许 name 和 description',
    }),
  ]
}

function scriptBriefAuditChecks(prompt: string): QualityCheck[] {
  return [
    check({
      id: 'preserve-hard-constraints',
      label: '需求优化必须保留人物、关系、情节、结局和禁忌',
      passed: hasAll(prompt, ['硬约束', '不得擅自替换', '指定结局', '明确禁忌']),
      evidence: '检查用户原意与硬约束保真规则',
    }),
    check({
      id: 'brief-professional-structure',
      label: 'brief 覆盖人物、故事、爽点、场景和风格',
      passed: hasAll(prompt, ['【主角设定】', '【故事框架】', '【核心冲突与爽点】', '【关键场景】', '【风格基调】']),
      evidence: '检查结构化创作需求模板',
    }),
    check({
      id: 'brief-stage-boundary',
      label: '需求优化不越权创作剧本或分镜',
      passed: hasAll(prompt, ['不写完整场次', '连续对白', '分镜', '不越过需求分析阶段']),
      evidence: '检查需求分析阶段边界',
    }),
    check({
      id: 'brief-output-shape',
      label: '输出契约包含 brief、genreDetected、tips',
      passed: hasAll(prompt, ['"brief"', '"genreDetected"', '"tips"']),
      evidence: '检查 script-brief JSON 顶层字段',
    }),
  ]
}

function dramaScriptAuditChecks(prompt: string, referenceCount: number): QualityCheck[] {
  return [
    check({
      id: 'professional-references',
      label: '编剧 Skill 预加载爽点、题材和模板资料',
      passed: referenceCount === 3 && hasAll(prompt, ['爽感 = 消极情绪 × 烈度放大 × 信息差打脸', '13 个剧本类型分析']),
      evidence: `加载 ${referenceCount} 份专业参考资料`,
    }),
    check({
      id: 'episode-range-control',
      label: '精确控制批次集数、绝对集号和计划总集数',
      passed: hasAll(prompt, ['【集数控制指令】', '本次生成集数', '计划总集数', '绝对集号', '单次最多输出 10 集']),
      evidence: '检查首次创作与分批生成合同',
    }),
    check({
      id: 'continue-and-rewrite',
      label: '支持连续续写和指定分集改写',
      passed: hasAll(prompt, ['**续写**', '**指定分集改写**', '其他已有分集不得复述或修改', '不得从 1 重新编号']),
      evidence: '检查已有剧情继承与改写范围隔离',
    }),
    check({
      id: 'finale-control',
      label: '区分非结局批次与结局批次',
      passed: hasAll(prompt, ['**非结局批次**', '**结局批次**', '【本剧终】']),
      evidence: '检查钩子、完整收尾和剧终标记',
    }),
    check({
      id: 'shootable-format',
      label: '剧本正文使用可拍摄场次、人物、动作和对白格式',
      passed: hasAll(prompt, ['[数字] 内/外 地点 晨/日/昏/夜', '人物：', '△', '角色：「台词」']),
      evidence: '检查镜头前置的标准剧本格式',
    }),
    check({
      id: 'scene-volume-and-order',
      label: '约束单集体量、连续场号和场次间距',
      passed: hasAll(prompt, ['8–15 场完整戏', '默认推荐 10 场', '禁止重号、跳号', '统一保留一个空行']),
      evidence: '检查单集体量与场次结构',
    }),
    check({
      id: 'evidence-timeline',
      label: '关键证据具备状态、时间、经手人与验证闭环',
      passed: hasAll(prompt, ['证据台账', '取得和验证不得早于', '不能只证明角色到过某处', '尚未验证的推测']),
      evidence: '检查证据形成、篡改、取得与验证的因果顺序',
    }),
    check({
      id: 'asset-separation',
      label: '角色、空镜场景和道具保持资产解耦',
      passed: hasAll(prompt, ['角色形象 = 纯净主体', '空镜场景 = 无人舞台', '道具 = 独立物件']),
      evidence: '检查三类可组合影视资产',
    }),
    check({
      id: 'voice-description',
      label: '角色档案提供文字音色描述',
      passed: hasAll(prompt, ['voiceDescription', '性别年龄感', '音调', '气息特征']),
      evidence: '检查本地版文字音色一致性合同',
    }),
    check({
      id: 'script-output-shape',
      label: '输出同时包含概要、剧本和三类资产',
      passed: hasAll(prompt, ['`summary`', '`episodes`', '`characters`', '`scenes`', '`props`']),
      evidence: '检查 drama-script 五个顶层字段',
    }),
  ]
}

function dramaShotAuditChecks(prompt: string): QualityCheck[] {
  return [
    check({
      id: 'shot-duration-and-splitting',
      label: '按剧情节拍切分 4–15 秒视频片段',
      passed: hasAll(prompt, ['4–15 秒', '剧情节拍', '低于 4 秒', '超过 15 秒']),
      evidence: '检查 Seedance 片段时长与拆分规则',
    }),
    check({
      id: 'script-fidelity',
      label: '分镜完整覆盖剧本且不增加剧情',
      passed: hasAll(prompt, ['保持剧情顺序', '不增加关键事件', '无遗漏', '无倒序']),
      evidence: '检查剧本保真规则',
    }),
    check({
      id: 'reference-binding',
      label: '精确绑定角色、场景和道具标签',
      passed: hasAll(prompt, ['@角色名-形象名', '@素材名', '素材引用与主体定义', '最多 9 张']),
      evidence: '检查本地图片引用上限和标签语义',
    }),
    check({
      id: 'text-only-voice',
      label: '声音一致性只使用 voiceDescription',
      passed: hasAll(prompt, ['voiceDescription', '本地版只使用文字音色描述', '不输出 `@音色`']),
      evidence: '检查本地版不绑定音频样本',
    }),
    check({
      id: 'prompt-sections',
      label: 'Seedance Prompt 包含固定专业段落',
      passed: hasAll(prompt, ['素材引用与主体定义:', '分镜提示词:', '音色说明:', '风格与画质:', '约束条件:']),
      evidence: '检查主体绑定、镜头、声音、风格和约束段落',
    }),
    check({
      id: 'camera-and-ratio',
      label: '同时覆盖 9:16、16:9 构图和工程运镜',
      passed: hasAll(prompt, ['### 9:16', '### 16:9', '建立镜头 → 主体跟拍 → 情绪特写 → 收束镜头']),
      evidence: '检查横竖屏导演语言',
    }),
    check({
      id: 'shot-output-shape',
      label: '输出包含可执行分镜字段',
      passed: hasAll(prompt, ['"shotOrder"', '"sceneName"', '"characters"', '"action"', '"dialogue"', '"prompt"', '"duration"']),
      evidence: '检查 drama-shot-prompt JSON 字段',
    }),
  ]
}

export async function auditSkill(skillName: CreationSkillName): Promise<QualityReport> {
  const skill = await loadSkill(skillName)
  const prompt = await loadSkillPrompt(skillName)
  const checks = commonAuditChecks(skill, prompt)
  if (skillName === 'script-brief') checks.push(...scriptBriefAuditChecks(prompt))
  if (skillName === 'drama-script') checks.push(...dramaScriptAuditChecks(prompt, skill.references.length))
  if (skillName === 'drama-shot-prompt') checks.push(...dramaShotAuditChecks(prompt))
  return summarizeReport(skillName, 'audit', checks)
}

function expectationChecks(value: unknown, expectation: QualityExpectation): QualityCheck[] {
  const serialized = JSON.stringify(value)
  const included = (expectation.mustInclude ?? []).map((required, index) => check({
    id: `must-include-${index + 1}`,
    label: `保留指定硬约束：${required}`,
    passed: serialized.includes(required),
    evidence: serialized.includes(required) ? '在输出中找到' : '输出中未找到',
  }))
  const excluded = (expectation.mustExclude ?? []).map((forbidden, index) => check({
    id: `must-exclude-${index + 1}`,
    label: `未引入禁止设定：${forbidden}`,
    passed: !serialized.includes(forbidden),
    evidence: serialized.includes(forbidden) ? '输出中发现禁止设定' : '输出中未发现',
  }))
  return [...included, ...excluded]
}

function evaluateBriefResult(value: unknown, expectation: QualityExpectation): QualityCheck[] {
  const root = asRecord(value)
  const brief = text(root?.brief)
  const tips = Array.isArray(root?.tips) ? root.tips.filter(item => text(item)) : []
  const headings = ['【主角设定】', '【主要人物】', '【故事框架】', '【核心冲突与爽点】', '【关键场景】', '【风格基调】']
  const headingCount = headings.filter(heading => brief.includes(heading)).length
  return [
    check({
      id: 'brief-root-shape',
      label: '根对象包含 brief、genreDetected、tips',
      passed: !!root && brief.length > 0 && text(root.genreDetected).length > 0 && Array.isArray(root.tips),
      evidence: root ? `字段：${Object.keys(root).join('、')}` : '根节点不是 object',
    }),
    check({
      id: 'brief-structure',
      label: '创作需求覆盖至少五个专业维度',
      passed: headingCount >= 5,
      evidence: `命中 ${headingCount}/${headings.length} 个结构标题`,
    }),
    check({
      id: 'brief-length',
      label: '创作需求达到可直接开写的有效体量',
      passed: brief.length >= 600 && brief.length <= 2_500,
      evidence: `${brief.length} 字符（建议 600–2500）`,
      severity: 'warning',
    }),
    check({
      id: 'brief-single-plan',
      label: '只给出一个确定方案',
      passed: !/(方案\s*[ABＡＢ]|方案[一二]\/|二选一)/i.test(brief),
      evidence: '检查多方案和二选一表述',
    }),
    check({
      id: 'brief-stage-boundary',
      label: '输出未越权写完整剧本或分镜',
      passed: !/^\s*\[\d+\]\s+(?:内|外)\s+/m.test(brief) && !/镜头\s*\d+[：:]/.test(brief),
      evidence: '检查场次标注和镜头编号',
    }),
    check({
      id: 'brief-tips',
      label: 'tips 提供 2–3 条有效建议',
      passed: tips.length >= 2 && tips.length <= 3,
      evidence: `${tips.length} 条建议`,
      severity: 'warning',
    }),
    ...expectationChecks(value, expectation),
  ]
}

interface SceneHeading {
  number: number
  signature: string
  lineIndex: number
}

function parseSceneHeadings(content: string): SceneHeading[] {
  return content.split(/\r?\n/).flatMap((line, lineIndex) => {
    const match = line.trim().match(/^\[(\d+)\]\s+(内|外)\s+(.+?)\s+(晨|日|昏|夜)$/)
    return match ? [{
      number: Number(match[1]),
      signature: `${match[2]}\u0000${match[3].trim()}\u0000${match[4]}`,
      lineIndex,
    }] : []
  })
}

function assetEpisodeReferences(root: Record<string, unknown>): number[] {
  const references: number[] = []
  for (const character of asRecords(root.characters)) {
    references.push(...numberArray(character.episodes))
    for (const look of asRecords(character.looks)) references.push(...numberArray(look.episodes))
  }
  for (const scene of asRecords(root.scenes)) references.push(...numberArray(scene.episodes))
  for (const prop of asRecords(root.props)) references.push(...numberArray(prop.episodes))
  return references
}

function normalizedCharacters(root: Record<string, unknown>): Array<Record<string, unknown>> {
  return asRecords(root.characters).flatMap(character => {
    const looks = asRecords(character.looks)
    if (looks.length === 0) return [character]
    return looks.map(look => ({
      ...look,
      name: character.name,
      role: character.role,
      gender: character.gender,
      introduction: character.introduction,
      voiceDescription: look.voiceDescription || character.voiceDescription,
    }))
  })
}

function evaluateDramaScriptResult(value: unknown, expectation: QualityExpectation): QualityCheck[] {
  const root = asRecord(value)
  if (!root) {
    return [check({
      id: 'script-root-shape',
      label: '剧本输出根节点是 object',
      passed: false,
      evidence: '根节点类型错误',
    })]
  }

  const rawShape = asRecord(root.summary) !== null
  const runtimeShape = asRecord(root.project) !== null
  const episodes = asRecords(root.episodes)
  const characters = normalizedCharacters(root)
  const scenes = asRecords(root.scenes)
  const props = asRecords(root.props)
  const episodeNumbers = episodes.map(episode => Number(episode.episodeNumber))
  const startEpisode = expectation.startEpisode ?? episodeNumbers[0] ?? 1
  const expectedCount = expectation.episodeCount ?? episodes.length
  const expectedNumbers = Array.from({ length: expectedCount }, (_, index) => startEpisode + index)
  const actualEpisodeSet = new Set(episodeNumbers)
  const minScenes = expectation.minScenes ?? 10
  const maxScenes = expectation.maxScenes ?? 15

  const sceneStats = episodes.map(episode => {
    const content = text(episode.content)
    const headings = parseSceneHeadings(content)
    const lines = content.split(/\r?\n/)
    const peopleLinesValid = headings.every((heading, index) => {
      const nextHeadingLine = headings[index + 1]?.lineIndex ?? lines.length
      return lines.slice(heading.lineIndex + 1, nextHeadingLine).some(line => /^人物：\S/.test(line.trim()))
    })
    const repeatedScene = headings.some((heading, index) => index > 0 && heading.signature === headings[index - 1]?.signature)
    const spacingValid = headings.slice(1).every(heading => (
      lines[heading.lineIndex - 1] === '' && lines[heading.lineIndex - 2] !== ''
    ))
    return { content, headings, peopleLinesValid, repeatedScene, spacingValid }
  })

  const references = assetEpisodeReferences(root)
  const invalidReferences = references.filter(episode => !actualEpisodeSet.has(episode))
  const invalidNames = [
    ...characters.flatMap(character => [text(character.name), text(character.variant)]),
    ...scenes.map(scene => text(scene.name)),
    ...props.map(prop => text(prop.name)),
  ]
    .filter(name => name && !/^[\p{Script=Han}A-Za-z0-9_]+$/u.test(name))
  const characterVoiceComplete = characters.length > 0 && characters.every(character => text(character.voiceDescription).length >= 4)
  const sceneDescriptionsClean = scenes.every(scene => {
    const description = text(scene.description)
    return description.length >= 20 && !/(主角|男主|女主|配角|路人|人群|正在\S*(?:走|跑|说|打|拿))/.test(description)
  })
  const invalidSceneNames = scenes
    .map(scene => text(scene.name))
    .filter(name => !/_(?:黎明|白天|黄昏|夜晚|晴朗|雨天|暴雨|雪天|雾天|阴天)$/.test(name))
  const sceneNamesValid = invalidSceneNames.length === 0
  const characterDescriptionsClean = characters.every(character => {
    const description = text(character.description)
    return description.length >= 20 && !/(手持|拿着|与\S+同框|站在\S*(?:办公室|街道|房间|大厅))/.test(description)
  })
  const propDescriptionsClean = props.every(prop => {
    const description = text(prop.description)
    return description.length >= 10 && !/(手持|拿着|被\S+握住|角色|主角)/.test(description)
  })
  const finaleMarkers = episodes.filter(episode => text(episode.content).includes('【本剧终】')).length

  return [
    check({
      id: 'script-root-shape',
      label: '根对象包含概要、分集、角色、场景和道具',
      passed: (rawShape || runtimeShape) && Array.isArray(root.episodes) && Array.isArray(root.characters)
        && Array.isArray(root.scenes) && Array.isArray(root.props),
      evidence: `${rawShape ? 'Skill 原始结构' : runtimeShape ? '应用规范化结构' : '未知结构'}；字段：${Object.keys(root).join('、')}`,
    }),
    check({
      id: 'script-episode-range',
      label: '分集数量和绝对集号精确匹配',
      passed: episodes.length === expectedCount && expectedNumbers.every((number, index) => episodeNumbers[index] === number),
      evidence: `期望 ${expectedNumbers.join('–')}，实际 ${episodeNumbers.join('、') || '无'}`,
    }),
    check({
      id: 'script-scene-volume',
      label: `每集包含 ${minScenes}–${maxScenes} 场完整戏`,
      passed: sceneStats.length > 0 && sceneStats.every(stat => stat.headings.length >= minScenes && stat.headings.length <= maxScenes),
      evidence: `各集场数：${sceneStats.map(stat => stat.headings.length).join('、') || '无'}`,
    }),
    check({
      id: 'script-scene-order',
      label: '每集场号从 [1] 连续递增',
      passed: sceneStats.length > 0 && sceneStats.every(stat => stat.headings.every((heading, index) => heading.number === index + 1)),
      evidence: '检查重号、跳号和中途重置',
    }),
    check({
      id: 'script-scene-integrity',
      label: '每场有人物行且连续相同场景没有拆场',
      passed: sceneStats.length > 0 && sceneStats.every(stat => stat.peopleLinesValid && !stat.repeatedScene),
      evidence: '检查人物行和地点/时间签名',
    }),
    check({
      id: 'script-scene-spacing',
      label: '相邻场次之间恰好保留一个空行',
      passed: sceneStats.length > 0 && sceneStats.every(stat => stat.spacingValid),
      evidence: '检查场景标注前恰好两个换行符',
    }),
    check({
      id: 'script-shootable-content',
      label: '正文包含可见动作和标准对白，且没有分镜指令',
      passed: sceneStats.length > 0 && sceneStats.every(stat => stat.content.includes('△')
        && /\S+(?:（[^\n]{1,10}）)?：「[^」]+」/.test(stat.content)
        && !/(?:镜头\s*\d+[：:]|运镜|镜头(?:缓推|拉远|摇移|切至))/.test(stat.content)),
      evidence: '检查 △ 动作、中文对白和剧本/分镜边界',
    }),
    check({
      id: 'script-finale-control',
      label: expectation.finale === undefined ? '剧终标记位置合理' : expectation.finale ? '结局批次包含【本剧终】' : '非结局批次不含剧终标记',
      passed: expectation.finale === undefined
        ? finaleMarkers <= 1 && (finaleMarkers === 0 || text(episodes.at(-1)?.content).includes('【本剧终】'))
        : expectation.finale
          ? finaleMarkers === 1 && text(episodes.at(-1)?.content).includes('【本剧终】')
          : finaleMarkers === 0,
      evidence: `检测到 ${finaleMarkers} 个【本剧终】标记`,
    }),
    check({
      id: 'script-character-assets',
      label: '角色资产有纯净形象描述和文字音色',
      passed: characters.length > 0 && characterDescriptionsClean && characterVoiceComplete,
      evidence: `${characters.length} 个角色形象；音色完整=${characterVoiceComplete}`,
    }),
    check({
      id: 'script-scene-assets',
      label: '空镜场景描述不混入人物或剧情动作',
      passed: scenes.length > 0 && sceneDescriptionsClean && sceneNamesValid,
      evidence: `${scenes.length} 个场景；解耦=${sceneDescriptionsClean}；${sceneNamesValid ? '命名合格' : `非法命名=${invalidSceneNames.join('、')}`}`,
    }),
    check({
      id: 'script-prop-assets',
      label: '道具作为独立物件描述',
      passed: propDescriptionsClean,
      evidence: `${props.length} 个道具；解耦=${propDescriptionsClean}`,
      severity: 'warning',
    }),
    check({
      id: 'script-asset-names',
      label: '资产名称可被后续标签解析',
      passed: invalidNames.length === 0,
      evidence: invalidNames.length ? `非法名称：${invalidNames.join('、')}` : '名称只含中文、字母、数字或下划线',
    }),
    check({
      id: 'script-absolute-references',
      label: '资产 episodes 只引用本批绝对集号',
      passed: references.length > 0 && invalidReferences.length === 0,
      evidence: invalidReferences.length ? `越界引用：${invalidReferences.join('、')}` : `检查 ${references.length} 个分集引用`,
    }),
    ...expectationChecks(value, expectation),
  ]
}

function promptSectionsInOrder(prompt: string): boolean {
  const sections = ['素材引用与主体定义:', '分镜提示词:', '风格与画质:', '约束条件:']
  let lastIndex = -1
  return sections.every(section => {
    const index = prompt.indexOf(section)
    if (index <= lastIndex) return false
    lastIndex = index
    return true
  })
}

function definitionSection(prompt: string): string {
  const start = prompt.indexOf('素材引用与主体定义:')
  const end = prompt.indexOf('分镜提示词:')
  return start >= 0 && end > start ? prompt.slice(start, end) : ''
}

function evaluateShotResult(value: unknown, expectation: QualityExpectation): QualityCheck[] {
  const root = asRecord(value)
  const shots = asRecords(root?.shots)
  const prompts = shots.map(shot => text(shot.prompt))
  const durations = shots.map(shot => Number(shot.duration))
  const orders = shots.map(shot => Number(shot.shotOrder))
  const promptTags = prompts.map(prompt => [...new Set(definitionSection(prompt).match(/@[\p{L}\p{N}_-]+/gu) ?? [])])
  const tagsOutsideDefinition = prompts.flatMap(prompt => {
    const section = definitionSection(prompt)
    return prompt.replace(section, '').match(/@[\p{L}\p{N}_:-]+/gu) ?? []
  })
  const dialogueShots = shots.filter(shot => text(shot.dialogue)).length
  return [
    check({
      id: 'shot-root-shape',
      label: '根对象包含非空 shots 数组',
      passed: !!root && shots.length > 0 && shots.length === (Array.isArray(root.shots) ? root.shots.length : -1),
      evidence: `${shots.length} 个可解析 shot`,
    }),
    check({
      id: 'shot-order',
      label: 'shotOrder 从 1 连续递增',
      passed: orders.length > 0 && orders.every((order, index) => order === index + 1),
      evidence: orders.join('、') || '无',
    }),
    check({
      id: 'shot-duration',
      label: '每个 duration 是 4–15 的整数',
      passed: durations.length > 0 && durations.every(duration => Number.isInteger(duration) && duration >= 4 && duration <= 15),
      evidence: durations.join('、') || '无',
    }),
    check({
      id: 'shot-prompt-sections',
      label: '每个 prompt 按专业段落顺序组织',
      passed: prompts.length > 0 && prompts.every(promptSectionsInOrder),
      evidence: '素材定义 → 分镜 → 风格画质 → 约束',
    }),
    check({
      id: 'shot-reference-limit',
      label: '每个 shot 最多引用 9 张图片',
      passed: promptTags.length > 0 && promptTags.every(tags => tags.length >= 1 && tags.length <= 9),
      evidence: `各 shot 引用数：${promptTags.map(tags => tags.length).join('、') || '无'}`,
    }),
    check({
      id: 'shot-reference-scope',
      label: '@实体标签只出现在素材定义段',
      passed: tagsOutsideDefinition.length === 0,
      evidence: tagsOutsideDefinition.length ? `定义段外标签：${tagsOutsideDefinition.join('、')}` : '未发现定义段外标签',
    }),
    check({
      id: 'shot-scene-reference',
      label: '每个 shot 都定义当前场景',
      passed: prompts.length > 0 && prompts.every(prompt => /定义为场景/.test(definitionSection(prompt))),
      evidence: '检查场景参考绑定',
    }),
    check({
      id: 'shot-camera-language',
      label: '每个 prompt 使用子镜头和工程镜头语言',
      passed: prompts.length > 0 && prompts.every(prompt => /镜头1[：:]/.test(prompt)
        && /(中景|近景|特写|全景|过肩|俯拍|仰拍|缓推|跟拍|横移|拉远|摇镜|固定机位)/.test(prompt)),
      evidence: '检查镜头编号、景别、机位或运镜',
    }),
    check({
      id: 'shot-script-dialogue',
      label: '有对白的 shot 在 prompt 中使用花括号',
      passed: dialogueShots === 0 || shots.every(shot => !text(shot.dialogue) || /\{[^}]+\}/.test(text(shot.prompt))),
      evidence: `${dialogueShots} 个 shot 声明对白`,
    }),
    check({
      id: 'shot-text-only-voice',
      label: '未输出音色或外部音频标签',
      passed: prompts.every(prompt => !/@音色|@素材音频|@素材视频|@参考视频/.test(prompt)),
      evidence: '检查本地版文字音色边界',
    }),
    check({
      id: 'shot-api-parameter-boundary',
      label: 'prompt 不重复模型、总时长或画面比例参数',
      passed: prompts.every(prompt => !/(Seedance\s*2\.0|视频时长[：:]|总时长[：:]|画面比例[：:]|(?:^|\n)比例[：:])/i.test(prompt)),
      evidence: '模型、duration 和 ratio 由 API 字段控制',
    }),
    ...expectationChecks(value, expectation),
  ]
}

export function evaluateSkillResult(
  skill: CreationSkillName,
  value: unknown,
  expectation: QualityExpectation = {},
  mode: 'result' | 'live' = 'result',
): QualityReport {
  const checks = skill === 'script-brief'
    ? evaluateBriefResult(value, expectation)
    : skill === 'drama-script'
      ? evaluateDramaScriptResult(value, expectation)
      : evaluateShotResult(value, expectation)
  return summarizeReport(skill, mode, checks)
}

function loadEnvLocal(): void {
  const envPath = resolve(projectRoot, '.env.local')
  if (!existsSync(envPath)) throw new Error('live 模式需要 .env.local')
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Z0-9_]+)=(?:"(.*)"|'(.*)'|([^#]*))$/)
    if (!match) continue
    if (process.env[match[1]] === undefined) process.env[match[1]] = (match[2] ?? match[3] ?? match[4] ?? '').trim()
  }
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = text(input[key])
  if (!value) throw new Error(`live 输入缺少字符串字段：${key}`)
  return value
}

async function executeLiveSkill(skill: CreationSkillName, input: Record<string, unknown>): Promise<unknown> {
  loadEnvLocal()
  const provider = await import('../../lib/providers/deepseek')
  if (skill === 'script-brief') {
    return provider.optimizeScriptBrief({
      brief: requiredString(input, 'brief'),
      title: text(input.title) || undefined,
      genre: requiredString(input, 'genre'),
      visualStyle: requiredString(input, 'visualStyle'),
      ratio: requiredString(input, 'ratio'),
    })
  }
  if (skill === 'drama-script') {
    return provider.generateScript(input as unknown as ScriptGenerationInput)
  }
  return provider.generateStoryboard(input as unknown as {
    episodeNumber: number
    episodeTitle: string
    episodeContent: string
    visualStyle: string
    ratio: string
    entities: Array<{
      name: string
      variant: string
      kind: EntityKind
      description: string
      role?: string
      voiceDescription?: string
    }>
  })
}

function workflowCaseFromInput(input: Record<string, unknown> | null): WorkflowCase {
  if (!input) return DEFAULT_WORKFLOW_CASE
  const ratio = text(input.ratio) || DEFAULT_WORKFLOW_CASE.ratio
  if (ratio !== '9:16' && ratio !== '16:9') throw new Error('workflow ratio 只支持 9:16 或 16:9')
  const plannedEpisodes = Number(input.plannedEpisodes ?? DEFAULT_WORKFLOW_CASE.plannedEpisodes)
  if (!Number.isInteger(plannedEpisodes) || plannedEpisodes < 1) throw new Error('workflow plannedEpisodes 必须是正整数')
  const stringList = (key: keyof WorkflowCase, fallback: string[]): string[] => {
    const value = input[key]
    if (value === undefined) return fallback
    if (!Array.isArray(value) || value.some(item => !text(item))) throw new Error(`workflow ${key} 必须是非空字符串数组`)
    return value.map(item => text(item))
  }
  return {
    name: text(input.name) || DEFAULT_WORKFLOW_CASE.name,
    title: text(input.title) || DEFAULT_WORKFLOW_CASE.title,
    originalBrief: requiredString(input, 'originalBrief'),
    genre: text(input.genre) || DEFAULT_WORKFLOW_CASE.genre,
    visualStyle: text(input.visualStyle) || DEFAULT_WORKFLOW_CASE.visualStyle,
    ratio,
    plannedEpisodes,
    scriptInstruction: text(input.scriptInstruction) || DEFAULT_WORKFLOW_CASE.scriptInstruction,
    briefMustInclude: stringList('briefMustInclude', DEFAULT_WORKFLOW_CASE.briefMustInclude),
    storyMustInclude: stringList('storyMustInclude', DEFAULT_WORKFLOW_CASE.storyMustInclude),
    mustExclude: stringList('mustExclude', DEFAULT_WORKFLOW_CASE.mustExclude),
  }
}

async function runTimedStep<T>(
  step: WorkflowTiming['step'],
  timings: WorkflowTiming[],
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  console.log(`\n▶ 真实调用：${step}`)
  try {
    return await operation()
  } finally {
    const durationMs = Date.now() - startedAt
    timings.push({ step, durationMs })
    console.log(`  完成：${(durationMs / 1000).toFixed(1)}s`)
  }
}

function saveWorkflowCheckpoint(
  outputDir: string | null,
  skill: CreationSkillName,
  result: unknown,
  report: QualityReport,
  timings: WorkflowTiming[],
): void {
  if (!outputDir) return
  mkdirSync(outputDir, { recursive: true })
  writeJson(resolve(outputDir, `${skill}-result.json`), result)
  writeJson(resolve(outputDir, `${skill}-quality-report.json`), report)
  writeJson(resolve(outputDir, 'timings.json'), timings)
}

function requireWorkflowGate(report: QualityReport, outputDir: string | null): void {
  if (report.passed) return
  const failures = report.checks
    .filter(item => !item.passed && item.severity === 'error')
    .map(item => `${item.label}（${item.evidence}）`)
  const artifactHint = outputDir ? `；失败产物：${outputDir}` : ''
  throw new Error(`${report.skill} 未通过独立质量门禁：${failures.join('；') || `得分 ${report.score}`}${artifactHint}`)
}

async function executeWorkflowCase(
  testCase: WorkflowCase,
  outputDir: string | null,
  resumeSourceDir: string | null = null,
): Promise<{
  reports: QualityReport[]
  result: WorkflowResult
}> {
  loadEnvLocal()
  const provider = await import('../../lib/providers/deepseek')
  const timings: WorkflowTiming[] = resumeSourceDir
    ? readCheckpointTimings(resumeSourceDir).filter(timing => timing.step === 'script-brief')
    : []
  if (outputDir) {
    mkdirSync(outputDir, { recursive: true })
    writeJson(resolve(outputDir, 'test-case.json'), testCase)
  }

  const scriptBriefResult = resumeSourceDir
    ? readJsonObject(resolve(resumeSourceDir, 'script-brief-result.json'))
    : await runTimedStep('script-brief', timings, () => provider.optimizeScriptBrief({
        brief: testCase.originalBrief,
        title: testCase.title,
        genre: testCase.genre,
        visualStyle: testCase.visualStyle,
        ratio: testCase.ratio,
      }))
  const scriptBriefReport = evaluateSkillResult('script-brief', scriptBriefResult, {
    mustInclude: testCase.briefMustInclude,
  }, 'live')
  saveWorkflowCheckpoint(outputDir, 'script-brief', scriptBriefResult, scriptBriefReport, timings)
  requireWorkflowGate(scriptBriefReport, outputDir)

  const dramaScriptResult = await runTimedStep('drama-script', timings, () => provider.generateScript({
    title: testCase.title,
    brief: requiredString(scriptBriefResult, 'brief'),
    genre: testCase.genre,
    visualStyle: testCase.visualStyle,
    ratio: testCase.ratio,
    episodeCount: 1,
    plannedEpisodes: testCase.plannedEpisodes,
    mode: 'generate',
    startEpisode: 1,
    instruction: testCase.scriptInstruction,
    isFinale: false,
  }))
  const dramaScriptReport = evaluateSkillResult('drama-script', dramaScriptResult, {
    startEpisode: 1,
    episodeCount: 1,
    minScenes: 8,
    maxScenes: 15,
    finale: false,
    mustInclude: testCase.storyMustInclude,
    mustExclude: testCase.mustExclude,
  }, 'live')
  saveWorkflowCheckpoint(outputDir, 'drama-script', dramaScriptResult, dramaScriptReport, timings)
  requireWorkflowGate(dramaScriptReport, outputDir)

  const episode = dramaScriptResult.episodes[0]
  if (!episode) throw new Error('drama-script 没有返回第 1 集，无法继续测试分镜 Skill')
  const entities = [
    ...dramaScriptResult.characters.map(character => ({
      name: character.name,
      variant: character.variant,
      kind: 'character' as const,
      description: character.description,
      role: character.role,
      voiceDescription: character.voiceDescription,
    })),
    ...dramaScriptResult.scenes.map(scene => ({
      name: scene.name,
      variant: '',
      kind: 'scene' as const,
      description: scene.description,
    })),
    ...dramaScriptResult.props.map(prop => ({
      name: prop.name,
      variant: '',
      kind: 'prop' as const,
      description: prop.description,
    })),
  ]
  const dramaShotPromptResult = await runTimedStep('drama-shot-prompt', timings, () => provider.generateStoryboard({
    episodeNumber: episode.episodeNumber,
    episodeTitle: episode.title,
    episodeContent: episode.content,
    visualStyle: testCase.visualStyle,
    ratio: testCase.ratio,
    entities,
  }))
  const dramaShotPromptReport = evaluateSkillResult('drama-shot-prompt', dramaShotPromptResult, {
    mustInclude: testCase.storyMustInclude.filter(item => JSON.stringify(episode).includes(item)),
    mustExclude: testCase.mustExclude,
  }, 'live')
  saveWorkflowCheckpoint(outputDir, 'drama-shot-prompt', dramaShotPromptResult, dramaShotPromptReport, timings)
  requireWorkflowGate(dramaShotPromptReport, outputDir)
  const reports = [scriptBriefReport, dramaScriptReport, dramaShotPromptReport]

  const aiJudge = await runTimedStep('ai-judge', timings, () => provider.judgeShortDramaSkillQuality({
    caseDescription: JSON.stringify(testCase),
    scriptBriefResult,
    dramaScriptResult,
    dramaShotPromptResult,
    deterministicReports: reports,
  }))
  if (outputDir) {
    writeJson(resolve(outputDir, 'ai-judge.json'), aiJudge)
    writeJson(resolve(outputDir, 'timings.json'), timings)
  }

  return {
    reports,
    result: {
      testCase,
      outputs: { scriptBrief: scriptBriefResult, dramaScript: dramaScriptResult, dramaShotPrompt: dramaShotPromptResult },
      timings,
      aiJudge,
    },
  }
}

function readCheckpointTimings(outputDir: string): WorkflowTiming[] {
  const timingPath = resolve(outputDir, 'timings.json')
  if (!existsSync(timingPath)) return []
  const value = readJsonValue(timingPath)
  if (!Array.isArray(value)) return []
  const allowedSteps = new Set<WorkflowTiming['step']>([...CREATION_SKILLS, 'ai-judge'])
  return value.flatMap(item => {
    const record = asRecord(item)
    const step = text(record?.step) as WorkflowTiming['step']
    const durationMs = Number(record?.durationMs)
    return allowedSteps.has(step) && Number.isFinite(durationMs) && durationMs >= 0
      ? [{ step, durationMs }]
      : []
  })
}

async function resumeWorkflowJudge(testCase: WorkflowCase, outputDir: string): Promise<{
  reports: QualityReport[]
  result: WorkflowResult
}> {
  loadEnvLocal()
  const provider = await import('../../lib/providers/deepseek')
  const scriptBriefResult = readJsonObject(resolve(outputDir, 'script-brief-result.json'))
  const dramaScriptResult = readJsonObject(resolve(outputDir, 'drama-script-result.json'))
  const dramaShotPromptResult = readJsonObject(resolve(outputDir, 'drama-shot-prompt-result.json'))
  const episode = asRecords(dramaScriptResult.episodes)[0]
  if (!episode) throw new Error('检查点中的 drama-script 没有第 1 集')

  const reports = [
    evaluateSkillResult('script-brief', scriptBriefResult, {
      mustInclude: testCase.briefMustInclude,
    }, 'live'),
    evaluateSkillResult('drama-script', dramaScriptResult, {
      startEpisode: 1,
      episodeCount: 1,
      minScenes: 8,
      maxScenes: 15,
      finale: false,
      mustInclude: testCase.storyMustInclude,
      mustExclude: testCase.mustExclude,
    }, 'live'),
    evaluateSkillResult('drama-shot-prompt', dramaShotPromptResult, {
      mustInclude: testCase.storyMustInclude.filter(item => JSON.stringify(episode).includes(item)),
      mustExclude: testCase.mustExclude,
    }, 'live'),
  ]
  reports.forEach(report => requireWorkflowGate(report, outputDir))

  const timings = readCheckpointTimings(outputDir).filter(timing => timing.step !== 'ai-judge')
  const aiJudge = await runTimedStep('ai-judge', timings, () => provider.judgeShortDramaSkillQuality({
    caseDescription: JSON.stringify(testCase),
    scriptBriefResult,
    dramaScriptResult,
    dramaShotPromptResult,
    deterministicReports: reports,
  }))
  writeJson(resolve(outputDir, 'ai-judge.json'), aiJudge)
  writeJson(resolve(outputDir, 'timings.json'), timings)

  return {
    reports,
    result: {
      testCase,
      outputs: { scriptBrief: scriptBriefResult, dramaScript: dramaScriptResult, dramaShotPrompt: dramaShotPromptResult },
      timings,
      aiJudge,
    },
  }
}

function aiJudgePassed(judgement: ShortDramaSkillQualityJudgement): boolean {
  return judgement.workflow.score >= 75
    && (judgement.workflow.verdict === 'pass' || judgement.workflow.verdict === 'excellent')
    && judgement.workflow.blockingIssues.length === 0
}

function parseSkill(value: string): CreationSkillName | 'all' {
  if (value === 'all') return value
  if ((CREATION_SKILLS as readonly string[]).includes(value)) return value as CreationSkillName
  throw new Error(`未知创作 Skill：${value}\n可用值：all、${CREATION_SKILLS.join('、')}`)
}

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${option} 缺少参数值`)
  return value
}

function showHelp(): never {
  console.log(`
用法: npx tsx scripts/test/test-skill.ts [all|skill名称] [选项]

模式:
  audit（默认）  离线审计创作 Skill 的专业合同，不调用 AI
  result          对已有模型 JSON 做确定性质量评分
  live            复用当前 DeepSeek 生产调用链，再对结果评分
  workflow        依次真实调用三个 Skill，并增加 AI 专业评审

选项:
  --mode <mode>       audit | result | live | workflow
  --result <path>     result 模式的模型输出 JSON
  --input <path>      live 输入，或覆盖 workflow 内置测试案例的 JSON
  --resume <dir>      workflow 从已通过三步门禁的检查点仅重试 AI 评审
  --resume-from <step>  从 drama-script 重新生成下游，或仅重试 ai-judge（默认）
  --expect <path>     可选质量期望 JSON
  --output <dir>      指定测试产物目录
  --no-save           不保存报告和输入输出快照
  --json              只向 stdout 输出 JSON 报告
  --allow-paid-call   确认 live 模式会真实调用模型并可能产生费用
  -h, --help          显示帮助

质量期望示例:
  {
    "startEpisode": 11,
    "episodeCount": 3,
    "minScenes": 10,
    "maxScenes": 15,
    "finale": false,
    "mustInclude": ["顾沉", "旧怀表"]
  }

示例:
  npm run test:skills
  npx tsx scripts/test/test-skill.ts drama-script --mode result --result result.json --expect expectation.json
  npx tsx scripts/test/test-skill.ts drama-script --mode live --input runtime-input.json --expect expectation.json --allow-paid-call
  npm run test:skills:live
  npx tsx scripts/test/test-skill.ts --mode workflow --resume skills/skill-quality-workspace/test-skill/<run> --allow-paid-call
  npx tsx scripts/test/test-skill.ts --mode workflow --resume <run> --resume-from drama-script --allow-paid-call

live/workflow 不属于 npm test；只有显式传入 --allow-paid-call 才会触网。
`)
  process.exit(0)
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)
  if (args.includes('-h') || args.includes('--help')) showHelp()
  let mode: TestMode = 'audit'
  let skill: CreationSkillName | 'all' = 'all'
  let inputPath: string | null = null
  let resultPath: string | null = null
  let expectationPath: string | null = null
  let outputDir: string | null = null
  let resumeDir: string | null = null
  let resumeFrom: WorkflowResumeFrom = 'ai-judge'
  let saveArtifacts = true
  let allowPaidCall = false
  let json = false
  const positional: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--mode') {
      const value = optionValue(args, index, arg)
      if (value !== 'audit' && value !== 'result' && value !== 'live' && value !== 'workflow') throw new Error(`未知模式：${value}`)
      mode = value
      index++
    } else if (arg === '--input') {
      inputPath = optionValue(args, index, arg)
      index++
    } else if (arg === '--result') {
      resultPath = optionValue(args, index, arg)
      index++
    } else if (arg === '--expect') {
      expectationPath = optionValue(args, index, arg)
      index++
    } else if (arg === '--output') {
      outputDir = optionValue(args, index, arg)
      index++
    } else if (arg === '--resume') {
      resumeDir = optionValue(args, index, arg)
      index++
    } else if (arg === '--resume-from') {
      const value = optionValue(args, index, arg)
      if (value !== 'drama-script' && value !== 'ai-judge') throw new Error(`未知恢复步骤：${value}`)
      resumeFrom = value
      index++
    } else if (arg === '--no-save') {
      saveArtifacts = false
    } else if (arg === '--allow-paid-call') {
      allowPaidCall = true
    } else if (arg === '--json') {
      json = true
    } else if (arg.startsWith('--')) {
      throw new Error(`未知选项：${arg}`)
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 1) throw new Error('只能指定一个 Skill 名称')
  if (positional[0]) skill = parseSkill(positional[0])
  if (resultPath && mode === 'audit') mode = 'result'
  if (mode === 'result' && !resultPath) throw new Error('result 模式必须提供 --result')
  if (mode === 'live' && !inputPath) throw new Error('live 模式必须提供 --input')
  if ((mode === 'result' || mode === 'live') && skill === 'all') throw new Error(`${mode} 模式必须指定一个 Skill`)
  if (mode === 'workflow' && skill !== 'all') throw new Error('workflow 模式固定测试完整创作链，请使用 all 或省略 Skill 名称')
  if (resumeDir && mode !== 'workflow') throw new Error('--resume 仅用于 workflow 模式')
  if (!resumeDir && resumeFrom !== 'ai-judge') throw new Error('--resume-from 必须与 --resume 一起使用')
  if (resumeDir && resumeFrom === 'ai-judge' && outputDir) throw new Error('仅重试 ai-judge 时不能指定新的 --output')
  if (resumeDir && !saveArtifacts) throw new Error('--resume 需要保存 AI 评审结果，不能与 --no-save 同时使用')
  if ((mode === 'live' || mode === 'workflow') && !allowPaidCall) {
    throw new Error(`${mode} 模式会真实调用模型并可能产生费用；确认后追加 --allow-paid-call`)
  }
  if (mode !== 'live' && mode !== 'workflow' && allowPaidCall) throw new Error('--allow-paid-call 仅用于 live/workflow 模式')

  return { mode, skill, inputPath, resultPath, expectationPath, outputDir, resumeDir, resumeFrom, saveArtifacts, allowPaidCall, json }
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
}

function resolveOutputDir(options: CliOptions): string {
  if (options.outputDir) return isAbsolute(options.outputDir) ? options.outputDir : resolve(projectRoot, options.outputDir)
  const workspaceName = options.skill === 'all' ? 'skill-quality' : options.skill
  return resolve(projectRoot, 'skills', `${workspaceName}-workspace`, 'test-skill', `${timestampForPath()}-${options.mode}`)
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function saveArtifacts(
  options: CliOptions,
  reports: QualityReport[],
  input: Record<string, unknown> | null,
  result: unknown,
  expectation: QualityExpectation,
  overallPassed: boolean,
  resolvedOutputDir: string | null = null,
): string | null {
  if (!options.saveArtifacts) return null
  const outputDir = resolvedOutputDir ?? resolveOutputDir(options)
  mkdirSync(outputDir, { recursive: true })
  writeJson(resolve(outputDir, 'run-summary.json'), {
    mode: options.mode,
    skill: options.skill,
    createdAt: new Date().toISOString(),
    passed: overallPassed,
  })
  writeJson(resolve(outputDir, 'quality-report.json'), reports.length === 1 ? reports[0] : reports)
  if (Object.keys(expectation).length) writeJson(resolve(outputDir, 'expectation.json'), expectation)
  if (input) writeJson(resolve(outputDir, 'input.json'), input)
  if (result !== undefined) writeJson(resolve(outputDir, 'result.json'), result)
  const workflow = result as WorkflowResult | undefined
  if (workflow?.outputs && workflow.aiJudge) {
    writeJson(resolve(outputDir, 'script-brief-result.json'), workflow.outputs.scriptBrief)
    writeJson(resolve(outputDir, 'drama-script-result.json'), workflow.outputs.dramaScript)
    writeJson(resolve(outputDir, 'drama-shot-prompt-result.json'), workflow.outputs.dramaShotPrompt)
    writeJson(resolve(outputDir, 'ai-judge.json'), workflow.aiJudge)
    writeJson(resolve(outputDir, 'timings.json'), workflow.timings)
  }
  return outputDir
}

function printReport(report: QualityReport): void {
  console.log(`\n${report.passed ? '✅' : '❌'} ${report.skill} — ${report.mode} ${report.score} 分`)
  for (const item of report.checks) {
    const icon = item.passed ? '  ✓' : item.severity === 'warning' ? '  ⚠' : '  ✗'
    console.log(`${icon} ${item.label} — ${item.evidence}`)
  }
  console.log(`  通过 ${report.summary.passed}/${report.checks.length}；错误 ${report.summary.errors}；警告 ${report.summary.warnings}`)
}

async function run(): Promise<void> {
  const options = parseArgs()
  const expectation = options.expectationPath
    ? readJsonObject(options.expectationPath) as QualityExpectation
    : {}
  let input: Record<string, unknown> | null = null
  let result: unknown
  let reports: QualityReport[]
  let workflowResult: WorkflowResult | null = null
  let workflowOutputDir: string | null = null

  if (options.mode === 'audit') {
    const skillNames = options.skill === 'all' ? CREATION_SKILLS : [options.skill]
    reports = await Promise.all(skillNames.map(auditSkill))
  } else if (options.mode === 'result') {
    result = readJsonObject(options.resultPath!)
    reports = [evaluateSkillResult(options.skill as CreationSkillName, result, expectation, 'result')]
  } else if (options.mode === 'live') {
    input = readJsonObject(options.inputPath!)
    result = await executeLiveSkill(options.skill as CreationSkillName, input)
    reports = [evaluateSkillResult(options.skill as CreationSkillName, result, expectation, 'live')]
  } else {
    input = options.inputPath ? readJsonObject(options.inputPath) : null
    const resumeSourceDir = options.resumeDir ? resolveReadablePath(options.resumeDir) : null
    workflowOutputDir = options.resumeDir && options.resumeFrom === 'ai-judge'
      ? resumeSourceDir
      : options.saveArtifacts ? resolveOutputDir(options) : null
    const testCase = workflowCaseFromInput(input)
    const workflow = options.resumeDir && options.resumeFrom === 'ai-judge'
      ? await resumeWorkflowJudge(testCase, workflowOutputDir!)
      : await executeWorkflowCase(testCase, workflowOutputDir, resumeSourceDir)
    reports = workflow.reports
    workflowResult = workflow.result
    result = workflow.result
  }

  const overallPassed = reports.every(report => report.passed)
    && (!workflowResult || aiJudgePassed(workflowResult.aiJudge))
  const outputDir = saveArtifacts(options, reports, input, result, expectation, overallPassed, workflowOutputDir)
  if (options.json) {
    console.log(JSON.stringify(workflowResult ?? (reports.length === 1 ? reports[0] : reports), null, 2))
  } else {
    reports.forEach(printReport)
    if (workflowResult) {
      const judgement = workflowResult.aiJudge
      console.log('\nAI 专业评审：')
      console.log(`  script-brief: ${judgement.skills.scriptBrief.score} 分`)
      console.log(`  drama-script: ${judgement.skills.dramaScript.score} 分`)
      console.log(`  drama-shot-prompt: ${judgement.skills.dramaShotPrompt.score} 分`)
      console.log(`  工作流总分: ${judgement.workflow.score} 分（${judgement.workflow.verdict}）`)
      judgement.workflow.blockingIssues.forEach(issue => console.log(`  阻断问题: ${issue}`))
      judgement.workflow.recommendations.forEach(item => console.log(`  改进建议: ${item}`))
    }
    console.log(`\n总体状态：${overallPassed ? '✅ 符合预期' : '❌ 未达到质量门槛'}`)
    if (outputDir) console.log(`测试产物：${outputDir}`)
  }
  if (!overallPassed) process.exitCode = 1
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === scriptPath : false
if (isMain) {
  void run().catch(error => {
    console.error(`\n❌ ${(error as Error).message}`)
    process.exitCode = 1
  })
}

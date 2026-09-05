import { describe, expect, it } from 'vitest'
import {
  LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
  LOCAL_LLM_DEFAULT_MODEL,
} from './model-config'

describe('模型配置', () => {
  it('默认使用本地 Qwen，并保留可配置输出上限', () => {
    expect(LOCAL_LLM_DEFAULT_MODEL).toBe('qwen/qwen3.5-9b')
    expect(LOCAL_LLM_DEFAULT_MAX_OUTPUT_TOKENS).toBe(32_768)
  })
})

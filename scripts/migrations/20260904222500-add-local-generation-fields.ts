import type Database from 'better-sqlite3'
import type { DatabaseMigration } from './types'

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName))
}

function addMissingColumns(db: Database.Database, tableName: string, definitions: Record<string, string>): void {
  if (!tableExists(db, tableName)) return
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  const names = new Set(columns.map(column => column.name))
  Object.entries(definitions).forEach(([name, definition]) => {
    if (!names.has(name)) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`)
  })
}

const migration: DatabaseMigration = {
  id: '20260904222500-add-local-generation-fields',
  description: '增加本地 H3 镜头参数、生成快照和可切换角色语音配置',
  up(db) {
    addMissingColumns(db, 'shots', {
      dialogue: "TEXT NOT NULL DEFAULT ''",
      reference_image_path: 'TEXT',
      width: 'INTEGER NOT NULL DEFAULT 768',
      height: 'INTEGER NOT NULL DEFAULT 1280',
      seed: 'INTEGER NOT NULL DEFAULT 0',
      video_provider: "TEXT NOT NULL DEFAULT 'local-comfyui'",
      h3_model: "TEXT NOT NULL DEFAULT 'MiniMax-H3/minimax_h3_fl2va_pruned_int8_convrot.safetensors'",
      h3_preset: "TEXT NOT NULL DEFAULT 'fl2va-turbo-4'",
      turbo_mode: 'INTEGER NOT NULL DEFAULT 1',
    })

    addMissingColumns(db, 'shot_videos', {
      provider: "TEXT NOT NULL DEFAULT 'local-comfyui'",
      preset: "TEXT NOT NULL DEFAULT ''",
      width: 'INTEGER NOT NULL DEFAULT 0',
      height: 'INTEGER NOT NULL DEFAULT 0',
      seed: 'INTEGER NOT NULL DEFAULT 0',
      workflow_version: "TEXT NOT NULL DEFAULT ''",
      reference_image_path: 'TEXT',
    })

    addMissingColumns(db, 'entities', {
      voice_reference_path: 'TEXT',
      voice_reference_transcript: "TEXT NOT NULL DEFAULT ''",
      speech_provider: "TEXT NOT NULL DEFAULT 'local-namaa'",
      speech_model: "TEXT NOT NULL DEFAULT ''",
    })
  },
}

export default migration

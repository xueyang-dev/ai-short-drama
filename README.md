# Arabic Short Drama Studio

A Windows-first, fully local short-drama workstation. It keeps script, character, scene, prop, storyboard, TAKE selection, editing, and SQLite project data in one application while local AI runtimes remain replaceable providers.

```text
Arabic story -> episode script -> local reference images -> MiniMax H3 shots
             -> Arabic dialogue WAV -> lip sync -> FFmpeg MP4
```

The application has no account system, cloud storage, billing, or cloud AI dependency. It is intended for localhost use by one creator.

## Current workflow

1. A local OpenAI-compatible LLM creates or revises scripts and storyboards.
2. The user manually uploads character, empty-scene, and prop reference images.
3. Local ComfyUI runs application-owned MiniMax H3 API workflows.
4. Every shot stores reference image, prompt, dimensions, duration, seed, checkpoint, preset, and turbo mode.
5. Generated MP4 files are copied into the local media library. Multiple TAKEs remain available and one can be selected for editing.
6. FFmpeg normalizes and concatenates selected shots for export.

NAMAA Arabic speech and MuseTalk lip sync use independent localhost workers. Their provider and database contracts are model-switchable; they never reuse ComfyUI's embedded Python or PyTorch environment.

## H3 presets

The versioned `workflows/minimax-h3/v1/workflow-api.json` file is an API-format template, not a ComfyUI UI export.

| Preset | Checkpoint family | Steps | Turbo LoRA |
| --- | --- | ---: | --- |
| `fl2va-base` | FL2VA | 20 | none |
| `fl2va-turbo-4` | FL2VA | 4 | FL2V Turbo 4 |
| `fl2va-turbo-8` | FL2VA | 8 | FL2V Turbo 8 |
| `ref2va` | REF2VA | 20 | none |

PinkCherry is an FL2VA checkpoint variant and is not a separate provider.

## Requirements

- Windows 10/11
- Node.js 22 (the tested version is in `.node-version`)
- npm
- FFmpeg available as `ffmpeg`, or configured with `FFMPEG_PATH`
- an OpenAI-compatible LLM listening on localhost
- an existing ComfyUI installation listening on localhost with MiniMax H3 Easy nodes and the configured weights

The application treats ComfyUI as an external HTTP service. It does not install into its embedded Python, update ComfyUI/custom nodes, alter model files or startup arguments, or clean ComfyUI input/output/queue data.

## Start

```powershell
npm install
Copy-Item .env.example .env.local
npm run db:init
npm run dev
```

Open <http://localhost:3000>. Runtime status is available at <http://localhost:3000/providers> and as JSON at <http://localhost:3000/api/providers>.

Example local configuration:

```dotenv
LOCAL_LLM_BASE_URL=http://127.0.0.1:1234/v1
LOCAL_LLM_MODEL=qwen/qwen3.5-9b
LOCAL_LLM_MAX_OUTPUT_TOKENS=32768

COMFYUI_BASE_URL=http://127.0.0.1:8188
NAMAA_BASE_URL=http://127.0.0.1:8189
NAMAA_MODEL=
MUSETALK_BASE_URL=http://127.0.0.1:8190
FFMPEG_PATH=ffmpeg
```

API keys are optional and only intended for localhost services that require a local token. Non-loopback provider URLs are rejected.

## Existing database migration

Application startup does not run maintenance migrations. Stop the app, back up the data directory, then run:

```powershell
npm run db:migrate
```

Migrations are transactional, repeatable, and preserve existing project/media records.

## Storage boundary

Committed: source, configuration examples, migrations, workflow templates, and worker source.

Ignored or external: SQLite data, generated media, secrets, Python virtual environments, model weights, and caches. Keep large NAMAA/MuseTalk environments and models outside the Git repository.

## Verification

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

Automated tests mock AI calls and use temporary SQLite directories. They do not submit real ComfyUI, LLM, NAMAA, or MuseTalk jobs.

For professional cloud workflows such as novel adaptation and broader multi-model tooling, see [有彩视界](https://youcai.art).

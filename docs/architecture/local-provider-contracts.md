# Local provider architecture

This application is migrating to a Windows-first, fully local Arabic Short Drama Studio. SQLite and the existing script, entity, storyboard, take-selection, and editing user flows remain the system of record.

## Process boundary

```text
Next.js application
  |-- Local OpenAI-compatible LLM (HTTP)
  |-- Existing ComfyUI + MiniMax H3 (HTTP only)
  |-- NAMAA speech worker (independent Python environment, HTTP)
  |-- MuseTalk worker (independent Python environment, HTTP)
  `-- FFmpeg child process
```

The application owns orchestration, persistence, media ingestion, API-format workflow templates, and provider health reporting. It must not install into, update, reconfigure, or clean the existing ComfyUI installation. ComfyUI is an external localhost service.

NAMAA and MuseTalk each use their own Python environment and model/cache directory outside the Git repository. They never share ComfyUI's embedded Python or PyTorch installation.

## Provider contracts

Provider interfaces are intentionally capability-specific: structured text generation, video generation, speech synthesis, and lip sync. Each provider also implements a common health contract. Database records store provider and model identifiers so a future local implementation can replace NAMAA, MuseTalk, MiniMax H3, or the local LLM without changing workflow ownership.

## H3 preset policy

Versioned API-format workflow templates are application assets. UI-format ComfyUI exports are source material only and are never submitted directly. The initial preset IDs are `fl2va-base`, `fl2va-turbo-4`, `fl2va-turbo-8`, and `ref2va`. PinkCherry is selectable as an FL2VA checkpoint variant, never as a separate provider.

At runtime, a preset is combined with explicit per-shot reference images, prompt, width, height, duration, seed, checkpoint, and turbo mode. The provider validates the request, uploads only the selected media, submits a prompt, observes only that prompt's history, and copies the resulting MP4 into the application's media library without removing anything from ComfyUI.

## Repository storage boundary

Only source code, configuration examples, workflow templates, migrations, and worker source belong in Git. Local environments, model weights, caches, generated media, databases, and secrets remain ignored or live in externally configured directories.

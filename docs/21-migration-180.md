# 21 · Migration To Target Server

This note describes the clean migration shape for the public `jixia_debate` repository.

## Target Layout

```text
/home/ubuntu/sunsq/debateall/
  apps/
  deploy/
  docs/
  scripts/
  .env
  .venv/
  services/
    qwen3-tts-openai/
    funasr-nano-service/
  runtime/
    storage/
    logs/
```

The phdebate API and static frontend are exposed on port `12234`. ASR and TTS services stay bound to localhost and are called by the backend.

## Code And Runtime Split

Commit only source code, deploy templates, docs, tests, and non-secret examples.

Do not commit:

- `.env` files with real tokens or provider keys.
- `apps/backend/storage/` runtime SQLite, audio, exports, and auth files.
- service logs, model caches, temporary build output, or server backup archives.

## Deployment Outline

1. Install system packages: Python 3.11+, Node.js 20+, npm, supervisor, ffmpeg, git, curl, and GPU/CUDA runtime when model services run on GPU.
2. Clone or rsync the repository to `/home/ubuntu/sunsq/debateall`.
3. Create `.venv` and install backend dependencies from `apps/backend/requirements.txt`.
4. Run `npm install`, `npm --prefix apps/frontend install`, then `npm run build:frontend`.
5. Create a local `.env` from `.env.production.example` and fill only server-local secrets.
6. Install the target supervisor template from `deploy/phdebate-target-12234.supervisor.conf`.
7. Install ASR/TTS services under `services/`; download models on the target server with `HF_ENDPOINT=https://hf-mirror.com`.
8. Restart supervisor and verify `http://127.0.0.1:12234/api/health`.

The target supervisor template starts `serve_realtime_ws_compat.py` for ASR.
It uses standard FunASR `paraformer-zh` behind the same local websocket protocol
as the Fun-ASR-Nano service. Use the Nano/vLLM service only on hosts whose driver
can run the matching torch/vLLM stack for prompt embeddings.

## Health Checks

```bash
curl -fsS http://127.0.0.1:12234/api/health
curl -fsS http://127.0.0.1:12302/health
curl -fsS http://127.0.0.1:10095/health || true
```

If external access is required, open only port `12234`; keep model service ports private.

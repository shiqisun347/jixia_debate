# Jixia Debate

Jixia Debate is a live human-AI debate control system for on-site events. It provides a FastAPI backend, React frontend, realtime match state, speaker consoles, large-screen display, audience voting, agent integration, ASR/TTS adapters, and deployment templates for GPU-backed speech services.

## Main Features

- Host/admin control for match setup, phase progression, pause/resume, rollback, skip, emergency intervention, voting, and result publishing.
- Large-screen display for the current debate scene, speaker state, countdowns, transcripts, voting QR code, and published results.
- Speaker console for human debaters with controlled speaking, free-debate turns, skip/pre-request behavior, and microphone/audio archive flow.
- Agent gateway for REST/SSE agents and OpenAI-compatible model providers, with interruption, retry, manual fallback, and token/time budgeting.
- Speech pipeline for realtime ASR and TTS playback/archiving, including Qwen/FunASR deployment helpers.
- Runtime separation for SQLite state, audio, exports, logs, model cache, and secrets.

## Repository Layout

```text
apps/backend/        FastAPI API, state engine, storage, ASR/TTS/Agent services
apps/frontend/       React/Vite frontend for admin, screen, console, and voting
apps/mock_agent/     Local mock debate agent
apps/voice_agent/    Optional local voice-agent service
deploy/              Supervisor and model-service deployment templates
docs/                Architecture, API, frontend, security, testing, migration notes
scripts/             Smoke tests, browser audit, runtime backup, real-flow test
references/          Non-secret event/rules references
```

## Local Development

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r apps/backend/requirements.txt
npm install
npm --prefix apps/frontend install
cp .env.example .env
npm run dev
```

Default dev services:

- Backend: `http://127.0.0.1:8000`
- Frontend: `http://127.0.0.1:5174`
- Mock agent: `http://127.0.0.1:8100`

## Production Serve

```bash
npm run build:frontend
cd apps/backend
PYTHONPATH=. ../../.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The backend serves REST API, WebSocket, frontend static files, and SPA routes from one process after the frontend has been built.

## Checks

```bash
npm run check
npm --prefix apps/frontend audit
```

The full check runs docs validation, backend pytest, frontend Vitest, and frontend production build.

## Deployment Notes

- Keep `.env`, provider keys, server passwords, runtime SQLite, audio, exports, logs, and model caches out of Git.
- Use `docs/20-server-recovery.md` for backup/restore boundaries.
- Use `docs/21-migration-180.md` and `deploy/phdebate-target-12234.supervisor.conf` for the target-server layout and port `12234` deployment.
- The target server should download model weights directly, preferably with `HF_ENDPOINT=https://hf-mirror.com` where needed.

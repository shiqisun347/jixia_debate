#!/usr/bin/env python3
"""FunASR websocket service compatible with phdebate's local ASR protocol.

This fallback uses the standard FunASR AutoModel path instead of the
Fun-ASR-Nano vLLM path. It is intended for servers whose NVIDIA driver cannot
run the newer torch/vLLM stack required by Fun-ASR-Nano prompt embeddings.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import websockets
from funasr import AutoModel


LOG = logging.getLogger("phdebate-funasr-compat")


def _json(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False)


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    return " ".join(text.replace("\u3000", " ").split())


def _extract_text(result: Any) -> str:
    if isinstance(result, list):
        parts: list[str] = []
        for item in result:
            if isinstance(item, dict):
                parts.append(_clean_text(item.get("text") or item.get("sentence")))
            else:
                parts.append(_clean_text(item))
        return "".join(part for part in parts if part)
    if isinstance(result, dict):
        return _clean_text(result.get("text") or result.get("sentence"))
    return _clean_text(result)


@dataclass
class SessionState:
    audio: bytearray = field(default_factory=bytearray)
    started_at: float = field(default_factory=time.perf_counter)
    language: str = ""
    hotwords: str = ""


class CompatASRService:
    def __init__(self, model: str, device: str, sample_rate: int, batch_size_s: int) -> None:
        self.sample_rate = sample_rate
        self.batch_size_s = batch_size_s
        LOG.info("Loading FunASR AutoModel: model=%s device=%s", model, device)
        started = time.perf_counter()
        self.model = AutoModel(
            model=model,
            vad_model="fsmn-vad",
            punc_model="ct-punc",
            device=device,
            disable_update=True,
        )
        self._lock = asyncio.Lock()
        LOG.info("FunASR AutoModel ready in %.2fs", time.perf_counter() - started)

    async def decode(self, pcm_bytes: bytes, hotwords: str = "") -> str:
        if not pcm_bytes:
            return ""
        audio_int16 = np.frombuffer(pcm_bytes, dtype=np.int16)
        if audio_int16.size == 0:
            return ""
        audio_float = audio_int16.astype(np.float32) / 32768.0
        kwargs: dict[str, Any] = {
            "input": audio_float,
            "fs": self.sample_rate,
            "batch_size_s": self.batch_size_s,
        }
        if hotwords:
            kwargs["hotword"] = hotwords
        async with self._lock:
            result = await asyncio.to_thread(self.model.generate, **kwargs)
        return _extract_text(result)


async def handle_client(websocket: Any, service: CompatASRService) -> None:
    state = SessionState()
    await websocket.send(_json({"event": "started"}))
    LOG.info("client connected")
    try:
        async for message in websocket:
            if isinstance(message, bytes):
                state.audio.extend(message)
                continue
            command = str(message or "").strip()
            upper = command.upper()
            if upper == "START":
                state = SessionState()
                await websocket.send(_json({"event": "started"}))
            elif upper.startswith("LANGUAGE:"):
                state.language = command.split(":", 1)[1].strip()
                await websocket.send(_json({"event": "language_set", "language": state.language}))
            elif upper.startswith("HOTWORDS:"):
                state.hotwords = command.split(":", 1)[1].strip()
                await websocket.send(_json({"event": "hotwords_set"}))
            elif upper in {"STOP", "END"}:
                started = time.perf_counter()
                text = await service.decode(bytes(state.audio), hotwords=state.hotwords)
                duration_ms = int(len(state.audio) / 2 * 1000 / service.sample_rate)
                elapsed_ms = int((time.perf_counter() - started) * 1000)
                LOG.info("decoded %d bytes in %dms: %s", len(state.audio), elapsed_ms, text[:80])
                payload = {
                    "sentences": [{"text": text, "start": 0, "end": duration_ms}] if text else [],
                    "partial": "",
                    "duration_ms": duration_ms,
                    "is_final": True,
                }
                await websocket.send(_json(payload))
                await websocket.send(_json({"event": "stopped"}))
                return
            else:
                await websocket.send(_json({"event": "error", "message": f"unknown command: {command}"}))
    except websockets.ConnectionClosed:
        LOG.info("client disconnected")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=10095)
    parser.add_argument("--model", default="paraformer-zh")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--batch-size-s", type=int, default=60)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    service = CompatASRService(args.model, args.device, args.sample_rate, args.batch_size_s)
    async with websockets.serve(
        lambda websocket: handle_client(websocket, service),
        args.host,
        args.port,
        max_size=None,
        ping_interval=20,
        ping_timeout=20,
    ):
        LOG.info("FunASR compat websocket listening on ws://%s:%s", args.host, args.port)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())

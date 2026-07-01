import asyncio

from app.services.tts_live import TTSAudioPushManager


def test_tts_audio_push_manager_publishes_ordered_audio_message() -> None:
    async def run() -> None:
        manager = TTSAudioPushManager()
        stream = manager.subscribe("match_1")
        first = asyncio.create_task(stream.__anext__())
        await asyncio.sleep(0)

        await manager.publish_sentence_audio(
            match_id="match_1",
            speech_id="speech_1",
            task_id="task_1",
            speaker_id="spk_1",
            sentence_idx=2,
            mime_type="audio/wav",
            audio=b"wav-data",
            audio_url="/api/audio/chunk.wav",
            text="原始文本",
            normalized_text="规范文本",
        )

        message = await asyncio.wait_for(first, timeout=1)
        assert message["type"] == "tts.sentence_audio"
        assert message["match_id"] == "match_1"
        assert message["speech_id"] == "speech_1"
        assert message["task_id"] == "task_1"
        assert message["speaker_id"] == "spk_1"
        assert message["sentence_idx"] == 2
        assert message["audio_seq"] == 2
        assert message["mime_type"] == "audio/wav"
        assert message["size_bytes"] == len(b"wav-data")
        assert message["audio_base64"] == "d2F2LWRhdGE="
        assert message["audio_url"] == "/api/audio/chunk.wav"
        assert message["text"] == "原始文本"
        assert message["normalized_text"] == "规范文本"
        await stream.aclose()

    asyncio.run(run())

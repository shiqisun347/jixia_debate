import { describe, expect, it } from "vitest";
import {
  SCREEN_TTS_PLAYBACK_RATE,
  applyScreenTtsPlaybackRate,
  buildPlaybackMetricsSummary,
  clearActiveAudio,
  clearWsAudioUrls,
  computeResumeIdx,
  decodeBase64Audio,
  observeActiveAudioProgress,
  postWithRetry,
  rememberWsSentenceAudio,
  shouldSendPlaybackHeartbeat,
} from "./usePlayback";
import type { ActiveMediaState, PlaybackPosition } from "./playbackReducer";
import type { MatchSnapshot } from "../types/contracts";

type CS = NonNullable<MatchSnapshot["current_speech"]>;
function mkCS(over: Partial<CS> = {}): CS {
  return { id: "S1", speaker_id: "spk_aff_1", source: "agent_text", ...(over as object) } as CS;
}

describe("computeResumeIdx (刷新续播起点)", () => {
  it("全新发言（无任何进度）→ 0", () => {
    expect(computeResumeIdx(mkCS(), [])).toBe(0);
  });
  it("已播 [0,1,2]、正在播 3 → 从 3 续播（不回放 0/1/2）", () => {
    expect(computeResumeIdx(mkCS({ tts_played_sentence_indices: [0, 1, 2], tts_playing_sentence_idx: 3 }), [])).toBe(3);
  });
  it("已播 [0,1,2,3]（含当前段已播完）→ 续到 4", () => {
    expect(computeResumeIdx(mkCS({ tts_played_sentence_indices: [0, 1, 2, 3] }), [])).toBe(4);
  });
  it("中间段被跳过也算已解决：已播 [0,1] + 跳过 [2] → 续到 3", () => {
    expect(computeResumeIdx(mkCS({ tts_played_sentence_indices: [0, 1] }), [2])).toBe(3);
  });
  it("旧版仅有计数 tts_played_sentences=2（无明细）→ 续到 2", () => {
    expect(computeResumeIdx(mkCS({ tts_played_sentences: 2 }), [])).toBe(2);
  });
});

function ref<T>(current: T): { current: T } {
  return { current };
}

describe("usePlayback audio cleanup", () => {
  it("clears the active audio element so a skipped segment cannot resume later", () => {
    const calls: string[] = [];
    const audio = {
      onended: () => undefined,
      onerror: () => undefined,
      onplaying: () => undefined,
      onwaiting: () => undefined,
      onstalled: () => undefined,
      oncanplay: () => undefined,
      pause: () => calls.push("pause"),
      removeAttribute: (name: string) => calls.push(`remove:${name}`),
      load: () => calls.push("load"),
    } as unknown as HTMLAudioElement;
    const activeElRef = ref<HTMLAudioElement | null>(audio);
    const activeSegmentRef = ref("speech:task:1");
    const progressRef = ref({ segment: "speech:task:1", currentTime: 3.5, atMs: 1234 });

    clearActiveAudio(activeElRef, activeSegmentRef, progressRef);

    expect(calls).toEqual(["pause", "remove:src", "load"]);
    expect(audio.onended).toBeNull();
    expect(audio.onerror).toBeNull();
    expect(audio.onplaying).toBeNull();
    expect(audio.onwaiting).toBeNull();
    expect(audio.onstalled).toBeNull();
    expect(audio.oncanplay).toBeNull();
    expect(activeElRef.current).toBeNull();
    expect(activeSegmentRef.current).toBe("");
    expect(progressRef.current).toEqual({ segment: "", currentTime: 0, atMs: 0 });
  });

});

describe("usePlayback TTS audio websocket buffer", () => {
  it("decodes base64 audio bytes", () => {
    expect([...decodeBase64Audio("AQID/w==")]).toEqual([1, 2, 3, 255]);
  });

  it("keeps websocket audio by sentence index and removes URL fallback for the same segment", () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (() => {
      const url = `blob:test-${created.length}`;
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => revoked.push(url)) as typeof URL.revokeObjectURL;
    try {
      const ws = ref({ key: "", urls: new Map<number, string>(), ownedUrls: new Set<string>() });
      const fallback = ref({ key: "speech:task", map: new Map([[1, "/api/audio/fallback.wav"]]) });

      const result = rememberWsSentenceAudio(
        {
          type: "tts.sentence_audio",
          speech_id: "speech",
          task_id: "task",
          sentence_idx: 1,
          mime_type: "audio/wav",
          audio_base64: "AQID",
        },
        ws,
        fallback,
        "speech:task",
        0
      );

      expect(result).toEqual({ ok: true, speechId: "speech", taskId: "task", sentenceIdx: 1, url: "blob:test-0" });
      expect(ws.current.key).toBe("speech:task");
      expect(ws.current.urls.get(1)).toBe("blob:test-0");
      expect(fallback.current.map.has(1)).toBe(false);

      clearWsAudioUrls(ws.current);
      expect(revoked).toEqual(["blob:test-0"]);
      expect(ws.current.key).toBe("");
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it("rejects stale or already resolved websocket audio", () => {
    const ws = ref({ key: "", urls: new Map<number, string>(), ownedUrls: new Set<string>() });
    const fallback = ref({ key: "", map: new Map<number, string>() });

    expect(
      rememberWsSentenceAudio(
        { speech_id: "old", task_id: "task", sentence_idx: 1, audio_base64: "AQ==" },
        ws,
        fallback,
        "speech:task",
        0
      )
    ).toEqual({ ok: false, reason: "stale_speech_or_task" });

    expect(
      rememberWsSentenceAudio(
        { speech_id: "speech", task_id: "task", sentence_idx: 1, audio_base64: "AQ==" },
        ws,
        fallback,
        "speech:task",
        2
      )
    ).toEqual({ ok: false, reason: "already_resolved" });
  });
});

describe("usePlayback metrics summary", () => {
  it("summarizes audio totals, ratios, sources, and segment text", () => {
    const summary = buildPlaybackMetricsSummary(
      {
        key: "speech:task",
        match_id: "match",
        speech_id: "speech",
        task_id: "task",
        speaker_id: "speaker",
        started_at_ms: 1000,
        last_tick_ms: 5000,
        playing_ms: 2400,
        waiting_audio_ms: 600,
        stalled_ms: 300,
        idle_ms: 500,
        blocked_ms: 200,
        segments_played: 2,
        segments_skipped: 1,
        segments_media_error: 1,
        segments_ws_audio: 1,
        segments_url_fallback: 1,
        tts_audio_ws_reconnects: 2,
        tts_audio_ws_ignored_stale: 3,
        tts_audio_ws_decode_errors: 4,
        ws_arrival_lag_ms: [30, 50],
        play_attempt_to_onplaying_ms: [100],
        inter_segment_gap_ms: [80],
        last_segment_ended_at_ms: 4700,
        flushed: false,
        segments: new Map([
          [
            0,
            {
              sentence_idx: 0,
              text: "第一段",
              normalized_text: "第一段",
              text_length: 3,
              normalized_text_length: 3,
              source: "ws_audio",
              size_bytes: 1000,
              duration_s: 1.2,
              play_ms: 1200,
              wait_before_play_ms: 100,
              first_seen_at_ms: 1200,
              audio_available_at_ms: 1300,
              play_attempt_at_ms: 1400,
              playing_at_ms: 1500,
              ended_at_ms: 2700,
            },
          ],
          [
            1,
            {
              sentence_idx: 1,
              text: "第二段",
              normalized_text: "第二段。",
              text_length: 3,
              normalized_text_length: 4,
              source: "url_fallback",
              size_bytes: null,
              duration_s: 0.8,
              play_ms: 800,
              wait_before_play_ms: 200,
              first_seen_at_ms: 2800,
              audio_available_at_ms: 2900,
              play_attempt_at_ms: 3100,
              playing_at_ms: 3200,
              ended_at_ms: 4000,
            },
          ],
        ]),
      },
      "playback_done",
      5000
    );

    expect(summary.reason).toBe("playback_done");
    expect(summary.observed_ms).toBe(4000);
    expect(summary.play_ratio).toBe(0.6);
    expect(summary.waiting_audio_ratio).toBe(0.15);
    expect(summary.audio_segments_total).toBe(2);
    expect(summary.audio_total_bytes).toBe(1000);
    expect(summary.audio_total_duration_s).toBe(2);
    expect(summary.audio_ws_bytes).toBe(1000);
    expect(summary.audio_ws_segments).toBe(1);
    expect(summary.audio_url_fallback_segments).toBe(1);
    expect(summary.audio_unknown_size_segments).toBe(1);
    expect(summary.audio_sentence_indices).toEqual([0, 1]);
    expect(summary.avg_sentence_audio_ws_arrival_lag_ms).toBe(40);
    expect(summary.segments[0]).toMatchObject({ sentence_idx: 0, text: "第一段", source: "ws_audio", size_bytes: 1000 });
    expect(summary.segments[1]).toMatchObject({ sentence_idx: 1, normalized_text: "第二段。", source: "url_fallback", size_bytes: null });
  });
});

describe("usePlayback active audio progress observation", () => {
  it("refreshes the active watchdog when a long segment is still making progress", () => {
    const pos = ref<PlaybackPosition>({
      speechId: "speech",
      taskId: "task",
      nextIdx: 0,
      activeIdx: 0,
      activeStartedMs: 1000,
      waitingSinceMs: null,
      completeNotifiedKey: null,
      startNotifiedKey: "speech:task",
    });
    const audio = { currentTime: 4.25, paused: false, ended: false } as HTMLAudioElement;
    const progress = ref({ segment: "speech:task:0", currentTime: 4.0, atMs: 1000 });
    const media = ref<ActiveMediaState>("playing");

    const progressed = observeActiveAudioProgress(9000, pos, ref(audio), ref("speech:task:0"), progress, media);

    expect(progressed).toBe(true);
    expect(progress.current).toEqual({ segment: "speech:task:0", currentTime: 4.25, atMs: 9000 });
    expect(pos.current.activeStartedMs).toBe(9000);
    expect(media.current).toBe("playing");
  });

  it("ignores progress from an element that no longer belongs to the active segment", () => {
    const pos = ref<PlaybackPosition>({
      speechId: "speech",
      taskId: "task",
      nextIdx: 1,
      activeIdx: 1,
      activeStartedMs: 2000,
      waitingSinceMs: null,
      completeNotifiedKey: null,
      startNotifiedKey: "speech:task",
    });
    const audio = { currentTime: 99, paused: false, ended: false } as HTMLAudioElement;
    const progress = ref({ segment: "speech:task:1", currentTime: 1.0, atMs: 2000 });
    const media = ref<ActiveMediaState>("playing");

    const progressed = observeActiveAudioProgress(9000, pos, ref(audio), ref("speech:task:0"), progress, media);

    expect(progressed).toBe(false);
    expect(progress.current).toEqual({ segment: "speech:task:1", currentTime: 1.0, atMs: 2000 });
    expect(pos.current.activeStartedMs).toBe(2000);
    expect(media.current).toBe("playing");
  });

  it("marks a paused active element as stalled so the reducer watchdog can self-heal", () => {
    const pos = ref<PlaybackPosition>({
      speechId: "speech",
      taskId: "task",
      nextIdx: 0,
      activeIdx: 0,
      activeStartedMs: 1000,
      waitingSinceMs: null,
      completeNotifiedKey: null,
      startNotifiedKey: "speech:task",
    });
    const audio = { currentTime: 3, paused: true, ended: false } as HTMLAudioElement;
    const progress = ref({ segment: "speech:task:0", currentTime: 3, atMs: 1000 });
    const media = ref<ActiveMediaState>("playing");

    const progressed = observeActiveAudioProgress(2000, pos, ref(audio), ref("speech:task:0"), progress, media);

    expect(progressed).toBe(false);
    expect(media.current).toBe("stalled");
    expect(pos.current.activeStartedMs).toBe(1000);
  });

  it("does not report progress when currentTime is unchanged", () => {
    const pos = ref<PlaybackPosition>({
      speechId: "speech",
      taskId: "task",
      nextIdx: 0,
      activeIdx: 0,
      activeStartedMs: 1000,
      waitingSinceMs: null,
      completeNotifiedKey: null,
      startNotifiedKey: "speech:task",
    });
    const audio = { currentTime: 3, paused: false, ended: false } as HTMLAudioElement;
    const progress = ref({ segment: "speech:task:0", currentTime: 3, atMs: 1000 });
    const media = ref<ActiveMediaState>("playing");

    const progressed = observeActiveAudioProgress(9000, pos, ref(audio), ref("speech:task:0"), progress, media);

    expect(progressed).toBe(false);
    expect(pos.current.activeStartedMs).toBe(1000);
  });
});

describe("usePlayback playback heartbeat", () => {
  it("throttles heartbeat for the same segment but allows a new segment immediately", () => {
    const heartbeat = ref({ segment: "", atMs: 0 });

    expect(shouldSendPlaybackHeartbeat(1000, "speech:task:0", heartbeat, 5000)).toBe(true);
    expect(heartbeat.current).toEqual({ segment: "speech:task:0", atMs: 1000 });
    expect(shouldSendPlaybackHeartbeat(5500, "speech:task:0", heartbeat, 5000)).toBe(false);
    expect(heartbeat.current).toEqual({ segment: "speech:task:0", atMs: 1000 });
    expect(shouldSendPlaybackHeartbeat(6000, "speech:task:0", heartbeat, 5000)).toBe(true);
    expect(heartbeat.current).toEqual({ segment: "speech:task:0", atMs: 6000 });
    expect(shouldSendPlaybackHeartbeat(6100, "speech:task:1", heartbeat, 5000)).toBe(true);
    expect(heartbeat.current).toEqual({ segment: "speech:task:1", atMs: 6100 });
  });
});

describe("usePlayback screen playback rate", () => {
  it("applies a stable faster playback rate while preserving pitch", () => {
    const audio = {
      playbackRate: 1,
      preservesPitch: false,
      mozPreservesPitch: false,
      webkitPreservesPitch: false,
    } as unknown as HTMLAudioElement;

    applyScreenTtsPlaybackRate(audio);

    expect(audio.playbackRate).toBe(SCREEN_TTS_PLAYBACK_RATE);
    expect((audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch).toBe(true);
    expect((audio as HTMLAudioElement & { mozPreservesPitch?: boolean }).mozPreservesPitch).toBe(true);
    expect((audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch).toBe(true);
  });

  it("clamps playback rate to the safe browser range", () => {
    const audio = { playbackRate: 1 } as HTMLAudioElement;

    applyScreenTtsPlaybackRate(audio, 99);
    expect(audio.playbackRate).toBe(1.6);

    applyScreenTtsPlaybackRate(audio, 0.1);
    expect(audio.playbackRate).toBe(0.75);
  });
});

describe("usePlayback terminal progress reporting", () => {
  it("retries terminal playback reports after a transient network failure", async () => {
    const calls: string[] = [];
    const sender = async (path: string, body: object) => {
      calls.push(`${path}:${JSON.stringify(body)}`);
      if (calls.length < 3) throw new Error("temporary network failure");
      return { ok: true };
    };

    const ok = await postWithRetry("/done", { task_id: "task" }, 4, 0, sender);

    expect(ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("absorbs repeated terminal report failures so playback reconciliation keeps running", async () => {
    let calls = 0;
    const sender = async () => {
      calls += 1;
      throw new Error("offline");
    };

    const ok = await postWithRetry("/done", { task_id: "task" }, 3, 0, sender);

    expect(ok).toBe(false);
    expect(calls).toBe(3);
  });
});

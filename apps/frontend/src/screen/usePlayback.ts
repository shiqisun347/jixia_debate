import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { authTokenForCurrentPage, post, ttsAudioWsUrl } from "../api/client";
import type { MatchSnapshot, RealtimeMessage } from "../types/contracts";
import {
  emptyPosition,
  reconcile,
  type ActiveMediaState,
  type PlaybackPosition,
  type PlaybackSpeech,
} from "./playbackReducer";

/**
 * 大屏 TTS 播放的薄胶水：把快照/事件/1 秒看门狗三个触发器汇到一次纯函数对账（reducer），
 * 再把决策落到真实音频上。播放"逻辑"全在 reducer；这里只剩"起播/停/上报"等副作用。
 *
 * 关键点：
 *  - 快照是唯一真相；live MSE 流式已废弃（忽略 tts.sentence_stream_started）。
 *  - **单个可复用的 <audio> 元素**：每段直接 `src=url; play()`。绝不为多段并行创建多个
 *    <audio> 各自 preload —— 那会在投影机浏览器上同时打开多个取流，叠加生成期间的快照刷新
 *    撑爆「同一主机并发连接上限（HTTP/1.1 约 6）」，导致中间段音频取不到而 stall/error 连环
 *    跳过、最后"直接跳到发言结束"（线上实测：只有首段/末段取到流，中间段从未发起请求）。
 *    单元素任一时刻只占 1 个音频连接，最稳。
 *  - onended/onerror 只是优化；即便都不触发，1 秒看门狗也会按"真实播放进度"强制推进，绝不卡死。
 *  - skip/chunk 都走事件快路即时并入，缺口不必等快照刷新。
 *  - 「停止播放」靠 suppress；发言结束/换人/下一阶段靠快照对账截断。
 */
const SILENCE_URL = "/assets/silence-24k-1s.mp3";
const PLAYBACK_PROGRESS_EPSILON = 0.05;
const PLAYBACK_HEARTBEAT_MS = 5000;
const SCREEN_TTS_VOLUME = 0.86;
export const SCREEN_TTS_PLAYBACK_RATE = 1.0;
const PLAYBACK_DEBUG_ENABLED = (import.meta.env.VITE_AGENT_TTS_PLAYBACK_DEBUG ?? "").toLowerCase() === "true";

type WsAudioUrlState = { key: string; urls: Map<number, string>; ownedUrls: Set<string> };
type TtsSentenceAudioMessage = {
  type?: string;
  speech_id?: unknown;
  task_id?: unknown;
  speaker_id?: unknown;
  sentence_idx?: unknown;
  audio_seq?: unknown;
  created_at_ms?: unknown;
  mime_type?: unknown;
  size_bytes?: unknown;
  audio_base64?: unknown;
  audio_url?: unknown;
  text?: unknown;
  normalized_text?: unknown;
};

type PlaybackMetricsBucket = "playing_ms" | "waiting_audio_ms" | "stalled_ms" | "idle_ms" | "blocked_ms";
type SegmentAudioSource = "ws_audio" | "url_fallback";
type SegmentMetrics = {
  sentence_idx: number;
  text: string;
  normalized_text: string;
  text_length: number;
  normalized_text_length: number;
  source: SegmentAudioSource | "";
  size_bytes: number | null;
  duration_s: number | null;
  play_ms: number;
  wait_before_play_ms: number;
  first_seen_at_ms: number | null;
  audio_available_at_ms: number | null;
  play_attempt_at_ms: number | null;
  playing_at_ms: number | null;
  ended_at_ms: number | null;
};
type PlaybackMetrics = {
  key: string;
  match_id: string;
  speech_id: string;
  task_id: string;
  speaker_id: string;
  started_at_ms: number;
  last_tick_ms: number;
  playing_ms: number;
  waiting_audio_ms: number;
  stalled_ms: number;
  idle_ms: number;
  blocked_ms: number;
  segments_played: number;
  segments_skipped: number;
  segments_media_error: number;
  segments_ws_audio: number;
  segments_url_fallback: number;
  tts_audio_ws_reconnects: number;
  tts_audio_ws_ignored_stale: number;
  tts_audio_ws_decode_errors: number;
  ws_arrival_lag_ms: number[];
  play_attempt_to_onplaying_ms: number[];
  inter_segment_gap_ms: number[];
  last_segment_ended_at_ms: number | null;
  flushed: boolean;
  segments: Map<number, SegmentMetrics>;
};
type PlaybackMetricsSummary = {
  reason: string;
  match_id: string;
  speech_id: string;
  task_id: string;
  speaker_id: string;
  started_at_ms: number;
  ended_at_ms: number;
  observed_ms: number;
  playing_ms: number;
  waiting_audio_ms: number;
  stalled_ms: number;
  idle_ms: number;
  blocked_ms: number;
  play_ratio: number;
  waiting_audio_ratio: number;
  stalled_ratio: number;
  blocked_ratio: number;
  audio_segments_total: number;
  audio_total_bytes: number;
  audio_total_duration_s: number;
  audio_ws_bytes: number;
  audio_ws_segments: number;
  audio_url_fallback_segments: number;
  audio_unknown_size_segments: number;
  audio_sentence_indices: number[];
  segments_played: number;
  segments_skipped: number;
  segments_media_error: number;
  segments_ws_audio: number;
  segments_url_fallback: number;
  tts_audio_ws_reconnects: number;
  tts_audio_ws_ignored_stale: number;
  tts_audio_ws_decode_errors: number;
  avg_sentence_audio_ws_arrival_lag_ms: number | null;
  avg_play_attempt_to_onplaying_ms: number | null;
  avg_inter_segment_gap_ms: number | null;
  segments: Array<Omit<SegmentMetrics, "first_seen_at_ms" | "audio_available_at_ms" | "play_attempt_at_ms" | "playing_at_ms" | "ended_at_ms">>;
};

function logPlayback(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  if (level === "info" && !PLAYBACK_DEBUG_ENABLED) return;
  const payload = { event, at: new Date().toISOString(), ...fields };
  if (level === "error") {
    console.error("[agent-tts-playback]", payload);
  } else if (level === "warn") {
    console.warn("[agent-tts-playback]", payload);
  } else {
    console.info("[agent-tts-playback]", payload);
  }
  sendPlaybackLog(level, event, payload);
}

function sendPlaybackLog(level: "info" | "warn" | "error", event: string, payload: Record<string, unknown>): void {
  try {
    const token = authTokenForCurrentPage();
    void fetch(`${import.meta.env.VITE_API_BASE ?? ""}/api/client-logs/agent-tts-playback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ level, event, payload }),
      keepalive: true
    }).catch(() => undefined);
  } catch {
    /* Client log shipping must never affect playback. */
  }
}

function mediaErrorDetails(el: HTMLAudioElement): Record<string, unknown> {
  const err = el.error;
  return {
    error_code: err?.code ?? null,
    error_message: err?.message ?? "",
    network_state: el.networkState,
    ready_state: el.readyState,
    current_src: el.currentSrc || el.src,
  };
}

function metricsKey(speechId: string, taskId: string): string {
  return `${speechId}:${taskId}`;
}

function createPlaybackMetrics(matchId: string, speechId: string, taskId: string, speakerId: string, now: number): PlaybackMetrics {
  return {
    key: metricsKey(speechId, taskId),
    match_id: matchId,
    speech_id: speechId,
    task_id: taskId,
    speaker_id: speakerId,
    started_at_ms: now,
    last_tick_ms: now,
    playing_ms: 0,
    waiting_audio_ms: 0,
    stalled_ms: 0,
    idle_ms: 0,
    blocked_ms: 0,
    segments_played: 0,
    segments_skipped: 0,
    segments_media_error: 0,
    segments_ws_audio: 0,
    segments_url_fallback: 0,
    tts_audio_ws_reconnects: 0,
    tts_audio_ws_ignored_stale: 0,
    tts_audio_ws_decode_errors: 0,
    ws_arrival_lag_ms: [],
    play_attempt_to_onplaying_ms: [],
    inter_segment_gap_ms: [],
    last_segment_ended_at_ms: null,
    flushed: false,
    segments: new Map(),
  };
}

function ensureSegmentMetrics(metrics: PlaybackMetrics, sentenceIdx: number): SegmentMetrics {
  let segment = metrics.segments.get(sentenceIdx);
  if (!segment) {
    segment = {
      sentence_idx: sentenceIdx,
      text: "",
      normalized_text: "",
      text_length: 0,
      normalized_text_length: 0,
      source: "",
      size_bytes: null,
      duration_s: null,
      play_ms: 0,
      wait_before_play_ms: 0,
      first_seen_at_ms: null,
      audio_available_at_ms: null,
      play_attempt_at_ms: null,
      playing_at_ms: null,
      ended_at_ms: null,
    };
    metrics.segments.set(sentenceIdx, segment);
  }
  return segment;
}

function updateSegmentText(segment: SegmentMetrics, text: unknown, normalizedText: unknown): void {
  const raw = typeof text === "string" ? text : "";
  const normalized = typeof normalizedText === "string" ? normalizedText : raw;
  if (raw) segment.text = raw;
  if (normalized) segment.normalized_text = normalized;
  segment.text_length = segment.text.length;
  segment.normalized_text_length = segment.normalized_text.length;
}

function ensurePlaybackMetrics(
  metricsRef: MutableRefObject<PlaybackMetrics | null>,
  matchId: string,
  speechId: string,
  taskId: string,
  speakerId: string,
  now = nowEpoch()
): PlaybackMetrics {
  const key = metricsKey(speechId, taskId);
  if (!metricsRef.current || metricsRef.current.key !== key) {
    metricsRef.current = createPlaybackMetrics(matchId, speechId, taskId, speakerId, now);
  } else if (speakerId && !metricsRef.current.speaker_id) {
    metricsRef.current.speaker_id = speakerId;
  }
  return metricsRef.current;
}

function markMetricsAudioAvailable(
  metrics: PlaybackMetrics,
  sentenceIdx: number,
  source: SegmentAudioSource,
  sizeBytes: unknown,
  text: unknown,
  normalizedText: unknown,
  now: number,
  wsCreatedAtMs?: unknown
): void {
  const segment = ensureSegmentMetrics(metrics, sentenceIdx);
  if (segment.first_seen_at_ms == null) segment.first_seen_at_ms = now;
  if (segment.audio_available_at_ms == null) segment.audio_available_at_ms = now;
  updateSegmentText(segment, text, normalizedText);
  const parsedSize = Number(sizeBytes);
  if (Number.isFinite(parsedSize) && parsedSize >= 0) segment.size_bytes = parsedSize;
  if (!segment.source) {
    segment.source = source;
    if (source === "ws_audio") metrics.segments_ws_audio += 1;
    if (source === "url_fallback") metrics.segments_url_fallback += 1;
  } else if (segment.source === "url_fallback" && source === "ws_audio") {
    segment.source = "ws_audio";
    metrics.segments_url_fallback = Math.max(0, metrics.segments_url_fallback - 1);
    metrics.segments_ws_audio += 1;
  }
  const createdAt = Number(wsCreatedAtMs);
  if (source === "ws_audio" && Number.isFinite(createdAt) && createdAt > 0) {
    metrics.ws_arrival_lag_ms.push(Math.max(0, now - createdAt));
  }
}

function tickPlaybackMetrics(metrics: PlaybackMetrics, bucket: PlaybackMetricsBucket, now: number): void {
  const delta = Math.max(0, now - metrics.last_tick_ms);
  metrics[bucket] += delta;
  metrics.last_tick_ms = now;
}

function bucketForPlaybackState(
  speech: PlaybackSpeech | null,
  position: PlaybackPosition,
  media: ActiveMediaState,
  audioEnabled: boolean,
  suppressed: boolean
): PlaybackMetricsBucket {
  if (!audioEnabled || suppressed) return "blocked_ms";
  if (!speech) return "idle_ms";
  if (media === "playing") return "playing_ms";
  if (media === "stalled" || media === "errored") return "stalled_ms";
  if (position.waitingSinceMs != null) return "waiting_audio_ms";
  return "idle_ms";
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundRatio(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 10000) / 10000;
}

export function buildPlaybackMetricsSummary(metrics: PlaybackMetrics, reason: string, endedAtMs = nowEpoch()): PlaybackMetricsSummary {
  const observed = Math.max(0, endedAtMs - metrics.started_at_ms);
  const segments = [...metrics.segments.values()].sort((a, b) => a.sentence_idx - b.sentence_idx);
  const audioSegments = segments.filter((segment) => segment.source);
  const wsSegments = audioSegments.filter((segment) => segment.source === "ws_audio");
  const fallbackSegments = audioSegments.filter((segment) => segment.source === "url_fallback");
  const knownBytes = audioSegments.reduce((sum, segment) => sum + (segment.size_bytes ?? 0), 0);
  const knownDuration = segments.reduce((sum, segment) => sum + (segment.duration_s ?? 0), 0);
  return {
    reason,
    match_id: metrics.match_id,
    speech_id: metrics.speech_id,
    task_id: metrics.task_id,
    speaker_id: metrics.speaker_id,
    started_at_ms: metrics.started_at_ms,
    ended_at_ms: endedAtMs,
    observed_ms: observed,
    playing_ms: Math.round(metrics.playing_ms),
    waiting_audio_ms: Math.round(metrics.waiting_audio_ms),
    stalled_ms: Math.round(metrics.stalled_ms),
    idle_ms: Math.round(metrics.idle_ms),
    blocked_ms: Math.round(metrics.blocked_ms),
    play_ratio: roundRatio(metrics.playing_ms, observed),
    waiting_audio_ratio: roundRatio(metrics.waiting_audio_ms, observed),
    stalled_ratio: roundRatio(metrics.stalled_ms, observed),
    blocked_ratio: roundRatio(metrics.blocked_ms, observed),
    audio_segments_total: audioSegments.length,
    audio_total_bytes: knownBytes,
    audio_total_duration_s: Math.round(knownDuration * 1000) / 1000,
    audio_ws_bytes: wsSegments.reduce((sum, segment) => sum + (segment.size_bytes ?? 0), 0),
    audio_ws_segments: wsSegments.length,
    audio_url_fallback_segments: fallbackSegments.length,
    audio_unknown_size_segments: audioSegments.filter((segment) => segment.size_bytes == null).length,
    audio_sentence_indices: audioSegments.map((segment) => segment.sentence_idx),
    segments_played: metrics.segments_played,
    segments_skipped: metrics.segments_skipped,
    segments_media_error: metrics.segments_media_error,
    segments_ws_audio: metrics.segments_ws_audio,
    segments_url_fallback: metrics.segments_url_fallback,
    tts_audio_ws_reconnects: metrics.tts_audio_ws_reconnects,
    tts_audio_ws_ignored_stale: metrics.tts_audio_ws_ignored_stale,
    tts_audio_ws_decode_errors: metrics.tts_audio_ws_decode_errors,
    avg_sentence_audio_ws_arrival_lag_ms: average(metrics.ws_arrival_lag_ms),
    avg_play_attempt_to_onplaying_ms: average(metrics.play_attempt_to_onplaying_ms),
    avg_inter_segment_gap_ms: average(metrics.inter_segment_gap_ms),
    segments: segments.map((segment) => ({
      sentence_idx: segment.sentence_idx,
      text: segment.text,
      normalized_text: segment.normalized_text,
      text_length: segment.text_length,
      normalized_text_length: segment.normalized_text_length,
      source: segment.source,
      size_bytes: segment.size_bytes,
      duration_s: segment.duration_s,
      play_ms: Math.round(segment.play_ms),
      wait_before_play_ms: Math.round(segment.wait_before_play_ms),
    })),
  };
}

export function usePlayback(
  matchId: string,
  snapshot: MatchSnapshot | null,
  lastEvent: RealtimeMessage | null,
  audioEnabled: boolean,
  setAudioEnabled: (value: boolean) => void,
  onPlaybackBlocked?: () => void
): { unlock: () => void } {
  const positionRef = useRef<PlaybackPosition>(emptyPosition());
  const mediaRef = useRef<ActiveMediaState>("idle");
  const retryRef = useRef<Map<string, number>>(new Map());
  const suppressRef = useRef<Set<string>>(new Set());
  const startReportedRef = useRef<string>(""); // `${speechId}:${taskId}` 已上报"开始播放"
  // 单个可复用 <audio> 元素 + 当前正在播放段的标识（供一次性绑定的处理器读取）。
  const activeElRef = useRef<HTMLAudioElement | null>(null);
  const activeSegmentRef = useRef<string>("");
  const urlRef = useRef<string>("");
  const currentPlayRef = useRef<{ speechId: string; taskId: string; speakerId: string; idx: number } | null>(null);
  // 预加载下一句（双缓冲，仅 1 个备用元素）：当前句播放时把下一句音频预取到 standby <audio>。
  // onended 后若下一句命中 standby，就直接把该元素接管为 active，避免主 <audio> 重新换 src 的启动缝。
  const preloaderRef = useRef<HTMLAudioElement | null>(null);
  const preloadedUrlRef = useRef<string>("");
  const playbackProgressRef = useRef<{ segment: string; currentTime: number; atMs: number }>({
    segment: "",
    currentTime: 0,
    atMs: 0,
  });
  const playbackHeartbeatRef = useRef<{ segment: string; atMs: number }>({ segment: "", atMs: 0 });
  // 事件快路：tts.sentence_ready 里直接带 audio_url / skipped，立刻并入 reducer 视图，省去快照 GET 往返。
  const eventChunksRef = useRef<{ key: string; map: Map<number, string> }>({ key: "", map: new Map() });
  const wsAudioUrlsRef = useRef<WsAudioUrlState>({ key: "", urls: new Map(), ownedUrls: new Set() });
  const eventSkipsRef = useRef<{ key: string; set: Set<number> }>({ key: "", set: new Set() });
  const lastSpeechKeyRef = useRef("");
  const metricsRef = useRef<PlaybackMetrics | null>(null);
  const audioEnabledRef = useRef(audioEnabled);
  const onPlaybackBlockedRef = useRef(onPlaybackBlocked);
  const snapshotRef = useRef<MatchSnapshot | null>(snapshot);
  const runnerRef = useRef<(now: number) => void>(() => {});

  audioEnabledRef.current = audioEnabled;
  onPlaybackBlockedRef.current = onPlaybackBlocked;
  snapshotRef.current = snapshot;

  const flushMetrics = useCallback((reason: string, now = nowEpoch()) => {
    const metrics = metricsRef.current;
    if (!metrics || metrics.flushed || metrics.segments.size === 0) return;
    const speech = projectSpeech(snapshotRef.current);
    const suppressed = speech
      ? suppressRef.current.has(`speech:${speech.speechId}`) || suppressRef.current.has(`task:${speech.taskId}`)
      : false;
    tickPlaybackMetrics(metrics, bucketForPlaybackState(speech, positionRef.current, mediaRef.current, audioEnabledRef.current, suppressed), now);
    metrics.flushed = true;
    console.log("[agent-tts-playback-metrics]", buildPlaybackMetricsSummary(metrics, reason, now));
  }, []);

  const markPlaybackBlocked = useCallback(() => {
    positionRef.current = {
      ...positionRef.current,
      activeIdx: null,
      activeStartedMs: null,
      waitingSinceMs: null,
    };
    mediaRef.current = "idle";
    currentPlayRef.current = null;
    urlRef.current = "";
    clearActiveAudio(activeElRef, activeSegmentRef, playbackProgressRef);
    onPlaybackBlockedRef.current?.();
  }, []);

  // 单元素的一次性事件处理器：用 currentPlayRef/activeSegmentRef 读取"当前段"，不靠闭包捕获。
  function attachHandlers(el: HTMLAudioElement): void {
    el.onplaying = () => {
      if (activeElRef.current !== el) return;
      const cur = currentPlayRef.current;
      if (!cur) return;
      mediaRef.current = "playing";
      const metrics = ensurePlaybackMetrics(metricsRef, matchId, cur.speechId, cur.taskId, cur.speakerId);
      const segment = ensureSegmentMetrics(metrics, cur.idx);
      segment.playing_at_ms = nowEpoch();
      if (segment.play_attempt_at_ms != null) {
        metrics.play_attempt_to_onplaying_ms.push(Math.max(0, segment.playing_at_ms - segment.play_attempt_at_ms));
      }
      logPlayback("info", "audio_onplaying", {
        match_id: matchId,
        speech_id: cur.speechId,
        task_id: cur.taskId,
        speaker_id: cur.speakerId,
        sentence_idx: cur.idx,
        url: urlRef.current,
        duration: Number.isFinite(el.duration) ? el.duration : null,
        current_time: el.currentTime,
        ready_state: el.readyState,
        network_state: el.networkState,
      });
      const startKey = `${cur.speechId}:${cur.taskId}`;
      if (startReportedRef.current !== startKey) {
        startReportedRef.current = startKey;
        void postWithRetry(`/api/matches/${matchId}/speeches/${cur.speechId}/tts/playback-started`, {
          task_id: cur.taskId,
          speaker_id: cur.speakerId,
          reason: "screen_audio_play_started",
        });
      }
      void postWithRetry(`/api/matches/${matchId}/speeches/${cur.speechId}/tts/playback-progress`, {
        task_id: cur.taskId,
        sentence_idx: cur.idx,
        speaker_id: cur.speakerId,
        status: "playing",
      });
    };
    el.onended = () => {
      if (activeElRef.current !== el) return;
      const cur = currentPlayRef.current;
      mediaRef.current = "ended";
      if (cur) {
        const endedAt = nowEpoch();
        const metrics = ensurePlaybackMetrics(metricsRef, matchId, cur.speechId, cur.taskId, cur.speakerId, endedAt);
        const segment = ensureSegmentMetrics(metrics, cur.idx);
        segment.ended_at_ms = endedAt;
        if (segment.playing_at_ms != null) {
          segment.play_ms += Math.max(0, endedAt - segment.playing_at_ms);
        }
        segment.duration_s = Number.isFinite(el.duration) ? el.duration : segment.duration_s;
        metrics.last_segment_ended_at_ms = endedAt;
        metrics.segments_played += 1;
        logPlayback("info", "audio_onended", {
          match_id: matchId,
          speech_id: cur.speechId,
          task_id: cur.taskId,
          speaker_id: cur.speakerId,
          sentence_idx: cur.idx,
          url: urlRef.current,
          duration: Number.isFinite(el.duration) ? el.duration : null,
          current_time: el.currentTime,
        });
        void postWithRetry(`/api/matches/${matchId}/speeches/${cur.speechId}/tts/playback-progress`, {
          task_id: cur.taskId,
          sentence_idx: cur.idx,
          speaker_id: cur.speakerId,
          status: "played",
        });
      }
      runnerRef.current(nowEpoch());
    };
    el.onwaiting = () => {
      if (activeElRef.current !== el) return;
      const cur = currentPlayRef.current;
      logPlayback("warn", "audio_onwaiting", {
        match_id: matchId,
        speech_id: cur?.speechId,
        task_id: cur?.taskId,
        speaker_id: cur?.speakerId,
        sentence_idx: cur?.idx,
        url: urlRef.current,
        current_time: el.currentTime,
        ready_state: el.readyState,
        network_state: el.networkState,
      });
      mediaRef.current = "stalled";
      runnerRef.current(nowEpoch());
    };
    el.onstalled = () => {
      if (activeElRef.current !== el) return;
      const cur = currentPlayRef.current;
      logPlayback("warn", "audio_onstalled", {
        match_id: matchId,
        speech_id: cur?.speechId,
        task_id: cur?.taskId,
        speaker_id: cur?.speakerId,
        sentence_idx: cur?.idx,
        url: urlRef.current,
        current_time: el.currentTime,
        ready_state: el.readyState,
        network_state: el.networkState,
      });
      mediaRef.current = "stalled";
      runnerRef.current(nowEpoch());
    };
    el.oncanplay = () => {
      if (activeElRef.current !== el) return;
      if (!el.paused && !el.ended) mediaRef.current = "playing";
    };
    el.onerror = () => {
      if (activeElRef.current !== el) return;
      const cur = currentPlayRef.current;
      const rk = cur ? `${cur.taskId}:${cur.idx}` : "";
      const tries = (rk && retryRef.current.get(rk)) || 0;
      logPlayback("error", "audio_onerror", {
        match_id: matchId,
        speech_id: cur?.speechId,
        task_id: cur?.taskId,
        speaker_id: cur?.speakerId,
        sentence_idx: cur?.idx,
        url: urlRef.current,
        retry_count: tries,
        ...mediaErrorDetails(el),
      });
      if (rk && tries < 1 && urlRef.current) {
        retryRef.current.set(rk, tries + 1);
        try {
          el.src = urlRef.current;
          el.load();
          void el.play().catch(() => {
            logPlayback("error", "audio_retry_play_rejected", {
              match_id: matchId,
              speech_id: cur?.speechId,
              task_id: cur?.taskId,
              speaker_id: cur?.speakerId,
              sentence_idx: cur?.idx,
              url: urlRef.current,
            });
            mediaRef.current = "errored";
            runnerRef.current(nowEpoch());
          });
          return;
        } catch {
          /* fall through */
        }
      }
      mediaRef.current = "errored";
      runnerRef.current(nowEpoch());
    };
  }

  function ensureEl(): HTMLAudioElement {
    let el = activeElRef.current;
    if (!el) {
      el = new Audio();
      el.preload = "auto";
      el.volume = SCREEN_TTS_VOLUME;
      applyScreenTtsPlaybackRate(el);
      activeElRef.current = el;
      attachHandlers(el);
    }
    return el;
  }

  // 预热下一句的音频缓存（不播放）。配合后端可缓存的归档音频，主元素切到该 url 时直接命中缓存。
  function preloadNext(url: string): void {
    if (!url || preloadedUrlRef.current === url) return;
    try {
      let p = preloaderRef.current;
      if (!p) {
        p = new Audio();
        p.preload = "auto";
        p.muted = true;
        preloaderRef.current = p;
      }
      preloadedUrlRef.current = url;
      p.src = url;
      p.load();
      logPlayback("info", "audio_preload_next", { match_id: matchId, url });
    } catch {
      logPlayback("warn", "audio_preload_failed", { match_id: matchId, url });
      /* 预加载失败无所谓：主播放仍会自行取流，只是少了这点提速 */
    }
  }

  function takePreloadedAudio(url: string): HTMLAudioElement | null {
    if (!url || preloadedUrlRef.current !== url || !preloaderRef.current) return null;
    const el = preloaderRef.current;
    preloaderRef.current = null;
    preloadedUrlRef.current = "";
    return el;
  }

  const runReconcile = useCallback(
    (now: number) => {
      const progressed = observeActiveAudioProgress(now, positionRef, activeElRef, activeSegmentRef, playbackProgressRef, mediaRef);
      const speech = projectSpeech(snapshotRef.current);
      const speechKey = speech ? `${speech.speechId}:${speech.taskId}` : "";
      if (lastSpeechKeyRef.current && lastSpeechKeyRef.current !== speechKey) {
        flushMetrics("speech_or_task_changed", now);
        clearWsAudioUrls(wsAudioUrlsRef.current);
        metricsRef.current = null;
      }
      lastSpeechKeyRef.current = speechKey;
      const suppressed = speech
        ? suppressRef.current.has(`speech:${speech.speechId}`) || suppressRef.current.has(`task:${speech.taskId}`)
        : false;
      if (speech) {
        const metrics = ensurePlaybackMetrics(metricsRef, matchId, speech.speechId, speech.taskId, speech.speakerId, now);
        tickPlaybackMetrics(metrics, bucketForPlaybackState(speech, positionRef.current, mediaRef.current, audioEnabledRef.current, suppressed), now);
      }
      if (speech) {
        if (progressed) {
          maybeReportPlaybackHeartbeat(now, speech, positionRef, activeSegmentRef, playbackHeartbeatRef, mediaRef, matchId);
        }
        const key = speechKey;
        const ws = wsAudioUrlsRef.current;
        if (ws.key === key && ws.urls.size) {
          const have = new Set(speech.chunks.map((c) => c.sentenceIdx));
          ws.urls.forEach((url, idx) => {
            if (!have.has(idx)) speech.chunks.push({ sentenceIdx: idx, audioUrl: url });
          });
        }
        const ev = eventChunksRef.current;
        if (ev.key === key && ev.map.size) {
          const have = new Set(speech.chunks.map((c) => c.sentenceIdx));
          ev.map.forEach((url, idx) => {
            if (!have.has(idx)) speech.chunks.push({ sentenceIdx: idx, audioUrl: url });
          });
        }
        const sk = eventSkipsRef.current;
        if (sk.key === key && sk.set.size) {
          const skipped = new Set(speech.skippedSentences);
          sk.set.forEach((idx) => skipped.add(idx));
          speech.skippedSentences = [...skipped];
        }
      }
      for (let guard = 0; guard < 256; guard += 1) {
        const decision = reconcile({
          speech,
          position: positionRef.current,
          nowMs: now,
          audioEnabled: audioEnabledRef.current,
          suppressed,
          activeMediaState: mediaRef.current,
        });
        positionRef.current = decision.position;

        if (decision.kind === "PLAY") {
          logPlayback("info", "reconcile_play_decision", {
            match_id: matchId,
            speech_id: speech?.speechId,
            task_id: speech?.taskId,
            speaker_id: speech?.speakerId,
            sentence_idx: decision.sentenceIdx,
            audio_url: decision.audioUrl,
          });
          if (speech) playSegment(speech, decision.sentenceIdx, decision.audioUrl);
          return;
        }

        if (decision.kind === "STOP") {
          logPlayback("info", "reconcile_stop_decision", {
            match_id: matchId,
            speech_id: speech?.speechId,
            task_id: speech?.taskId,
            reason: decision.reason,
          });
          if (decision.reason === "suppressed" || decision.reason === "audio_disabled") {
            const el = activeElRef.current;
            if (el) {
              try {
                el.pause();
              } catch {
                /* ignore */
              }
            }
          } else {
            clearActiveAudio(activeElRef, activeSegmentRef, playbackProgressRef);
          }
          mediaRef.current = "idle";
          return;
        }

        if (decision.kind === "DONE") {
          clearActiveAudio(activeElRef, activeSegmentRef, playbackProgressRef);
          logPlayback("info", "reconcile_done_decision", {
            match_id: matchId,
            speech_id: decision.speechId,
            task_id: decision.taskId,
            speaker_id: speech?.speakerId,
          });
          void postWithRetry(`/api/matches/${matchId}/speeches/${decision.speechId}/tts/playback-complete`, {
            task_id: decision.taskId,
            speaker_id: speech?.speakerId,
            reason: "screen_playback_complete",
          });
          flushMetrics("playback_done", now);
          return;
        }

        if (decision.kind === "NOTIFY_START") {
          continue; // 上报留给真实 onplaying；这里直接进入下一拍 → PLAY
        }

        if (decision.kind === "SKIP") {
          if (speech) {
            const metrics = ensurePlaybackMetrics(metricsRef, matchId, speech.speechId, speech.taskId, speech.speakerId, now);
            metrics.segments_skipped += 1;
            if (decision.reason === "media_error") metrics.segments_media_error += 1;
          }
          logPlayback("warn", "reconcile_skip_decision", {
            match_id: matchId,
            speech_id: speech?.speechId,
            task_id: speech?.taskId,
            speaker_id: speech?.speakerId,
            sentence_idx: decision.sentenceIdx,
            reason: decision.reason,
          });
          if (speech) {
            const segment = `${speech.speechId}:${speech.taskId}:${decision.sentenceIdx}`;
            if (activeSegmentRef.current === segment) {
              clearActiveAudio(activeElRef, activeSegmentRef, playbackProgressRef);
            }
          }
          if (speech && (decision.reason === "watchdog_timeout" || decision.reason === "media_error")) {
            void postWithRetry(`/api/matches/${matchId}/speeches/${speech.speechId}/tts/playback-progress`, {
              task_id: speech.taskId,
              sentence_idx: decision.sentenceIdx,
              speaker_id: speech.speakerId,
              status: decision.reason === "media_error" ? "error" : "stalled",
            });
          }
          mediaRef.current = "idle";
          continue; // 立即解析下一段
        }

        return; // WAIT / IDLE
      }

      // 播放当前段：复用唯一 <audio>，直接 src=url; play()。任一时刻只占 1 个音频连接。
      function playSegment(sp: PlaybackSpeech, idx: number, url: string) {
        const segment = `${sp.speechId}:${sp.taskId}:${idx}`;
        const playAttemptAt = nowEpoch();
        const metrics = ensurePlaybackMetrics(metricsRef, matchId, sp.speechId, sp.taskId, sp.speakerId, playAttemptAt);
        const segmentMetrics = ensureSegmentMetrics(metrics, idx);
        segmentMetrics.play_attempt_at_ms = playAttemptAt;
        if (segmentMetrics.audio_available_at_ms != null) {
          segmentMetrics.wait_before_play_ms += Math.max(0, playAttemptAt - segmentMetrics.audio_available_at_ms);
        }
        if (metrics.last_segment_ended_at_ms != null) {
          metrics.inter_segment_gap_ms.push(Math.max(0, playAttemptAt - metrics.last_segment_ended_at_ms));
        }
        currentPlayRef.current = { speechId: sp.speechId, taskId: sp.taskId, speakerId: sp.speakerId, idx };
        const currentEl = activeElRef.current;
        if (currentEl && activeSegmentRef.current === segment && urlRef.current === url && !currentEl.ended) {
          const el = currentEl;
          mediaRef.current = el.paused ? "idle" : "playing";
          if (el.paused) {
            logPlayback("info", "audio_play_resume_attempt", {
              match_id: matchId,
              speech_id: sp.speechId,
              task_id: sp.taskId,
              speaker_id: sp.speakerId,
              sentence_idx: idx,
              url,
            });
            void el.play().catch((err: unknown) => {
              logPlayback("error", "audio_play_resume_rejected", {
                match_id: matchId,
                speech_id: sp.speechId,
                task_id: sp.taskId,
                speaker_id: sp.speakerId,
                sentence_idx: idx,
                url,
                error_name: (err as { name?: string })?.name,
                error_message: err instanceof Error ? err.message : String(err),
              });
              if (err && (err as { name?: string }).name === "NotAllowedError") {
                markPlaybackBlocked();
                return;
              }
              mediaRef.current = "errored";
              runnerRef.current(nowEpoch());
            });
          }
          return;
        }
        const standby = takePreloadedAudio(url);
        const el = standby ?? ensureEl();
        if (standby) {
          const previous = activeElRef.current;
          if (previous && previous !== standby) detachAndStop(previous);
          activeElRef.current = standby;
          attachHandlers(standby);
        }
        el.volume = SCREEN_TTS_VOLUME;
        el.muted = false;
        applyScreenTtsPlaybackRate(el);
        activeSegmentRef.current = segment;
        urlRef.current = url;
        playbackProgressRef.current = { segment, currentTime: 0, atMs: now };
        mediaRef.current = "playing";
        retryRef.current.delete(`${sp.taskId}:${idx}`);
        // 预热下一句，缩小句间空隙（命中后端可缓存的归档音频）。
        const nextUrl = sp.chunks.find((c) => c.sentenceIdx === idx + 1)?.audioUrl;
        if (nextUrl) preloadNext(nextUrl);
        try {
          if (el.getAttribute("src") !== url) el.src = url;
        } catch {
          /* ignore */
        }
        try {
          el.currentTime = 0;
        } catch {
          /* ignore */
        }
        logPlayback("info", "audio_play_attempt", {
          match_id: matchId,
          speech_id: sp.speechId,
          task_id: sp.taskId,
          speaker_id: sp.speakerId,
          sentence_idx: idx,
          url,
          reused_preload: Boolean(standby),
          ready_state: el.readyState,
          network_state: el.networkState,
        });
        void el.play().catch((err: unknown) => {
          logPlayback("error", "audio_play_rejected", {
            match_id: matchId,
            speech_id: sp.speechId,
            task_id: sp.taskId,
            speaker_id: sp.speakerId,
            sentence_idx: idx,
            url,
            error_name: (err as { name?: string })?.name,
            error_message: err instanceof Error ? err.message : String(err),
          });
          if (err && (err as { name?: string }).name === "NotAllowedError") {
            markPlaybackBlocked();
            return;
          }
          mediaRef.current = "errored";
          runnerRef.current(nowEpoch());
        });
      }
    },
    [markPlaybackBlocked, matchId]
  );

  runnerRef.current = runReconcile;

  // 用户手势（点扬声器）内同步解锁音频：跑一拍对账，首段若已就绪 play() 就发生在手势里；
  // 若暂无可播段，用独立静音元素在手势里播一下激活媒体权限。
  const unlock = useCallback(() => {
    audioEnabledRef.current = true;
    runnerRef.current(nowEpoch());
    if (positionRef.current.activeIdx == null) {
      try {
        const primer = new Audio(SILENCE_URL);
        void primer
          .play()
          .then(() => {
            try {
              primer.pause();
            } catch {
              /* ignore */
            }
          })
          .catch(() => onPlaybackBlockedRef.current?.());
      } catch {
        onPlaybackBlockedRef.current?.();
      }
    }
  }, []);

  // 音频开关变化时立即对账（开→尽快开播/解锁，关→立即截断）。
  useEffect(() => {
    runnerRef.current(nowEpoch());
  }, [audioEnabled]);

  // 卸载时释放音频元素。
  useEffect(() => {
    return () => {
      flushMetrics("unload");
      clearActiveAudio(activeElRef, activeSegmentRef, playbackProgressRef);
      const p = preloaderRef.current;
      if (p) {
        try {
          p.removeAttribute("src");
          p.load();
        } catch {
          /* ignore */
        }
        preloaderRef.current = null;
        preloadedUrlRef.current = "";
      }
    };
  }, [flushMetrics]);

  // 触发器 1：快照变化（唯一真相）。
  useEffect(() => {
    runnerRef.current(nowEpoch());
  }, [snapshot]);

  // 独立音频 WS：只承载 TTS 音频 bytes，避免大 payload 挤占主比赛 WS 的字幕/控制事件。
  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let reconnectAttempt = 0;

    function scheduleReconnect() {
      if (cancelled) return;
      const base = Math.min(15000, 1200 * 2 ** Math.min(reconnectAttempt, 4));
      const delay = base + Math.floor(Math.random() * 400);
      reconnectAttempt += 1;
      retry = window.setTimeout(open, delay);
    }

    function open() {
      if (cancelled) return;
      try {
        socket = new WebSocket(ttsAudioWsUrl(matchId));
        socket.onopen = () => {
          reconnectAttempt = 0;
          logPlayback("info", "tts_audio_ws_open", { match_id: matchId });
        };
        socket.onclose = () => {
          const current = projectSpeech(snapshotRef.current);
          if (current) {
            const metrics = ensurePlaybackMetrics(metricsRef, matchId, current.speechId, current.taskId, current.speakerId);
            metrics.tts_audio_ws_reconnects += 1;
          }
          logPlayback("warn", "tts_audio_ws_closed", { match_id: matchId });
          scheduleReconnect();
        };
        socket.onerror = () => {
          logPlayback("warn", "tts_audio_ws_error", { match_id: matchId });
          socket?.close();
        };
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(String(event.data)) as TtsSentenceAudioMessage;
            if (message.type !== "tts.sentence_audio") return;
            const currentSpeech = projectSpeech(snapshotRef.current);
            const expectedKey = currentSpeech ? `${currentSpeech.speechId}:${currentSpeech.taskId}` : "";
            const now = nowEpoch();
            const result = rememberWsSentenceAudio(message, wsAudioUrlsRef, eventChunksRef, expectedKey, positionRef.current.nextIdx);
            if (result.ok) {
              const metrics = ensurePlaybackMetrics(metricsRef, matchId, result.speechId, result.taskId, String(message.speaker_id ?? currentSpeech?.speakerId ?? ""), now);
              markMetricsAudioAvailable(
                metrics,
                result.sentenceIdx,
                "ws_audio",
                message.size_bytes,
                message.text,
                message.normalized_text,
                now,
                message.created_at_ms
              );
              logPlayback("info", "tts_audio_ws_received", {
                match_id: matchId,
                speech_id: result.speechId,
                task_id: result.taskId,
                sentence_idx: result.sentenceIdx,
                mime_type: message.mime_type,
                size_bytes: message.size_bytes,
              });
              const active = currentPlayRef.current;
              if (active && active.speechId === result.speechId && active.taskId === result.taskId && result.sentenceIdx === active.idx + 1) {
                preloadNext(result.url);
              }
              runnerRef.current(nowEpoch());
            } else {
              if (currentSpeech) {
                const metrics = ensurePlaybackMetrics(metricsRef, matchId, currentSpeech.speechId, currentSpeech.taskId, currentSpeech.speakerId);
                if (result.reason === "stale_speech_or_task") metrics.tts_audio_ws_ignored_stale += 1;
              }
              logPlayback("warn", "tts_audio_ws_ignored", { match_id: matchId, reason: result.reason });
            }
          } catch (err) {
            const current = projectSpeech(snapshotRef.current);
            if (current) {
              const metrics = ensurePlaybackMetrics(metricsRef, matchId, current.speechId, current.taskId, current.speakerId);
              metrics.tts_audio_ws_decode_errors += 1;
            }
            logPlayback("warn", "tts_audio_ws_message_failed", {
              match_id: matchId,
              error_message: err instanceof Error ? err.message : String(err),
            });
          }
        };
      } catch (err) {
        logPlayback("warn", "tts_audio_ws_open_failed", {
          match_id: matchId,
          error_message: err instanceof Error ? err.message : String(err),
        });
        scheduleReconnect();
      }
    }

    open();
    return () => {
      cancelled = true;
      if (retry) window.clearTimeout(retry);
      socket?.close();
      clearWsAudioUrls(wsAudioUrlsRef.current);
    };
  }, [matchId]);

  // 触发器 2：实时事件——更新 suppress、并把 chunk/skip 即时并入快路；其余靠下一帧快照对账。
  useEffect(() => {
    if (!lastEvent) {
      return;
    }
    logPlayback("info", "realtime_event_received", {
      match_id: matchId,
      type: lastEvent.type,
      payload: lastEvent.payload,
    });
    const p = (lastEvent.payload ?? {}) as Record<string, unknown>;
    const speechId = String(p.speech_id ?? "");
    const taskId = String(p.task_id ?? "");
    if (lastEvent.type === "tts.playback_stop_requested") {
      if (speechId) suppressRef.current.add(`speech:${speechId}`);
      if (taskId) suppressRef.current.add(`task:${taskId}`);
    } else if (lastEvent.type === "tts.playback_resume_requested") {
      if (speechId) suppressRef.current.delete(`speech:${speechId}`);
      if (taskId) suppressRef.current.delete(`task:${taskId}`);
      // 「继续播放」也重新打开音频开关：若此前因自动播放被拦而被置 false，这里恢复。
      audioEnabledRef.current = true;
      setAudioEnabled(true);
    } else if (lastEvent.type === "tts.finished") {
      flushMetrics("tts_finished_event");
    } else if (lastEvent.type === "speech.ended") {
      flushMetrics("speech_ended_event");
    } else if (lastEvent.type === "tts.sentence_ready") {
      const url = String(p.audio_url ?? "");
      const idx = Number(p.sentence_idx ?? NaN);
      if (Number.isFinite(idx) && speechId && taskId) {
        const key = `${speechId}:${taskId}`;
        const metrics = ensurePlaybackMetrics(metricsRef, matchId, speechId, taskId, String(p.speaker_id ?? ""), nowEpoch());
        if (p.text || p.normalized_text) {
          const segment = ensureSegmentMetrics(metrics, idx);
          updateSegmentText(segment, p.text, p.normalized_text);
        }
        if (url) {
          if (wsAudioUrlsRef.current.key === key && wsAudioUrlsRef.current.urls.has(idx)) {
            logPlayback("info", "sentence_ready_ignored_ws_audio_available", {
              match_id: matchId,
              speech_id: speechId,
              task_id: taskId,
              sentence_idx: idx,
              audio_url: url,
            });
          } else {
            if (eventChunksRef.current.key !== key) eventChunksRef.current = { key, map: new Map() };
            eventChunksRef.current.map.set(idx, url);
            markMetricsAudioAvailable(metrics, idx, "url_fallback", p.size_bytes, p.text, p.normalized_text, nowEpoch());
          }
          logPlayback("info", "sentence_ready_received", {
            match_id: matchId,
            speech_id: speechId,
            task_id: taskId,
            sentence_idx: idx,
            audio_url: url,
            mime_type: p.mime_type,
            size_bytes: p.size_bytes,
          });
          const active = currentPlayRef.current;
          if (active && active.speechId === speechId && active.taskId === taskId && idx === active.idx + 1) {
            preloadNext(url);
          }
        } else if (p.skipped) {
          if (eventSkipsRef.current.key !== key) eventSkipsRef.current = { key, set: new Set() };
          eventSkipsRef.current.set.add(idx);
          logPlayback("warn", "sentence_skip_received", {
            match_id: matchId,
            speech_id: speechId,
            task_id: taskId,
            sentence_idx: idx,
            reason: p.reason,
          });
        }
      }
    }
    runnerRef.current(nowEpoch());
  }, [flushMetrics, lastEvent, setAudioEnabled]);

  // 触发器 3：1 秒看门狗——即便所有媒体事件都不触发，也能按时间强制推进，永不永久卡死。
  useEffect(() => {
    const id = window.setInterval(() => runnerRef.current(nowEpoch()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return { unlock };
}

function detachHandlers(el: HTMLAudioElement): void {
  el.onended = null;
  el.onerror = null;
  el.onplaying = null;
  el.onwaiting = null;
  el.onstalled = null;
  el.oncanplay = null;
}

function detachAndStop(el: HTMLAudioElement): void {
  detachHandlers(el);
  try {
    el.pause();
  } catch {
    /* ignore */
  }
  try {
    el.removeAttribute("src");
    el.load();
  } catch {
    /* ignore */
  }
}

export function clearActiveAudio(
  activeElRef: MutableRefObject<HTMLAudioElement | null>,
  activeSegmentRef: MutableRefObject<string>,
  playbackProgressRef: MutableRefObject<{ segment: string; currentTime: number; atMs: number }>
): void {
  const el = activeElRef.current;
  if (el) detachAndStop(el);
  activeElRef.current = null;
  activeSegmentRef.current = "";
  playbackProgressRef.current = { segment: "", currentTime: 0, atMs: 0 };
}

export function observeActiveAudioProgress(
  now: number,
  positionRef: MutableRefObject<PlaybackPosition>,
  activeElRef: MutableRefObject<HTMLAudioElement | null>,
  activeSegmentRef: MutableRefObject<string>,
  playbackProgressRef: MutableRefObject<{ segment: string; currentTime: number; atMs: number }>,
  mediaRef: MutableRefObject<ActiveMediaState>
): boolean {
  const pos = positionRef.current;
  const el = activeElRef.current;
  if (!el || pos.activeIdx == null || !pos.speechId || !pos.taskId) return false;
  const segment = `${pos.speechId}:${pos.taskId}:${pos.activeIdx}`;
  if (activeSegmentRef.current !== segment) return false;

  if (el.ended) {
    mediaRef.current = "ended";
    return false;
  }

  const currentTime = Number.isFinite(el.currentTime) ? el.currentTime : 0;
  const previous = playbackProgressRef.current;
  const advanced =
    previous.segment === segment && currentTime > previous.currentTime + PLAYBACK_PROGRESS_EPSILON;
  if (advanced) {
    playbackProgressRef.current = { segment, currentTime, atMs: now };
    if (!el.paused) mediaRef.current = "playing";
    // 看门狗的基准是"最近一次真实播放进度"，不是分段开始时间。长句正常播放时不会被误跳。
    positionRef.current = { ...positionRef.current, activeStartedMs: now };
    return true;
  }

  if (previous.segment !== segment) {
    playbackProgressRef.current = { segment, currentTime, atMs: now };
  }

  if (mediaRef.current === "playing" && el.paused) {
    mediaRef.current = "stalled";
  }
  return false;
}

function maybeReportPlaybackHeartbeat(
  now: number,
  speech: PlaybackSpeech,
  positionRef: MutableRefObject<PlaybackPosition>,
  activeSegmentRef: MutableRefObject<string>,
  playbackHeartbeatRef: MutableRefObject<{ segment: string; atMs: number }>,
  mediaRef: MutableRefObject<ActiveMediaState>,
  matchId: string
): void {
  const idx = positionRef.current.activeIdx;
  if (idx == null || mediaRef.current !== "playing") return;
  const segment = `${speech.speechId}:${speech.taskId}:${idx}`;
  if (activeSegmentRef.current !== segment) return;
  if (!shouldSendPlaybackHeartbeat(now, segment, playbackHeartbeatRef)) return;
  void postWithRetry(
    `/api/matches/${matchId}/speeches/${speech.speechId}/tts/playback-progress`,
    {
      task_id: speech.taskId,
      sentence_idx: idx,
      speaker_id: speech.speakerId,
      status: "playing",
    },
    2,
    250
  );
}

export function shouldSendPlaybackHeartbeat(
  now: number,
  segment: string,
  playbackHeartbeatRef: MutableRefObject<{ segment: string; atMs: number }>,
  intervalMs = PLAYBACK_HEARTBEAT_MS
): boolean {
  const previous = playbackHeartbeatRef.current;
  if (previous.segment === segment && now - previous.atMs < intervalMs) return false;
  playbackHeartbeatRef.current = { segment, atMs: now };
  return true;
}

type PitchPreservingAudioElement = HTMLAudioElement & {
  preservesPitch?: boolean;
  mozPreservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
};

export function applyScreenTtsPlaybackRate(el: HTMLAudioElement, rate = SCREEN_TTS_PLAYBACK_RATE): void {
  const safeRate = Number.isFinite(rate) ? Math.min(1.6, Math.max(0.75, rate)) : 1;
  try {
    el.playbackRate = safeRate;
  } catch {
    /* ignore */
  }
  try {
    const pitchEl = el as PitchPreservingAudioElement;
    pitchEl.preservesPitch = true;
    pitchEl.mozPreservesPitch = true;
    pitchEl.webkitPreservesPitch = true;
  } catch {
    /* ignore */
  }
}

export function decodeBase64Audio(audioBase64: string): Uint8Array {
  const binary = globalThis.atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function clearWsAudioUrls(state: WsAudioUrlState): void {
  state.ownedUrls.forEach((url) => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  });
  state.ownedUrls.clear();
  state.urls.clear();
  state.key = "";
}

export function rememberWsSentenceAudio(
  message: TtsSentenceAudioMessage,
  wsAudioUrlsRef: MutableRefObject<WsAudioUrlState>,
  eventChunksRef: MutableRefObject<{ key: string; map: Map<number, string> }>,
  expectedKey = "",
  nextIdx = 0
): { ok: true; speechId: string; taskId: string; sentenceIdx: number; url: string } | { ok: false; reason: string } {
  const speechId = String(message.speech_id ?? "");
  const taskId = String(message.task_id ?? "");
  const idx = Number(message.sentence_idx ?? NaN);
  const audioBase64 = String(message.audio_base64 ?? "");
  if (!speechId || !taskId || !Number.isFinite(idx) || idx < 0 || !audioBase64) {
    return { ok: false, reason: "invalid_payload" };
  }
  const key = `${speechId}:${taskId}`;
  if (expectedKey && key !== expectedKey) {
    return { ok: false, reason: "stale_speech_or_task" };
  }
  if (Number.isFinite(nextIdx) && idx < nextIdx) {
    return { ok: false, reason: "already_resolved" };
  }

  const state = wsAudioUrlsRef.current;
  if (state.key && state.key !== key) {
    clearWsAudioUrls(state);
  }
  if (!state.key) state.key = key;
  if (state.urls.has(idx)) {
    return { ok: true, speechId, taskId, sentenceIdx: idx, url: state.urls.get(idx)! };
  }

  const mimeType = String(message.mime_type ?? "audio/wav") || "audio/wav";
  const bytes = decodeBase64Audio(audioBase64);
  const audioBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([audioBuffer], { type: mimeType }));
  state.urls.set(idx, url);
  state.ownedUrls.add(url);
  if (eventChunksRef.current.key === key) {
    eventChunksRef.current.map.delete(idx);
  }
  return { ok: true, speechId, taskId, sentenceIdx: idx, url };
}

export async function postWithRetry(
  path: string,
  body: object,
  attempts = 4,
  delayMs = 500,
  sender: (path: string, body: object) => Promise<unknown> = post
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      logPlayback("info", "playback_callback_post_attempt", { path, body, attempt: attempt + 1, attempts });
      await sender(path, body);
      logPlayback("info", "playback_callback_post_ok", { path, body, attempt: attempt + 1 });
      return true;
    } catch (err) {
      logPlayback(attempt >= attempts - 1 ? "error" : "warn", "playback_callback_post_failed", {
        path,
        body,
        attempt: attempt + 1,
        attempts,
        error_name: (err as { name?: string })?.name,
        error_message: err instanceof Error ? err.message : String(err),
      });
      if (attempt >= attempts - 1) return false;
      await sleep(delayMs * Math.max(1, attempt + 1));
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function projectSpeech(snapshot: MatchSnapshot | null): PlaybackSpeech | null {
  const cs = snapshot?.current_speech;
  if (!cs) return null;
  const asset = snapshot!.audio_assets.find((item) => item.speech_id === cs.id);
  const chunks = (asset?.chunks ?? [])
    .map((chunk) => ({ sentenceIdx: Number(chunk.chunk_index), audioUrl: String(chunk.audio_url ?? "") }))
    .filter((chunk) => Number.isFinite(chunk.sentenceIdx));
  const skippedSentences = (cs.tts_skipped_sentences ?? []).map((value) => Number(value));
  return {
    speechId: cs.id,
    speakerId: cs.speaker_id,
    taskId: String(cs.tts_task_id ?? ""),
    source: cs.source,
    state: String(cs.state ?? ""),
    expectedSentences: cs.tts_expected_sentences ?? null,
    createdSentences: Number(cs.tts_created_sentences ?? 0),
    skippedSentences,
    chunks,
    resumeIdx: computeResumeIdx(cs, skippedSentences),
  };
}

/**
 * 续播起点：页面中途刷新时，从「首个既未播放、也未跳过的分段序号」继续，而不是从 0 重头开始。
 * 后端权威记录已播分段（tts_played_sentence_indices）与跳过分段；正在播放但尚未播完的那一句
 * 不在已播集合里，因此会从它的开头重新播放——即"接着讲"。全新发言时三者皆空，返回 0，行为不变。
 */
export function computeResumeIdx(cs: NonNullable<MatchSnapshot["current_speech"]>, skipped: number[]): number {
  const resolved = new Set<number>();
  (cs.tts_played_sentence_indices ?? []).forEach((v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) resolved.add(n);
  });
  skipped.forEach((n) => {
    if (Number.isFinite(n) && n >= 0) resolved.add(n);
  });
  // 旧版仅有计数（无明细列表）时，把前 N 段视为已播。
  if (!(cs.tts_played_sentence_indices ?? []).length) {
    const count = Number(cs.tts_played_sentences ?? 0);
    for (let i = 0; i < count; i += 1) resolved.add(i);
  }
  let idx = 0;
  while (resolved.has(idx)) idx += 1;
  return idx;
}

function nowEpoch(): number {
  return new Date().getTime();
}

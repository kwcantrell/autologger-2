// SessionDO — one Durable Object per session. Thin framework shell: holds the
// lifecycle hooks (fetch/webSocket*/alarm) and a flat RPC surface that delegates
// to the domain stores (event/transport/audio/lease/transcript/topic) over a
// shared SessionCore. The single-writer invariant is unchanged — one DO instance,
// one ctx.storage.sql. Type re-exports keep the Worker's importers stable.
//
// The Worker owns D1 (session index/metadata) and projects the few list-relevant
// live fields back to D1 after each mutation — so the DO never needs a DB binding
// and cross-session listing stays a pure D1 query. Every mutation therefore
// returns a `projection` block the Worker writes to the D1 sessions row.

import { DurableObject } from 'cloudflare:workers';
import { AudioStore } from './audioStore';
import { EventStore } from './eventStore';
import { LeaseStore } from './leaseStore';
import { SessionCore } from './sessionCore';
import type { SessionProjection, TimecodeCtx } from './sessionCore';
import { TopicStore } from './topicStore';
import { TranscriptStore } from './transcriptStore';
import { TransportStore } from './transportStore';

export type { SessionProjection, TransportState } from './sessionCore';
export type { AudioSegmentMeta } from './audioStore';
export type { TranscriptWord } from './transcriptStore';
export type { Topic } from './topicStore';

export class SessionDO extends DurableObject<Env> {
  private core!: SessionCore;
  private events!: EventStore;
  private transport!: TransportStore;
  private audio!: AudioStore;
  private lease!: LeaseStore;
  private transcript!: TranscriptStore;
  private topics!: TopicStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new SessionCore(ctx);
    this.core.initSchema();
    this.events = new EventStore(this.core);
    this.transport = new TransportStore(this.core);
    this.audio = new AudioStore(this.core);
    this.lease = new LeaseStore(this.core);
    this.transcript = new TranscriptStore(this.core);
    this.topics = new TopicStore(this.core);
  }

  // -- WebSocket fan-out (hibernatable; replaces polling + CompanionHub) --------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }
    const role =
      new URL(request.url).searchParams.get('role') === 'companion' ? 'companion' : 'browser';
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Snapshot of attached sockets by role (presence; no TTL bookkeeping). */
  presence(): { browsers: number; companions: number } {
    return this.core.presence();
  }

  /** Relay a record/play command to all attached sockets (Companion → browser). */
  broadcastCommand(command: string): void {
    this.core.broadcastCommand(command);
  }

  override async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      if (p.type === 'command' && typeof p.command === 'string') {
        this.core.broadcastCommand(p.command);
      }
      // Bare `{type:'ping'}` keepalives are simply ignored.
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code < 1000 || code > 4999 ? 1000 : code);
    } catch {
      // already closed
    }
  }

  override async webSocketError(): Promise<void> {
    // Hibernation drops the socket; nothing else to clean up.
  }

  // -- RPC: lifecycle ----------------------------------------------------------

  /** Touch the DO so its transport row exists; returns the current projection. */
  ensure(): SessionProjection {
    return this.core.projection();
  }

  // --- event delegates ---
  addEvent(input: Parameters<EventStore['addEvent']>[0]) {
    return this.events.addEvent(input);
  }
  listEvents(input: Parameters<EventStore['listEvents']>[0]) {
    return this.events.listEvents(input);
  }
  getEvent(eventId: string) {
    return this.events.getEvent(eventId);
  }
  exportEvents() {
    return this.events.exportEvents();
  }
  updateEvent(input: Parameters<EventStore['updateEvent']>[0]) {
    return this.events.updateEvent(input);
  }
  deleteEvent(eventId: string) {
    return this.events.deleteEvent(eventId);
  }
  maybeRelinkOrphans(input: Parameters<EventStore['maybeRelinkOrphans']>[0]) {
    return this.events.maybeRelinkOrphans(input);
  }

  // --- transport delegates ---
  transportSnapshot(ctx: TimecodeCtx) {
    return this.transport.transportSnapshot(ctx);
  }
  startTake(ctx: TimecodeCtx) {
    return this.transport.startTake(ctx);
  }
  stopTake(ctx: TimecodeCtx) {
    return this.transport.stopTake(ctx);
  }
  stopTakeWithDuration(input: Parameters<TransportStore['stopTakeWithDuration']>[0]) {
    return this.transport.stopTakeWithDuration(input);
  }
  statusLive(ctx: TimecodeCtx) {
    return this.transport.statusLive(ctx);
  }

  // Single alarm reconciliation point. The DO has exactly one alarm slot, fired
  // once; today the recording lease is the sole consumer. Any future scheduled
  // timer MUST route through here (and re-arm to the earliest pending wake) —
  // never call ctx.storage.setAlarm independently, or it clobbers lease expiry.
  override async alarm(): Promise<void> {
    this.lease.expireIfStale();
  }

  // --- lease delegates ---
  claimLease(clientId: string) {
    return this.lease.claimLease(clientId);
  }
  heartbeatLease(clientId: string) {
    return this.lease.heartbeatLease(clientId);
  }
  releaseLease(clientId: string) {
    return this.lease.releaseLease(clientId);
  }
  leaseStatus() {
    return this.lease.leaseStatus();
  }

  // --- audio delegates ---
  addAudioSegment(input: Parameters<AudioStore['addAudioSegment']>[0]) {
    return this.audio.addAudioSegment(input);
  }
  listAudioSegments() {
    return this.audio.listAudioSegments();
  }
  deleteAudioSegment(segmentId: string) {
    return this.audio.deleteAudioSegment(segmentId);
  }
  getAudioSegmentKey(segmentId: string) {
    return this.audio.getAudioSegmentKey(segmentId);
  }
  setAudioSegmentWaveform(input: Parameters<AudioStore['setAudioSegmentWaveform']>[0]) {
    return this.audio.setAudioSegmentWaveform(input);
  }
  syncAudioFromR2(known: Parameters<AudioStore['syncAudioFromR2']>[0]) {
    return this.audio.syncAudioFromR2(known);
  }

  // --- transcript delegates ---
  listTranscriptWords() {
    return this.transcript.listTranscriptWords();
  }
  insertTranscriptWord(data: Parameters<TranscriptStore['insertTranscriptWord']>[0]) {
    return this.transcript.insertTranscriptWord(data);
  }
  updateTranscriptWord(
    wordId: string,
    patch: Parameters<TranscriptStore['updateTranscriptWord']>[1],
  ) {
    return this.transcript.updateTranscriptWord(wordId, patch);
  }
  deleteTranscriptWord(wordId: string) {
    return this.transcript.deleteTranscriptWord(wordId);
  }

  // --- topic delegates ---
  listTopics() {
    return this.topics.listTopics();
  }
  insertTopic(data: Parameters<TopicStore['insertTopic']>[0]) {
    return this.topics.insertTopic(data);
  }
  updateTopic(topicId: string, patch: Parameters<TopicStore['updateTopic']>[1]) {
    return this.topics.updateTopic(topicId, patch);
  }
  deleteTopic(topicId: string) {
    return this.topics.deleteTopic(topicId);
  }
}


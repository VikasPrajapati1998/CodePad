/**
 * Message protocol between the AI engine controller (aiEngine.ts, main) and the AI utility process (aiWorker.ts),
 * plus the error type both sides use. Types only: nothing here runs.
 */

import type { ChatOutput, ChatTurn, GenOptions, RawSpec } from './aiPrompts';
import type { ChatLimits } from './chat';
import type { RewriteMode, RewriteStats } from './rewriter';
import type { SummaryPhase, SummaryStats } from './summarizer';

/** Error with a stable machine-readable code (`E_ENGINE | E_ABORTED | E_PROMPT_TOO_LONG | E_NO_MODEL | ...`). */
export interface EngineError extends Error {
  code: string;
}

/** What the loaded engine reports about itself. */
export interface EngineInfo {
  gpu: 'metal' | null;
  threads: number | null;
  modelId: string | null;
  /** Milliseconds spent in each load step. */
  timings?: Record<string, number>;
}

/** Lifecycle phase of the engine. */
export type EnginePhase = 'off' | 'loading' | 'ready' | 'error';

/** Engine state sent to the renderer (`busy` while a summary runs on a ready engine). */
export interface EngineState {
  state: EnginePhase | 'busy';
  error: string | null;
  gpu: 'metal' | null;
  threads: number | null;
  modelId: string | null;
}

/** Progress of a summary job; `loading` is reported while the model starts. */
export interface EngineProgress {
  phase: SummaryPhase | 'rewrite' | 'chat' | 'loading';
  current: number;
  total: number;
  markdown: string | null;
}

/** Main to worker. */
export type WorkerRequest =
  | { type: 'init'; modelPath: string; modelId: string; size: number; threads: number }
  | { type: 'suggest'; id: number; prompt: RawSpec; gen: GenOptions }
  | {
      type: 'summarize';
      id: number;
      text: string;
      name: string;
      style: string;
      chunkTokens: number;
      modelLabel?: string;
    }
  | {
      type: 'rewrite';
      id: number;
      text: string;
      mode: RewriteMode;
      instruction: string;
      languageId: string;
      chunkTokens: number;
      maxOutputTokens: number;
    }
  | {
      type: 'chat';
      id: number;
      instruction: string;
      fileName?: string;
      fileText?: string;
      history: ChatTurn[];
      output: ChatOutput;
      limits: ChatLimits;
    }
  | { type: 'cancel'; id: number }
  | { type: 'dispose' };

/** Worker to main: result of a suggestion. */
export interface SuggestResultMessage {
  type: 'suggestResult';
  id: number;
  text: string;
  stopReason: string;
}

/** Worker to main: result of a summary. */
export interface SummaryResultMessage {
  type: 'summaryResult';
  id: number;
  markdown: string;
  stats: SummaryStats;
}

/** Worker to main: result of a rewrite. */
export interface RewriteResultMessage {
  type: 'rewriteResult';
  id: number;
  text: string;
  warnings: string[];
  changes: number;
  stats: RewriteStats;
}

/** Worker to main: result of a chat request. */
export interface ChatResultMessage {
  type: 'chatResult';
  id: number;
  text: string;
  warnings: string[];
}

/** Worker to main. */
export type WorkerMessage =
  | { type: 'step'; label: string }
  | { type: 'ready'; info: EngineInfo }
  | { type: 'initError'; message: string }
  | SuggestResultMessage
  | SummaryResultMessage
  | RewriteResultMessage
  | ChatResultMessage
  | { type: 'progress'; id: number; phase: SummaryPhase | 'rewrite' | 'chat'; current: number; total: number; markdown: string | null }
  | { type: 'error'; id: number; code: string; message: string };

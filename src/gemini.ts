import { GoogleGenAI, Schema, Type } from '@google/genai';
import { ReviewConfig } from './config.js';
import { DiffChunk } from './diff.js';
import {
  buildChunkUserPrompt,
  buildJsonRepairPrompt,
  buildSystemPrompt,
  PullRequestMetadata,
} from './prompt.js';
import { parseAndValidateReviewJson, ReviewResponse } from './schema.js';

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface GenerateTextParams {
  model: string;
  systemInstruction: string;
  userPrompt: string;
}

export type GenerateTextFn = (params: GenerateTextParams) => Promise<string>;

/**
 * Structured output schema passed to @google/genai responseSchema.
 */
export const GEMINI_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: 'Concise summary of the reviewed diff changes and overall code quality.',
    },
    findings: {
      type: Type.ARRAY,
      description: 'List of actionable code review findings in the diff.',
      items: {
        type: Type.OBJECT,
        properties: {
          file: {
            type: Type.STRING,
            description: 'Relative file path from the diff.',
          },
          line: {
            type: Type.INTEGER,
            description: '1-based line number on the RIGHT side of the diff.',
          },
          severity: {
            type: Type.STRING,
            description: 'Severity level: critical, high, medium, or low.',
          },
          title: {
            type: Type.STRING,
            description: 'Short title summarizing the issue.',
          },
          comment: {
            type: Type.STRING,
            description: 'Clear explanation of the bug or risk and how to resolve it.',
          },
          suggestion: {
            type: Type.STRING,
            nullable: true,
            description: 'Concrete code replacement snippet, or null if not applicable.',
          },
          confidence: {
            type: Type.NUMBER,
            description: 'Confidence score between 0.0 and 1.0.',
          },
        },
        required: ['file', 'line', 'severity', 'title', 'comment', 'confidence'],
      },
    },
  },
  required: ['summary', 'findings'],
};

/**
 * Determines whether an error from the Gemini API is transient (429 rate limit or 5xx server error)
 * and eligible for exponential backoff retry.
 */
export function isRetryableGeminiError(error: unknown): boolean {
  if (!error) return false;

  const status =
    (error as { status?: number; statusCode?: number }).status ??
    (error as { statusCode?: number }).statusCode;
  if (typeof status === 'number') {
    if (status === 429 || (status >= 500 && status < 600)) {
      return true;
    }
  }

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes('429') ||
    message.includes('resource_exhausted') ||
    message.includes('rate limit') ||
    message.includes('quota') ||
    message.includes('500') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504') ||
    message.includes('unavailable') ||
    message.includes('internal') ||
    message.includes('overloaded') ||
    message.includes('fetch failed') ||
    message.includes('etimedout') ||
    message.includes('econnreset')
  );
}

/**
 * Executes an async operation with exponential backoff (up to `maxRetries` retries)
 * for rate limits (429) and transient 5xx server errors.
 */
export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    logger?: Logger;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const sleep =
    options.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableGeminiError(error)) {
        throw error;
      }
      attempt += 1;
      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      const errMsg = error instanceof Error ? error.message : String(error);
      options.logger?.warn(
        `Gemini API transient error (attempt ${attempt}/${maxRetries}): ${errMsg}. Retrying in ${delayMs}ms...`,
      );
      await sleep(delayMs);
    }
  }
}

/**
 * Creates a Gemini text generator backed by the official @google/genai SDK.
 */
export function createGeminiGenerator(apiKey: string): GenerateTextFn {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  return async ({ model, systemInstruction, userPrompt }: GenerateTextParams): Promise<string> => {
    const response = await ai.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_RESPONSE_SCHEMA,
      },
    });
    return response.text ?? '';
  };
}

/**
 * Reviews a single diff chunk using Gemini:
 * 1. Sends the chunk with strict JSON output instructions and exponential backoff on 429/5xx.
 * 2. Validates the response using Zod.
 * 3. If invalid, retries ONCE with a "fix your JSON" repair prompt.
 * 4. If still invalid (or if an unrecoverable error occurs), logs a warning and returns null
 *    so the caller skips the chunk without crashing the entire Action run.
 */
export async function reviewDiffChunk(
  chunk: DiffChunk,
  totalChunks: number,
  prMetadata: PullRequestMetadata,
  config: ReviewConfig,
  generateText: GenerateTextFn,
  logger: Logger,
  sleepFn?: (ms: number) => Promise<void>,
): Promise<ReviewResponse | null> {
  const systemInstruction = buildSystemPrompt(config);
  const userPrompt = buildChunkUserPrompt(chunk, totalChunks, prMetadata);

  let rawOutput: string;
  try {
    rawOutput = await withExponentialBackoff(
      () =>
        generateText({
          model: config.model,
          systemInstruction,
          userPrompt,
        }),
      { maxRetries: 3, logger, sleepFn },
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`Skipping chunk ${chunk.index}/${totalChunks} due to Gemini API error: ${errMsg}`);
    return null;
  }

  const firstValidation = parseAndValidateReviewJson(rawOutput);
  if (firstValidation.success && firstValidation.data) {
    return firstValidation.data;
  }

  logger.warn(
    `Chunk ${chunk.index}/${totalChunks} returned invalid JSON (${firstValidation.error}). Retrying once with JSON repair prompt...`,
  );

  // Retry once with a "fix your JSON" message
  const repairPrompt = buildJsonRepairPrompt(
    rawOutput,
    firstValidation.error ?? 'Unknown JSON validation error',
  );

  try {
    const repairedOutput = await withExponentialBackoff(
      () =>
        generateText({
          model: config.model,
          systemInstruction,
          userPrompt: repairPrompt,
        }),
      { maxRetries: 3, logger, sleepFn },
    );

    const secondValidation = parseAndValidateReviewJson(repairedOutput);
    if (secondValidation.success && secondValidation.data) {
      logger.info(`Chunk ${chunk.index}/${totalChunks} JSON successfully repaired on retry.`);
      return secondValidation.data;
    }

    logger.warn(
      `Skipping chunk ${chunk.index}/${totalChunks}: JSON remained invalid after retry (${secondValidation.error}).`,
    );
    return null;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.warn(
      `Skipping chunk ${chunk.index}/${totalChunks}: JSON repair request failed (${errMsg}).`,
    );
    return null;
  }
}

import { OpenAI } from "openai";

// ---------------------------------------------------------------------------
// Constants (matching doc2vec limits)
// ---------------------------------------------------------------------------
const MAX_EMBEDDING_TOKENS = 8191; // OpenAI text-embedding-3-large limit
const CHARS_PER_TOKEN = 2.5; // Conservative BPE estimate (code/JSON has many short tokens)
const MAX_EMBEDDING_CHARS = Math.floor(MAX_EMBEDDING_TOKENS * CHARS_PER_TOKEN); // ~20 477

// Batch size: OpenAI allows up to 2048 inputs per request, but keep it
// conservative to stay well within rate-limits.
const BATCH_SIZE = 64;

// ---------------------------------------------------------------------------
// Embedder
// ---------------------------------------------------------------------------

export interface EmbedderOptions {
  apiKey?: string;
  model?: string;
  /** Override for testing */
  client?: OpenAI;
}

/**
 * Creates an embedder function bound to a given OpenAI client/model.
 */
export function createEmbedder(options: EmbedderOptions = {}) {
  const model = options.model ?? process.env.OPENAI_MODEL ?? "text-embedding-3-large";
  const client =
    options.client ??
    new OpenAI({ apiKey: options.apiKey ?? process.env.OPENAI_API_KEY });

  /**
   * Embeds a single text string. Truncates if necessary.
   */
  async function embedText(text: string): Promise<number[]> {
    const truncated =
      text.length > MAX_EMBEDDING_CHARS ? text.slice(0, MAX_EMBEDDING_CHARS) : text;

    const response = await client.embeddings.create({
      model,
      input: truncated,
    });

    const embedding = response.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error("No embedding returned from OpenAI API");
    }
    return embedding;
  }

  /**
   * Embeds a batch of texts, splitting into sub-batches to avoid API limits.
   * Sub-batches are processed in parallel (up to CONCURRENCY at a time).
   */
  async function embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Split into sub-batches of BATCH_SIZE
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      batches.push(
        texts.slice(i, i + BATCH_SIZE).map((t) =>
          t.length > MAX_EMBEDDING_CHARS ? t.slice(0, MAX_EMBEDDING_CHARS) : t,
        ),
      );
    }

    // Process up to CONCURRENCY batches in parallel
    const CONCURRENCY = 4;
    const batchResults: number[][][] = [];

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const window = batches.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        window.map(async (batch) => {
          const response = await client.embeddings.create({ model, input: batch });
          return response.data
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((d) => d.embedding);
        }),
      );
      batchResults.push(...results);
    }

    return batchResults.flat();
  }

  return { embedText, embedBatch };
}

// ---------------------------------------------------------------------------
// Default singleton (lazy-initialised)
// ---------------------------------------------------------------------------

let _defaultEmbedder: ReturnType<typeof createEmbedder> | null = null;

function getDefaultEmbedder(): ReturnType<typeof createEmbedder> {
  if (!_defaultEmbedder) {
    _defaultEmbedder = createEmbedder();
  }
  return _defaultEmbedder;
}

/** Convenience wrapper that uses the default embedder singleton. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  return getDefaultEmbedder().embedBatch(texts);
}

/** Convenience wrapper that uses the default embedder singleton. */
export async function embedText(text: string): Promise<number[]> {
  return getDefaultEmbedder().embedText(text);
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEmbedder } from "../src/embedder";

// ---------------------------------------------------------------------------
// Mock OpenAI client
// ---------------------------------------------------------------------------

function makeOpenAIMock(embedding: number[] = [0.1, 0.2, 0.3]) {
  return {
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ index: 0, embedding }],
        model: "text-embedding-3-large",
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }),
    },
  } as unknown as import("openai").OpenAI;
}

describe("createEmbedder", () => {
  it("returns embedText and embedBatch functions", () => {
    const client = makeOpenAIMock();
    const embedder = createEmbedder({ client });
    expect(typeof embedder.embedText).toBe("function");
    expect(typeof embedder.embedBatch).toBe("function");
  });

  describe("embedText", () => {
    it("calls the OpenAI API with the input text", async () => {
      const mock = makeOpenAIMock([0.5, 0.6, 0.7]);
      const embedder = createEmbedder({ client: mock });
      const result = await embedder.embedText("hello world");
      expect(mock.embeddings.create).toHaveBeenCalledOnce();
      expect(result).toEqual([0.5, 0.6, 0.7]);
    });

    it("truncates text exceeding 32764 characters", async () => {
      const mock = makeOpenAIMock([0.1]);
      const embedder = createEmbedder({ client: mock });
      const longText = "a".repeat(40000);
      await embedder.embedText(longText);
      const call = vi.mocked(mock.embeddings.create).mock.calls[0][0];
      expect((call as { input: string }).input.length).toBe(32764);
    });

    it("does not truncate text within limit", async () => {
      const mock = makeOpenAIMock([0.1]);
      const embedder = createEmbedder({ client: mock });
      const text = "hello world";
      await embedder.embedText(text);
      const call = vi.mocked(mock.embeddings.create).mock.calls[0][0];
      expect((call as { input: string }).input).toBe(text);
    });

    it("throws when API returns no embedding", async () => {
      const mock = {
        embeddings: {
          create: vi.fn().mockResolvedValue({ data: [] }),
        },
      } as unknown as import("openai").OpenAI;
      const embedder = createEmbedder({ client: mock });
      await expect(embedder.embedText("test")).rejects.toThrow(
        "No embedding returned",
      );
    });
  });

  describe("embedBatch", () => {
    it("returns empty array for empty input", async () => {
      const mock = makeOpenAIMock();
      const embedder = createEmbedder({ client: mock });
      const result = await embedder.embedBatch([]);
      expect(result).toEqual([]);
      expect(mock.embeddings.create).not.toHaveBeenCalled();
    });

    it("returns embeddings in input order", async () => {
      const emb1 = [0.1, 0.2];
      const emb2 = [0.3, 0.4];
      const mock = {
        embeddings: {
          create: vi.fn().mockResolvedValue({
            data: [
              // Intentionally reversed to test sorting by index
              { index: 1, embedding: emb2 },
              { index: 0, embedding: emb1 },
            ],
          }),
        },
      } as unknown as import("openai").OpenAI;

      const embedder = createEmbedder({ client: mock });
      const result = await embedder.embedBatch(["text1", "text2"]);
      expect(result[0]).toEqual(emb1);
      expect(result[1]).toEqual(emb2);
    });

    it("batches requests when input exceeds BATCH_SIZE (64)", async () => {
      const mock = {
        embeddings: {
          create: vi.fn().mockImplementation(
            async (params: { input: string[] }) => ({
              data: params.input.map((_, i) => ({ index: i, embedding: [i] })),
            }),
          ),
        },
      } as unknown as import("openai").OpenAI;

      const embedder = createEmbedder({ client: mock });
      const texts = Array.from({ length: 100 }, (_, i) => `text ${i}`);
      const results = await embedder.embedBatch(texts);

      // Should have made 2 API calls (64 + 36)
      expect(mock.embeddings.create).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(100);
    });

    it("truncates long texts in batch", async () => {
      const mock = {
        embeddings: {
          create: vi.fn().mockResolvedValue({
            data: [{ index: 0, embedding: [0.1] }],
          }),
        },
      } as unknown as import("openai").OpenAI;

      const embedder = createEmbedder({ client: mock });
      const longText = "x".repeat(50000);
      await embedder.embedBatch([longText]);

      const call = vi.mocked(mock.embeddings.create).mock.calls[0][0];
      const batchInput = (call as { input: string[] }).input;
      expect(batchInput[0].length).toBe(32764);
    });
  });
});

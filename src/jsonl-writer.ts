import fs from "node:fs/promises";
import path from "node:path";

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (current instanceof Error) {
      return {
        name: current.name,
        message: current.message,
        stack: current.stack,
      };
    }
    if (current && typeof current === "object") {
      if (seen.has(current)) {
        return "[Circular]";
      }
      seen.add(current);
    }
    return current;
  });
}

export class JsonlWriter {
  readonly filePath: string;

  #queue: Promise<void> = Promise.resolve();
  #dirReady = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async write(record: unknown): Promise<void> {
    const line = `${safeJsonStringify(record)}\n`;
    this.#queue = this.#queue.then(async () => {
      if (!this.#dirReady) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        this.#dirReady = true;
      }
      await fs.appendFile(this.filePath, line, "utf8");
    });
    return this.#queue;
  }

  async close(): Promise<void> {
    await this.#queue;
  }
}

import { describe, expect, it } from "vitest";
import {
  MemoryArenaPublicApplication,
  type MemoryArenaPublicBackend,
} from "../src/entrypoints/memoryarena-public-api/application.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("MemoryArena Public concurrent execution", () => {
  it.each(["add", "initialize"] as const)("invalidates cached wraps even when %s fails after changing storage", async (operation) => {
    let content = "old memory";
    let wrapCalls = 0;
    const failAfterMutation = async (): Promise<never> => {
      content = "new memory";
      throw new Error("audit failed after persistence");
    };
    const application = new MemoryArenaPublicApplication({
      initialize: failAfterMutation,
      add: failAfterMutation,
      wrap: async (input) => {
        wrapCalls += 1;
        return { userId: input.userId, prompt: content };
      },
    });
    const input = { userId: "same", memorySystemName: "picorer", question: "question" };
    expect((await application.wrap(input)).prompt).toBe("old memory");
    await expect(application[operation]({ ...input, chunk: "new memory" })).rejects.toThrow("audit failed");
    expect((await application.wrap(input)).prompt).toBe("new memory");
    expect(wrapCalls).toBe(2);
  });

  it("serializes one user while allowing a different user to run", async () => {
    const firstRelease = deferred();
    const started: string[] = [];
    let calls = 0;
    const backend: MemoryArenaPublicBackend = {
      initialize: async (input) => ({ ...input, generation: 1 }),
      wrap: async (input) => ({ userId: input.userId, prompt: input.question }),
      add: async (input) => {
        calls += 1;
        const call = calls;
        started.push(`${input.userId}-${call}`);
        if (call === 1) await firstRelease.promise;
        return { userId: input.userId, response: null };
      },
    };
    const application = new MemoryArenaPublicApplication(backend);
    const first = application.add({
      userId: "same",
      memorySystemName: "picorer",
      chunk: "one",
    });
    await Promise.resolve();
    const secondSame = application.add({
      userId: "same",
      memorySystemName: "picorer",
      chunk: "two",
    });
    const other = application.add({
      userId: "other",
      memorySystemName: "picorer",
      chunk: "parallel",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(["same-1", "other-2"]);
    await other;
    firstRelease.resolve();
    await Promise.all([first, secondSame]);
    expect(started).toEqual(["same-1", "other-2", "same-3"]);
  });

  it("allows same-user wraps to overlap while keeping lifecycle writes exclusive", async () => {
    const wrapRelease = deferred();
    const started: string[] = [];
    const backend: MemoryArenaPublicBackend = {
      initialize: async (input) => ({ ...input, generation: 1 }),
      add: async (input) => {
        started.push("add");
        return { userId: input.userId, response: null };
      },
      wrap: async (input) => {
        started.push(input.question);
        if (input.question !== "late") await wrapRelease.promise;
        return { userId: input.userId, prompt: input.question };
      },
    };
    const application = new MemoryArenaPublicApplication(backend);
    const input = (question: string) => ({
      userId: "same",
      memorySystemName: "picorer",
      question,
    });

    const first = application.wrap(input("first"));
    const second = application.wrap(input("second"));
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);

    const add = application.add({
      userId: "same",
      memorySystemName: "picorer",
      chunk: "new memory",
    });
    const late = application.wrap(input("late"));
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);

    wrapRelease.resolve();
    await Promise.all([first, second, add, late]);
    expect(started).toEqual(["first", "second", "add", "late"]);
  });

  it("coalesces exact wrap retries and invalidates the result after a write", async () => {
    const release = deferred();
    let wrapCalls = 0;
    const backend: MemoryArenaPublicBackend = {
      initialize: async (input) => ({ ...input, generation: 1 }),
      add: async (input) => ({ userId: input.userId, response: null }),
      wrap: async (input) => {
        wrapCalls += 1;
        if (wrapCalls === 1) await release.promise;
        return { userId: input.userId, prompt: `${input.question}-${wrapCalls}` };
      },
    };
    const application = new MemoryArenaPublicApplication(backend);
    const input = {
      userId: "same",
      memorySystemName: "picorer",
      question: "question",
    };

    const first = application.wrap(input);
    const retry = application.wrap(input);
    await Promise.resolve();
    await Promise.resolve();
    expect(wrapCalls).toBe(1);
    release.resolve();
    await expect(Promise.all([first, retry])).resolves.toEqual([
      { userId: "same", prompt: "question-1" },
      { userId: "same", prompt: "question-1" },
    ]);
    await expect(application.wrap(input)).resolves.toEqual({
      userId: "same",
      prompt: "question-1",
    });
    expect(wrapCalls).toBe(1);

    await application.add({
      userId: "same",
      memorySystemName: "picorer",
      chunk: "new memory",
    });
    await expect(application.wrap(input)).resolves.toEqual({
      userId: "same",
      prompt: "question-2",
    });
    expect(wrapCalls).toBe(2);
    expect(application.health()).toMatchObject({
      requests: { coalesced: 2 },
    });
  });

  it("bounds globally active retrieval agents while exposing queue depth", async () => {
    const release = deferred();
    const started: string[] = [];
    const backend: MemoryArenaPublicBackend = {
      initialize: async (input) => ({ ...input, generation: 1 }),
      add: async (input) => ({ userId: input.userId, response: null }),
      wrap: async (input) => {
        started.push(input.question);
        await release.promise;
        return { userId: input.userId, prompt: input.question };
      },
    };
    const application = new MemoryArenaPublicApplication(backend, {
      maximumConcurrentWraps: 2,
    });
    const wrap = (question: string) => application.wrap({
      userId: question,
      memorySystemName: "picorer",
      question,
    });

    const requests = [wrap("one"), wrap("two"), wrap("three")];
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["one", "two"]);
    expect(application.health()).toMatchObject({
      admission: { maximumConcurrent: 2, active: 2, queued: 1 },
    });
    release.resolve();
    await Promise.all(requests);
    expect(started).toEqual(["one", "two", "three"]);
    expect(application.health()).toMatchObject({
      admission: { active: 0, queued: 0, started: 3, completed: 3 },
    });
  });
});

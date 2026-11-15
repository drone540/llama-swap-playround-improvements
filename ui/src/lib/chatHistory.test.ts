import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatHistory, conversationTitle } from "./chatHistory";

const histories: ReturnType<typeof createChatHistory>[] = [];
function setup(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: (key: string) => { data.delete(key); },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  };
  const open = () => { const history = createChatHistory(storage); histories.push(history); return history; };
  return { data, storage, open, history: open() };
}
const prompt = (text: string) => [{ role: "user" as const, content: text }];
afterEach(() => { histories.splice(0).forEach((history) => history.destroy()); vi.useRealTimers(); });

describe("bounded chat history", () => {
  it("defaults to keeping only the current conversation, matching the existing New Chat behavior", () => {
    const { history, open } = setup();
    expect(get(history).limit).toBe(1);
    history.messages.set(prompt("First")); history.flush();
    expect(get(open().messages)).toEqual(prompt("First"));
    history.newChat();
    expect(get(history.messages)).toEqual([]);
    expect(get(open().messages)).toEqual([]);
    expect(get(history).items.some((item) => item.messages.length)).toBe(false);
  });

  it("keeps a bounded list and reopens earlier messages, including images and reasoning", () => {
    const { history, open } = setup();
    history.setLimit(3);
    history.messages.set(prompt("First")); history.flush();
    const first = get(history.activeId);
    history.newChat(); history.messages.set(prompt("Second")); history.flush();
    history.newChat();
    const messages = [{ role: "user" as const, content: [
      { type: "text" as const, text: "Third" },
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,test" } },
    ] }, { role: "assistant" as const, content: "Answer", reasoning_content: "Reason", interrupted: "cancelled" as const }];
    history.messages.set(messages); history.flush();
    expect(get(open().messages)).toEqual(messages);
    expect(get(history).items).toHaveLength(3);
    history.open(first);
    expect(get(history.messages)).toEqual(prompt("First"));
    expect(get(open().messages)).toEqual(prompt("First"));
    history.newChat();
    expect(get(history).items).toHaveLength(3);
    expect(get(history).items.some((item) => item.messages[0]?.content === "First")).toBe(true);
  });

  it("setting zero removes saved history and starts blank on reload and page entry", () => {
    const { history, open, data } = setup();
    history.messages.set(prompt("Old")); history.flush();
    history.setLimit(0);
    history.messages.set(prompt("Ephemeral")); history.flush();
    expect([...data.keys()].some((key) => key.startsWith("playground-chat-menu-item:"))).toBe(false);
    expect(get(open().messages)).toEqual([]);
    history.enter();
    expect(get(history.messages)).toEqual([]);
    expect(get(history).limit).toBe(0);
  });

  it("clear erases all simple history while preserving the sidebar version's data and retention setting", () => {
    const preserved = '{"messages":"sidebar version"}';
    const { history, data, open } = setup({ "playground-chat-history:preserved": preserved });
    history.setLimit(3);
    history.messages.set(prompt("First")); history.newChat(); history.messages.set(prompt("Second")); history.flush();
    history.clear();
    expect(get(history.messages)).toEqual([]);
    expect(get(history).items).toEqual([]);
    expect(get(open().messages)).toEqual([]);
    expect(get(open()).limit).toBe(3);
    expect(data.get("playground-chat-history:preserved")).toBe(preserved);
  });

  it("an untouched tab cannot overwrite a newly saved conversation", () => {
    const { history, open, storage } = setup();
    history.setLimit(3); history.messages.set(prompt("First")); history.flush();
    const idle = open();
    history.newChat(); history.messages.set(prompt("Second")); history.flush();
    storage.setItem.mockClear(); idle.flush();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(get(open()).items.filter((item) => item.messages.length)).toHaveLength(2);
  });

  it("a stale writer cannot restore history after another tab clears it", () => {
    const { history, open } = setup();
    history.messages.set(prompt("First")); history.flush();
    const stale = open(); stale.messages.set(prompt("Pending"));
    history.clear(); stale.flush();
    expect(get(stale.messages)).toEqual([]);
    expect(get(open().messages)).toEqual([]);
  });

  it("migrates the original saved conversation near the storage quota without keeping a duplicate", () => {
    const original = JSON.stringify(prompt("x".repeat(2000)));
    const { history, storage, data, open } = setup({ "playground-messages": original });
    storage.setItem.mockImplementation((key, value) => {
      const used = [...data].reduce((total, [other, text]) => total + (other === key ? 0 : text.length), 0);
      if (used + value.length > 3200) throw new DOMException("Full", "QuotaExceededError");
      data.set(key, value);
    });
    history.flush();
    expect(get(history).error).toBe("");
    expect(data.has("playground-messages")).toBe(false);
    expect(get(open().messages)).toEqual(JSON.parse(original));
  });

  it("reports storage failures and preserves the original conversation if migration fails", () => {
    const original = JSON.stringify(prompt("Keep me"));
    const { history, storage, data } = setup({ "playground-messages": original });
    storage.setItem.mockImplementation((key, value) => {
      if (key.startsWith("playground-chat-menu-item:")) throw new DOMException("Full", "QuotaExceededError");
      data.set(key, value);
    });
    history.flush();
    expect(get(history).error).toContain("could not be saved");
    expect(data.get("playground-messages")).toBe(original);
    expect(get(history.messages)).toEqual(prompt("Keep me"));
  });

  it("rejects invalid retention counts and creates readable menu labels", () => {
    const { history } = setup();
    for (const value of [-1, 1.5, NaN, Infinity]) history.setLimit(value);
    expect(get(history).limit).toBe(1);
    expect(conversationTitle(prompt("  One\n two  "))).toBe("One two");
  });
});

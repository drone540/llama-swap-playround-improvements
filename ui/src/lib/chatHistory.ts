import { derived, get, writable, type Writable } from "svelte/store";
import { getTextContent, type ChatMessage } from "./types";

export type PlainMessage = ChatMessage & { role: "user" | "assistant" | "system" };
interface Conversation { id: string; updatedAt: number; epoch: string; messages: PlainMessage[] }
type HistoryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const PREFIX = "playground-chat-menu-item:";
const LIMIT = "playground-chat-menu-limit";
const EPOCH = "playground-chat-menu-epoch";
const ACTIVE = "playground-chat-menu-active";
const LEGACY = "playground-messages";

export function conversationTitle(messages: PlainMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  return first ? getTextContent(first.content).trim().replace(/\s+/g, " ").slice(0, 80) || "Image conversation" : "Empty conversation";
}

function plainMessages(value: unknown): PlainMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((message): message is PlainMessage => message &&
    ["user", "assistant", "system"].includes(message.role) && !message.tool_calls?.length &&
    (typeof message.content === "string" || (Array.isArray(message.content) && message.content.every((part: any) =>
      part && ((part.type === "text" && typeof part.text === "string") ||
        (part.type === "image_url" && typeof part.image_url?.url === "string"))))));
}

/** A bounded test-bench history; each conversation is written independently. */
export function createChatHistory(storage?: HistoryStorage) {
  const raw = (key: string) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const parse = (value: string | null): unknown => { try { return JSON.parse(value ?? "null"); } catch { return null; } };
  const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  let epoch = raw(EPOCH) ?? "";
  const blank = (): Conversation => ({ id: id(), epoch, updatedAt: Date.now(), messages: [] });
  const limitValue = parse(raw(LIMIT));
  let limit = typeof limitValue === "number" && Number.isSafeInteger(limitValue) && limitValue >= 0 ? limitValue : 1;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let legacy = raw(LEGACY);
  let migrationOnly = false;

  function keys(): string[] {
    if (!storage) return [];
    return Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(PREFIX));
  }
  function readItems(): Conversation[] {
    return keys().flatMap((key) => {
      const item = parse(raw(key)) as Conversation | null;
      return item?.epoch === epoch && typeof item.id === "string" && key === PREFIX + item.id &&
        Number.isFinite(item.updatedAt) && Array.isArray(item.messages)
        ? [{ ...item, messages: plainMessages(item.messages) }] : [];
    }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }
  let items = limit > 0 ? readItems().slice(0, limit) : [];
  let current = items.find((item) => item.id === raw(ACTIVE)) ?? items[0] ?? blank();
  const oldMessages = parse(legacy);
  if (!items.length && limit > 0 && Array.isArray(oldMessages)) {
    current = { ...blank(), id: "legacy", messages: plainMessages(oldMessages) };
    items = [current];
    dirty = true;
    migrationOnly = true;
  } else legacy = null;
  const state = writable({ current, items, limit, error: "" });
  const activeId = derived(state, (value) => value.current.id);
  function error() { state.update((value) => ({ ...value, error: "Chat history could not be saved. Browser storage may be full or unavailable." })); }
  function schedule() { if (storage) timer ??= setTimeout(flush, 2000); }
  function trim(): Conversation[] {
    const keep = readItems().slice(0, limit);
    const keepKeys = new Set(keep.map((item) => PREFIX + item.id));
    for (const key of keys()) if (!keepKeys.has(key)) storage!.removeItem(key);
    return keep;
  }
  function sync() {
    const nextEpoch = raw(EPOCH) ?? "";
    const nextLimit = parse(raw(LIMIT));
    if (typeof nextLimit === "number" && Number.isSafeInteger(nextLimit) && nextLimit >= 0) limit = nextLimit;
    if (nextEpoch !== epoch) {
      epoch = nextEpoch;
      dirty = false;
      legacy = null;
      state.set({ current: blank(), items: limit > 0 ? readItems().slice(0, limit) : [], limit, error: "" });
    } else {
      const saved = limit > 0 ? readItems().slice(0, limit) : [];
      state.update((value) => ({ ...value, limit, items: saved,
        current: !dirty ? saved.find((item) => item.id === value.current.id) ?? value.current : value.current }));
    }
  }
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (!storage || !dirty) return;
    if ((raw(EPOCH) ?? "") !== epoch) { sync(); return; }
    const storedLimit = parse(raw(LIMIT));
    if (typeof storedLimit === "number" && Number.isSafeInteger(storedLimit) && storedLimit >= 0) limit = storedLimit;
    if (limit === 0) { dirty = false; return; }
    try {
      const value = get(state).current;
      const key = PREFIX + value.id;
      // Another tab may have already migrated and continued the old chat.
      if (!(migrationOnly && raw(LEGACY) === null && raw(key) !== null)) {
        const json = JSON.stringify(value);
        try { storage.setItem(key, json); } catch (failure) {
          if (!legacy || raw(LEGACY) !== legacy || !(failure instanceof DOMException) || failure.name !== "QuotaExceededError") throw failure;
          storage.removeItem(LEGACY);
          try { storage.setItem(key, json); } catch (retryFailure) {
            storage.setItem(LEGACY, legacy);
            throw retryFailure;
          }
        }
      }
      if (legacy && raw(LEGACY) === legacy) storage.removeItem(LEGACY);
      legacy = null;
      migrationOnly = false;
      storage.setItem(ACTIVE, value.id);
      dirty = false;
      state.update((value) => ({ ...value, items: trim(), limit, error: "" }));
    } catch { error(); }
  }
  const messages: Writable<PlainMessage[]> = {
    subscribe: derived(state, (value) => value.current.messages).subscribe,
    set(messages) {
      if ((raw(EPOCH) ?? "") !== epoch) { sync(); return; }
      dirty = true;
      migrationOnly = false;
      state.update((value) => ({ ...value, current: { ...value.current, messages, updatedAt: Date.now() } }));
      schedule();
    },
    update(update) { messages.set(update(get(messages))); },
  };
  function resetStorage(keepCurrent: boolean) {
    clearTimeout(timer);
    timer = undefined;
    epoch = id();
    dirty = false;
    legacy = null;
    state.update((value) => ({ ...value, current: keepCurrent ? { ...value.current, epoch } : blank(), items: [], limit }));
    if (!storage) return;
    try {
      storage.setItem(EPOCH, epoch);
      // A stale in-flight write carries the old epoch and will be ignored.
      for (const key of keys()) {
        if ((parse(raw(key)) as Conversation | null)?.epoch !== epoch) storage.removeItem(key);
      }
      storage.removeItem(ACTIVE);
      if (Array.isArray(parse(raw(LEGACY)))) storage.removeItem(LEGACY);
      state.update((value) => ({ ...value, error: "" }));
    } catch { error(); }
  }
  if (dirty) schedule();
  return {
    subscribe: state.subscribe, messages, activeId, flush, sync,
    newChat() {
      if (!get(messages).length) return;
      flush();
      state.update((value) => ({ ...value, current: blank() }));
      dirty = limit > 0;
      flush();
    },
    open(id: string) {
      flush();
      const item = get(state).items.find((item) => item.id === id);
      if (!item) return;
      state.update((value) => ({ ...value, current: { ...item, updatedAt: Date.now() } }));
      dirty = true;
      flush();
    },
    setLimit(value: number) {
      if (!Number.isSafeInteger(value) || value < 0 || value === limit) return;
      const previous = limit;
      limit = value;
      try { storage?.setItem(LIMIT, JSON.stringify(limit)); } catch { limit = previous; error(); return; }
      if (!limit) resetStorage(true);
      else {
        state.update((value) => ({ ...value, limit, current: { ...value.current, updatedAt: Date.now() } }));
        dirty = true;
        flush();
      }
    },
    clear() { resetStorage(false); },
    enter() { sync(); if (limit === 0) state.update((value) => ({ ...value, current: blank() })); },
    destroy() { flush(); clearTimeout(timer); },
  };
}

let storage: HistoryStorage | undefined;
try { if (typeof window !== "undefined") storage = window.localStorage; } catch {
  storage = { getItem: () => null, setItem: () => { throw new Error("Storage unavailable"); },
    removeItem: () => {}, key: () => null, length: 0 };
}
export const chatHistory = createChatHistory(storage);
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.storageArea === storage && (event.key === null || event.key.startsWith("playground-chat-menu"))) chatHistory.sync();
  });
  window.addEventListener("pagehide", chatHistory.flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") chatHistory.flush(); });
}

/**
 * The slice of the Honcho client memory.ts already uses, backed by SQLite.
 */
import { chat } from "./provider";
import { addFacts, addMessages, cardLines, deleteFact, deleteSession, ensureSession, getFacts, listFacts, searchFacts, setCardLines, type Fact } from "./memory-store";

type FactPage = {
  items: Fact[];
  total: number;
  hasNextPage: boolean;
  getNextPage: () => Promise<FactPage | null>;
  [Symbol.asyncIterator]: () => AsyncGenerator<Fact>;
};

function page(items: Fact[], total = items.length): FactPage {
  const value: FactPage = {
    items,
    total,
    hasNextPage: false,
    getNextPage: async () => null,
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
  return value;
}

export function localHoncho(bank: string) {
  const peers = new Map<string, LocalPeer>();
  const peer = async (id: string) => {
    let p = peers.get(id);
    if (!p) peers.set(id, (p = new LocalPeer(bank, id)));
    return p;
  };
  const session = async (id: string) => {
    ensureSession(bank, id);
    return new LocalSession(bank, id);
  };
  return {
    workspaceId: bank,
    peer,
    session,
    localSession: (id: string) => ({ delete: async () => deleteSession(bank, id) }),
    conclusions: {
      list: async () => page(listFacts(bank, { limit: 100 })),
    },
  };
}

class LocalPeer {
  constructor(
    private bank: string,
    private id: string,
  ) {}
  message(text: string) {
    return { peerId: this.id, content: text };
  }
  async getCard() {
    return cardLines(this.bank);
  }
  async setCard(lines: string[]) {
    setCardLines(this.bank, lines);
  }
  async context(opts: { searchQuery?: string; searchTopK?: number; maxConclusions?: number }) {
    const found = await searchFacts(this.bank, opts.searchQuery || "", opts.maxConclusions ?? opts.searchTopK ?? 8);
    return { representation: found.map((f) => f.content).join("\n") };
  }
  async chat(question: string) {
    const found = await searchFacts(this.bank, question, 8);
    const card = cardLines(this.bank);
    const known = [...card, ...found.map((f) => f.content)].slice(0, 16);
    if (!known.length) return "Nothing on that.";
    try {
      const result = await chat({
        role: "fast",
        messages: [
          { role: "system", content: "Answer only from the notes. If they don't say, answer that nothing was saved." },
          { role: "user", content: `Notes:\n${known.map((l) => `- ${l}`).join("\n")}\n\nQuestion: ${question}` },
        ],
      });
      return result.content.trim() || known[0];
    } catch {
      return known.slice(0, 4).join("\n");
    }
  }
  conclusions = {
    query: (text: string, n: number) => searchFacts(this.bank, text, n),
    create: (items: { content: string; sessionId?: string }[]) => addFacts(this.bank, items),
    delete: async (id: string) => {
      deleteFact(this.bank, id);
    },
    list: async (opts: { size?: number; filters?: { session_id?: { in?: string[] } } } = {}) => {
      const items = listFacts(this.bank, { sessionIds: opts.filters?.session_id?.in, limit: opts.size ?? 100 });
      return page(items);
    },
    getMany: async (ids: string[]) => getFacts(this.bank, ids),
  };
}

class LocalSession {
  constructor(
    private bank: string,
    private id: string,
  ) {}
  async addPeers() {}
  async addMessages(messages: { peerId?: string; content?: string }[]) {
    addMessages(
      this.bank,
      this.id,
      messages.map((m) => ({ peerId: m.peerId || "user", content: String(m.content ?? "") })),
    );
  }
  async delete() {
    deleteSession(this.bank, this.id);
  }
}

export function localBank(bankName: string) {
  const client = localHoncho(bankName);
  return {
    client,
    peers: new Map<string, Promise<LocalPeer>>(),
    sessions: new Map<string, Promise<LocalSession>>(),
    recent: [] as { id: string; text: string; at: number }[],
    queue: Promise.resolve() as Promise<unknown>,
  };
}

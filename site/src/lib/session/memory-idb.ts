/**
 * OX-S03: an in-memory implementation of the IndexedDB subset the journey store uses. It is
 * the ephemeral fallback when a browser offers no IndexedDB (private modes), and the test
 * double with fault injection. Semantics follow IndexedDB where the store depends on them:
 * requests run in order, a transaction commits only after its last request, a failed
 * request aborts the transaction and nothing from an aborted transaction is kept.
 */

type Listener = ((event: any) => void) | null;
const later = (fn: () => void) => setTimeout(fn, 0);

class MemRequest {
  result: unknown = undefined;
  error: DOMException | null = null;
  readyState: 'pending' | 'done' = 'pending';
  onsuccess: Listener = null;
  onerror: Listener = null;
  onupgradeneeded: Listener = null;
  onblocked: Listener = null;
}

class MemObjectStore {
  constructor(private tx: MemTransaction, private name: string, private keyPath: string) {}
  private data() {
    return this.tx.working.get(this.name)!;
  }
  private run(op: () => unknown, write = false): MemRequest {
    const req = new MemRequest();
    this.tx.enqueue(req, () => {
      if (write && this.tx.mode !== 'readwrite') throw new DOMException('Read-only transaction', 'ReadOnlyError');
      return op();
    }, write);
    return req;
  }
  get(key: string) {
    return this.run(() => {
      const v = this.data().get(key);
      return v === undefined ? undefined : structuredClone(v);
    });
  }
  getAll() {
    return this.run(() => [...this.data().values()].map((v) => structuredClone(v)));
  }
  put(value: Record<string, unknown>) {
    return this.run(() => {
      const key = value[this.keyPath] as string;
      if (typeof key !== 'string') throw new DOMException('Missing key', 'DataError');
      this.data().set(key, structuredClone(value));
      return key;
    }, true);
  }
  delete(key: string) {
    return this.run(() => {
      this.data().delete(key);
      return undefined;
    }, true);
  }
}

class MemTransaction {
  oncomplete: Listener = null;
  onerror: Listener = null;
  onabort: Listener = null;
  error: DOMException | null = null;
  working: Map<string, Map<string, unknown>>;
  private queue: Array<() => void> = [];
  private finished = false;
  private running = false;

  constructor(private db: MemDatabase, names: string[], public mode: 'readonly' | 'readwrite') {
    this.working = new Map(names.map((n) => [n, new Map(db.stores.get(n)!.data)]));
    later(() => this.pump());
  }

  objectStore(name: string) {
    const s = this.db.stores.get(name);
    if (!s || !this.working.has(name)) throw new DOMException(`No store ${name} in this transaction`, 'NotFoundError');
    return new MemObjectStore(this, name, s.keyPath);
  }

  enqueue(req: MemRequest, op: () => unknown, write: boolean) {
    if (this.finished) throw new DOMException('Transaction finished', 'TransactionInactiveError');
    this.queue.push(() => {
      try {
        const injected = write ? this.db.factory.takeWriteFault() : null;
        if (injected) throw injected;
        req.result = op();
        req.readyState = 'done';
        req.onsuccess?.({ target: req });
      } catch (err) {
        req.error = err as DOMException;
        req.readyState = 'done';
        req.onerror?.({ target: req, preventDefault() {} });
        this.abort(err as DOMException);
      }
    });
    if (!this.running) later(() => this.pump());
  }

  private pump() {
    if (this.finished || this.running) return;
    this.running = true;
    while (this.queue.length && !this.finished) this.queue.shift()!();
    this.running = false;
    if (this.finished) return;
    later(() => {
      if (this.finished || this.queue.length) return this.pump();
      this.finished = true;
      for (const [name, map] of this.working) this.db.stores.get(name)!.data = map;
      this.oncomplete?.({ target: this });
    });
  }

  abort(error: DOMException = new DOMException('Aborted', 'AbortError')) {
    if (this.finished) return;
    this.finished = true;
    this.error = error;
    this.queue = [];
    later(() => {
      this.onerror?.({ target: this });
      this.onabort?.({ target: this });
    });
  }
}

class MemDatabase {
  stores = new Map<string, { keyPath: string; data: Map<string, unknown> }>();
  version = 0;
  closed = false;
  onversionchange: Listener = null;
  constructor(public factory: MemoryIDBFactory, public name: string) {}
  get objectStoreNames() {
    return { contains: (n: string) => this.stores.has(n) };
  }
  createObjectStore(name: string, opts: { keyPath: string }) {
    this.stores.set(name, { keyPath: opts.keyPath, data: new Map() });
  }
  transaction(names: string | string[], mode: 'readonly' | 'readwrite' = 'readonly') {
    if (this.closed) throw new DOMException('Database closed', 'InvalidStateError');
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) if (!this.stores.has(n)) throw new DOMException(`No store ${n}`, 'NotFoundError');
    return new MemTransaction(this, list, mode);
  }
  close() {
    this.closed = true;
  }
}

export class MemoryIDBFactory {
  private databases = new Map<string, MemDatabase>();
  private writeFaults: DOMException[] = [];
  blockNextOpen = false;
  failNextOpen = false;

  /** The next write request fails with this error and aborts its transaction. */
  injectWriteFault(error: DOMException) {
    this.writeFaults.push(error);
  }

  takeWriteFault(): DOMException | null {
    return this.writeFaults.shift() || null;
  }

  /** Simulate another tab opening a newer database version. */
  fireVersionChange(name: string) {
    this.databases.get(name)?.onversionchange?.({ oldVersion: 1, newVersion: 2 });
  }

  open(name: string, version: number) {
    const req = new MemRequest();
    later(() => {
      if (this.failNextOpen) {
        this.failNextOpen = false;
        req.error = new DOMException('Open failed', 'UnknownError');
        req.onerror?.({ target: req });
        return;
      }
      if (this.blockNextOpen) {
        this.blockNextOpen = false;
        req.onblocked?.({ target: req });
        return;
      }
      let db = this.databases.get(name);
      if (!db || db.closed) {
        const fresh = new MemDatabase(this, name);
        if (db) fresh.stores = db.stores;
        fresh.version = db?.version || 0;
        db = fresh;
        this.databases.set(name, db);
      }
      req.result = db;
      if (db.version < version) {
        const oldVersion = db.version;
        db.version = version;
        req.onupgradeneeded?.({ target: req, oldVersion, newVersion: version });
      }
      req.onsuccess?.({ target: req });
    });
    return req;
  }
}

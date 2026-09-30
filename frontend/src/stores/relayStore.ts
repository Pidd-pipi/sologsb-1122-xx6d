import { defineStore } from 'pinia';
import {
  HEARTBEAT_MS,
  STALE_MS,
  ensureOperator,
  ensureTabId,
  onRelayMessage,
  postRelay,
  readDraft,
  readLock,
  removeDraft,
  removeLock,
  writeDraft,
  writeLock,
  type FaceDraft,
  type FaceLock,
  type RelayMessage,
} from '../utils/relay';

interface RelayState {
  tabId: string;
  operator: string;
  /** faceId -> 当前锁 */
  locks: Record<string, FaceLock>;
  /** faceId -> 未提交草稿 */
  drafts: Record<string, FaceDraft>;
  /** 响应式时钟，驱动过期判定 */
  now: number;
  started: boolean;
}

export const useRelayStore = defineStore('relay', {
  state: (): RelayState => ({
    tabId: '',
    operator: '',
    locks: {},
    drafts: {},
    now: 0,
    started: false,
  }),
  getters: {
    lockOf: (state) => (faceId: string) => state.locks[faceId],
    draftOf: (state) => (faceId: string) => state.drafts[faceId],
    /** 锁是否已过期（持有者崩溃 / 无心跳） */
    isStale: (state) => (faceId: string) => {
      const lock = state.locks[faceId];
      if (!lock) return false;
      if (lock.tabId === state.tabId) return false;
      return state.now - lock.lastBeat > STALE_MS;
    },
    /** 该掌子面是否正被其他页面占用且未掉线 */
    occupiedByOther: (state) => (faceId: string) => {
      const lock = state.locks[faceId];
      if (!lock || lock.tabId === state.tabId) return null;
      return state.now - lock.lastBeat > STALE_MS ? null : lock;
    },
  },
  actions: {
    /** 初始化身份、载入本地锁/草稿、挂接通道与定时器（幂等） */
    init() {
      if (this.started) return;
      this.started = true;
      this.tabId = ensureTabId();
      this.operator = ensureOperator();
      this.now = Date.now();

      this.loadFromStorage();

      onRelayMessage((msg) => this.onMessage(msg));
      window.addEventListener('storage', (e) => this.onStorage(e));
      document.addEventListener('visibilitychange', () => this.onVisible());
      window.addEventListener('pagehide', () => this.releaseAll());
      window.addEventListener('beforeunload', () => this.releaseAll());

      setInterval(() => {
        this.now = Date.now();
        this.sweepStale();
      }, 1000);
      setInterval(() => this.beat(), HEARTBEAT_MS);
    },

    loadFromStorage() {
      const locks: Record<string, FaceLock> = {};
      const drafts: Record<string, FaceDraft> = {};
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i) ?? '';
          if (key.startsWith('gbtunnelface:lock:')) {
            const lock = readLock(key.slice('gbtunnelface:lock:'.length));
            if (lock) locks[lock.faceId] = lock;
          } else if (key.startsWith('gbtunnelface:draft:')) {
            const draft = readDraft(key.slice('gbtunnelface:draft:'.length));
            if (draft) drafts[draft.faceId] = draft;
          }
        }
      } catch {
        /* localStorage 不可用时跳过 */
      }
      this.locks = locks;
      this.drafts = drafts;
    },

    onStorage(e: StorageEvent) {
      if (!e.key) return;
      if (e.key.startsWith('gbtunnelface:lock:')) {
        const faceId = e.key.slice('gbtunnelface:lock:'.length);
        if (!e.newValue) {
          const next = { ...this.locks };
          delete next[faceId];
          this.locks = next;
        } else {
          try {
            const lock = JSON.parse(e.newValue) as FaceLock;
            if (lock.tabId !== this.tabId) {
              this.locks = { ...this.locks, [faceId]: lock };
            }
          } catch {
            /* 忽略坏数据 */
          }
        }
      } else if (e.key.startsWith('gbtunnelface:draft:')) {
        const faceId = e.key.slice('gbtunnelface:draft:'.length);
        if (!e.newValue) {
          const next = { ...this.drafts };
          delete next[faceId];
          this.drafts = next;
        } else {
          try {
            const draft = JSON.parse(e.newValue) as FaceDraft;
            this.drafts = { ...this.drafts, [faceId]: draft };
          } catch {
            /* 忽略坏数据 */
          }
        }
      }
    },

    onVisible() {
      if (!document.hidden) this.beat();
    },

    onMessage(msg: RelayMessage) {
      switch (msg.type) {
        case 'lock:beat': {
          if (msg.lock.tabId === this.tabId) return; // 自己的心跳
          this.locks = { ...this.locks, [msg.lock.faceId]: msg.lock };
          break;
        }
        case 'lock:takeover': {
          if (msg.lock.tabId === this.tabId) return;
          this.locks = { ...this.locks, [msg.lock.faceId]: msg.lock };
          break;
        }
        case 'lock:release': {
          const current = this.locks[msg.faceId];
          if (current && current.tabId === msg.tabId) {
            const next = { ...this.locks };
            delete next[msg.faceId];
            this.locks = next;
          }
          break;
        }
        case 'draft:put': {
          this.drafts = { ...this.drafts, [msg.draft.faceId]: msg.draft };
          break;
        }
        case 'draft:clear': {
          const current = this.drafts[msg.faceId];
          if (current && (!msg.kind || current.kind === msg.kind)) {
            const next = { ...this.drafts };
            delete next[msg.faceId];
            this.drafts = next;
          }
          break;
        }
        case 'data:changed':
          // 数据变更通知由 relay.ts 的本地监听者处理（页面据此重算/刷新）
          break;
      }
    },

    /** 申请编辑权：空闲或同标签页持有 → 持有；他人持有且未掉线 → 锁定；掉线 → 接管 */
    acquire(faceId: string): 'holding' | 'locked' {
      const existing = this.locks[faceId];
      const now = Date.now();
      if (existing && existing.tabId === this.tabId) {
        this.beatOne(faceId);
        return 'holding';
      }
      if (existing && now - existing.lastBeat <= STALE_MS) {
        return 'locked';
      }
      const lock: FaceLock = {
        faceId,
        tabId: this.tabId,
        operator: this.operator,
        heldAt: now,
        lastBeat: now,
      };
      this.locks = { ...this.locks, [faceId]: lock };
      writeLock(lock);
      postRelay({ type: 'lock:takeover', lock });
      return 'holding';
    },

    /** 主动接管已掉线掌子面的编辑权 */
    takeover(faceId: string) {
      const now = Date.now();
      const lock: FaceLock = {
        faceId,
        tabId: this.tabId,
        operator: this.operator,
        heldAt: now,
        lastBeat: now,
      };
      this.locks = { ...this.locks, [faceId]: lock };
      writeLock(lock);
      postRelay({ type: 'lock:takeover', lock });
    },

    /** 释放本页面持有的锁（关闭/离开页面时调用） */
    release(faceId?: string) {
      const ids = faceId
        ? [faceId]
        : Object.keys(this.locks).filter((id) => this.locks[id].tabId === this.tabId);
      for (const id of ids) {
        const current = this.locks[id];
        if (!current || current.tabId !== this.tabId) continue;
        const next = { ...this.locks };
        delete next[id];
        this.locks = next;
        removeLock(id);
        postRelay({ type: 'lock:release', faceId: id, tabId: this.tabId });
      }
    },

    releaseAll() {
      this.release();
    },

    /** 心跳：续约本页面持有的全部锁；若发现已被他人接管则松手 */
    beat() {
      const now = Date.now();
      for (const id of Object.keys(this.locks)) {
        const lock = this.locks[id];
        if (lock.tabId !== this.tabId) continue;
        const remote = readLock(id);
        if (remote && remote.tabId !== this.tabId && now - remote.lastBeat <= STALE_MS) {
          // 接力失败：编辑权已在掉线期间被其他页面接管
          const next = { ...this.locks };
          delete next[id];
          this.locks = next;
          continue;
        }
        this.beatOne(id, now);
      }
    },

    beatOne(faceId: string, now = Date.now()) {
      const lock = this.locks[faceId];
      if (!lock || lock.tabId !== this.tabId) return;
      const updated: FaceLock = { ...lock, lastBeat: now };
      this.locks = { ...this.locks, [faceId]: updated };
      writeLock(updated);
      postRelay({ type: 'lock:beat', lock: updated });
    },

    /** 清掉已掉线的锁（崩溃自动释放） */
    sweepStale() {
      const now = Date.now();
      for (const [id, lock] of Object.entries(this.locks)) {
        if (lock.tabId === this.tabId) continue;
        if (now - lock.lastBeat > STALE_MS) {
          const next = { ...this.locks };
          delete next[id];
          this.locks = next;
          removeLock(id);
        }
      }
    },

    /** 暂存未提交草稿（随锁接力，崩溃后可接上） */
    putDraft(faceId: string, kind: FaceDraft['kind'], data: unknown) {
      const draft: FaceDraft = {
        faceId,
        kind,
        tabId: this.tabId,
        operator: this.operator,
        data,
        updatedAt: Date.now(),
      };
      this.drafts = { ...this.drafts, [faceId]: draft };
      writeDraft(draft);
      postRelay({ type: 'draft:put', draft });
    },

    clearDraft(faceId: string, kind: FaceDraft['kind'] | '' = '') {
      const current = this.drafts[faceId];
      if (!current) return;
      if (kind && current.kind !== kind) return;
      const next = { ...this.drafts };
      delete next[faceId];
      this.drafts = next;
      removeDraft(faceId);
      postRelay({ type: 'draft:clear', faceId, kind: current.kind });
    },
  },
});

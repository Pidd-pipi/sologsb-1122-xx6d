import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { relayBus, selfTabId } from '../utils/relayBus';
import type { DraftRecord, RelayLease, RelayScope, WaitEntry } from '../types/relay';

/** 心跳间隔 / 租约 TTL（连续约 3~4 次无心跳即视为页面崩溃）/ 排队项 TTL */
const HEARTBEAT_MS = 2500;
const LEASE_TTL_MS = 9000;
const WAIT_TTL_MS = 15000;

const LEASE_PREFIX = 'gbtunnelface:relay:lock:';
const WAIT_PREFIX = 'gbtunnelface:relay:wait:';
const TAB_ID_KEY = 'gbtunnelface:relay:tab-id';
const TAB_NAME_KEY = 'gbtunnelface:relay:tab-name';

function leaseKey(faceId: string): string {
  return `${LEASE_PREFIX}${faceId}`;
}
function waitKey(faceId: string, tabId: string): string {
  return `${WAIT_PREFIX}${faceId}:${tabId}`;
}

function readSession(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* 忽略 */
  }
}

function makeTabId(): string {
  let id = readSession(TAB_ID_KEY);
  if (!id) {
    id = `tab_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    writeSession(TAB_ID_KEY, id);
  }
  return id;
}

interface RelayState {
  /** faceId -> 有效租约（仅保留当前最新的一把/掌子面） */
  leases: Record<string, RelayLease>;
  /** 全部排队项 */
  waitlist: WaitEntry[];
  tabId: string;
  tabName: string;
  /** 时钟，定时自增驱动"心跳多久前"等响应式展示 */
  nowTick: number;
  started: boolean;
}

export const useRelayStore = defineStore('relay', {
  state: (): RelayState => ({
    leases: {},
    waitlist: [],
    tabId: '',
    tabName: '',
    nowTick: Date.now(),
    started: false,
  }),
  getters: {
    /** 某掌子面的当前有效租约 */
    leaseOf: (state) => (faceId: string): RelayLease | undefined => {
      const lease = state.leases[faceId];
      if (!lease) return undefined;
      return Date.now() - lease.heartbeatAt > LEASE_TTL_MS ? undefined : lease;
    },
    /** 本页面是否持有某掌子面编辑权 */
    isHolder: (state) => (faceId: string): boolean => {
      const lease = state.leases[faceId];
      return (
        lease?.tabId === state.tabId && Date.now() - lease.heartbeatAt <= LEASE_TTL_MS
      );
    },
    /** 某掌子面的排队项（按入队时间升序） */
    waitsOf: (state) => (faceId: string): WaitEntry[] =>
      state.waitlist
        .filter((w) => w.faceId === faceId && Date.now() - w.pingAt <= WAIT_TTL_MS)
        .sort((a, b) => a.joinedAt - b.joinedAt),
    /** 本页面在某掌子面的排队位次（0 表示未排队） */
    myWaitPosition(): (faceId: string) => number {
      return (faceId: string) => {
        const list = this.waitsOf(faceId);
        return list.findIndex((w) => w.tabId === this.tabId) + 1;
      };
    },
    /** 全台账占用者映射（FaceList 用） */
    holderByFace(state): Record<string, RelayLease> {
      const map: Record<string, RelayLease> = {};
      Object.values(state.leases).forEach((lease) => {
        if (lease && Date.now() - lease.heartbeatAt <= LEASE_TTL_MS) {
          map[lease.faceId] = lease;
        }
      });
      return map;
    },
  },
  actions: {
    start() {
      if (this.started) return;
      this.started = true;
      this.tabId = makeTabId();
      selfTabId.current = this.tabId;
      this.tabName =
        readSession(TAB_NAME_KEY) || `编录页 ${this.tabId.slice(-4)}`;

      this.scanAll();

      relayBus.on((msg) => {
        if (msg.type === 'relay-lock' || msg.type === 'relay-release' || msg.type === 'relay-tick') {
          if (!msg.faceId) return;
          this.refreshFace(msg.faceId);
          if (msg.type === 'relay-release') this.maybePromoteHead(msg.faceId);
        }
      });

      window.addEventListener('storage', (event) => {
        if (event.key?.startsWith(LEASE_PREFIX)) {
          const faceId = event.key.slice(LEASE_PREFIX.length);
          this.refreshFace(faceId);
        } else if (event.key?.startsWith(WAIT_PREFIX)) {
          const faceId = event.key.slice(WAIT_PREFIX.length).split(':')[0];
          this.refreshFace(faceId);
        }
      });

      // 心跳续租 + 队列出队 + 崩溃租约清扫
      window.setInterval(() => {
        this.nowTick = Date.now();
        this.tick();
      }, HEARTBEAT_MS);
      window.addEventListener('online', () => {
        this.scanAll();
      });
    },

    setTabName(name: string) {
      const trimmed = name.trim();
      if (!trimmed) return;
      this.tabName = trimmed;
      writeSession(TAB_NAME_KEY, trimmed);
      // 若当前持有锁或在排队，同步刷新名字
      Object.keys(this.leases).forEach((faceId) => {
        if (this.leases[faceId]?.tabId === this.tabId) this.heartbeat(faceId);
      });
      this.waitlist.forEach((w) => {
        if (w.tabId === this.tabId) this.putWait({ ...w, tabName: trimmed });
      });
    },

    /** 从 localStorage 重新读取某掌子面的租约与队列 */
    refreshFace(faceId: string) {
      const lease = this.readLease(faceId);
      if (lease) {
        this.leases[faceId] = lease;
      } else {
        delete this.leases[faceId];
      }
      this.waitlist = this.waitlist.filter(
        (w) => w.faceId !== faceId || Date.now() - w.pingAt <= WAIT_TTL_MS,
      );
      const others = this.waitlist.filter((w) => w.faceId !== faceId);
      this.waitlist = [...others, ...this.readWaits(faceId)];
    },

    scanAll() {
      const faces = new Set<string>();
      Object.keys(this.leases).forEach((id) => faces.add(id));
      try {
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const key = window.localStorage.key(i);
          if (key?.startsWith(LEASE_PREFIX)) faces.add(key.slice(LEASE_PREFIX.length));
        }
      } catch {
        /* localStorage 不可用时仅维持内存状态 */
      }
      faces.forEach((faceId) => this.refreshFace(faceId));
    },

    readLease(faceId: string): RelayLease | undefined {
      try {
        const raw = window.localStorage.getItem(leaseKey(faceId));
        if (!raw) return undefined;
        const lease = JSON.parse(raw) as RelayLease;
        if (Date.now() - lease.heartbeatAt > LEASE_TTL_MS) {
          // 崩溃/无心跳：编辑权自动释放
          window.localStorage.removeItem(leaseKey(faceId));
          return undefined;
        }
        return lease;
      } catch {
        return undefined;
      }
    },

    readWaits(faceId: string): WaitEntry[] {
      const list: WaitEntry[] = [];
      try {
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const key = window.localStorage.key(i);
          if (!key?.startsWith(WAIT_PREFIX)) continue;
          const parts = key.slice(WAIT_PREFIX.length).split(':');
          if (parts[0] !== faceId) continue;
          const raw = window.localStorage.getItem(key);
          if (!raw) continue;
          const entry = JSON.parse(raw) as WaitEntry;
          if (Date.now() - entry.pingAt <= WAIT_TTL_MS) list.push(entry);
          else window.localStorage.removeItem(key);
        }
      } catch {
        /* 忽略 */
      }
      return list.sort((a, b) => a.joinedAt - b.joinedAt);
    },

    writeLease(lease: RelayLease) {
      try {
        window.localStorage.setItem(leaseKey(lease.faceId), JSON.stringify(lease));
      } catch {
        /* 忽略 */
      }
      this.leases[lease.faceId] = lease;
    },

    /** 申请编辑权：已被占用则自动排队；轮到自己时立即获取 */
    async acquire(faceId: string, scope: RelayScope, route: string): Promise<boolean> {
      if (this.isHolder(faceId)) return true;

      // 以存储为准：先看锁是否仍被他人占用，再决定排队还是接手
      const active = this.readLease(faceId);
      const waiting = this.waitlist.find(
        (w) => w.faceId === faceId && w.tabId === this.tabId,
      );
      if (active && waiting) {
        // 仍在排队等待：刷新排队心跳
        this.putWait(waiting);
        return false;
      }

      if (active) {
        // 占用中：进入 FIFO 队列等待
        this.putWait({
          faceId,
          tabId: this.tabId,
          tabName: this.tabName,
          scope,
          joinedAt: Date.now(),
          pingAt: Date.now(),
        });
        return false;
      }

      // 锁空闲：按 FIFO 判断是否轮到自己（排队者优先于新到者）
      const waits = this.readWaits(faceId);
      const head = waits[0];
      if (head && head.tabId !== this.tabId) {
        // 队首是更早的等待者：新到者排队；自己此前没排队则入队
        if (!waiting) {
          this.putWait({
            faceId,
            tabId: this.tabId,
            tabName: this.tabName,
            scope,
            joinedAt: Date.now(),
            pingAt: Date.now(),
          });
        }
        return false;
      }

      // Web Locks 互斥：持锁标签页崩溃时浏览器自动释放，杜绝僵尸编辑权
      const granted = await this.webGuard(faceId);
      if (!granted) {
        if (!waiting) {
          this.putWait({
            faceId,
            tabId: this.tabId,
            tabName: this.tabName,
            scope,
            joinedAt: Date.now(),
            pingAt: Date.now(),
          });
        }
        return false;
      }

      // 进入临界区后复查（可能其他标签页刚写入）
      const recheck = this.readLease(faceId);
      if (recheck && recheck.tabId !== this.tabId) {
        if (!waiting) {
          this.putWait({
            faceId,
            tabId: this.tabId,
            tabName: this.tabName,
            scope,
            joinedAt: Date.now(),
            pingAt: Date.now(),
          });
        }
        return false;
      }

      const now = Date.now();
      // 轮到自己：清掉排队项后写入租约
      this.removeWait(faceId, this.tabId);
      this.writeLease({
        faceId,
        scope,
        tabId: this.tabId,
        tabName: this.tabName,
        route,
        heartbeatAt: now,
        acquiredAt: now,
      });
      relayBus.post({ type: 'relay-lock', faceId, tabId: this.tabId, at: now });
      return true;
    },

    /**
     * navigator.locks 短临界区（仅包住 CAS 抢占）：
     * 持锁标签页崩溃时浏览器自动释放；不支持（非安全上下文）时退化为乐观 CAS。
     * 租约本身的崩溃释放由心跳 TTL 兜底（页面隐藏/卸载时主动释放是快路径）。
     */
    async webGuard(faceId: string): Promise<boolean> {
      const nav = navigator as Navigator & {
        locks?: {
          request: (
            name: string,
            cb: () => Promise<void> | void,
          ) => Promise<void>;
        };
      };
      if (!nav.locks) return true;
      return new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (value: boolean) => {
          if (!done) {
            done = true;
            resolve(value);
          }
        };
        // 1.2s 进不了临界区，说明其他页面正在抢占，本轮转入排队
        const timer = setTimeout(() => finish(false), 1200);
        void nav.locks!.request(`gbtunnelface-face-${faceId}`, async () => {
          clearTimeout(timer);
          if (done) return;
          finish(true);
        });
      });
    },

    putWait(entry: WaitEntry) {
      try {
        window.localStorage.setItem(waitKey(entry.faceId, entry.tabId), JSON.stringify(entry));
      } catch {
        /* 忽略 */
      }
      this.waitlist = [
        ...this.waitlist.filter(
          (w) => !(w.faceId === entry.faceId && w.tabId === entry.tabId),
        ),
        entry,
      ];
      relayBus.post({ type: 'relay-tick', faceId: entry.faceId, tabId: this.tabId, at: Date.now() });
    },

    removeWait(faceId: string, tabId: string) {
      try {
        window.localStorage.removeItem(waitKey(faceId, tabId));
      } catch {
        /* 忽略 */
      }
      this.waitlist = this.waitlist.filter(
        (w) => !(w.faceId === faceId && w.tabId === tabId),
      );
    },

    /** 心跳续租；同时维护排队心跳，并在锁空闲时让队首接手 */
    tick() {
      Object.keys(this.leases).forEach((faceId) => {
        const lease = this.leases[faceId];
        if (lease.tabId !== this.tabId) {
          if (Date.now() - lease.heartbeatAt > LEASE_TTL_MS) {
            // 持有者崩溃或长时间无心跳：编辑权已自动释放
            this.refreshFace(faceId);
            this.maybePromoteHead(faceId);
          }
          return;
        }
        // 本页持有：先看存储里是否已被他人接管（本页长时间休眠超过 TTL 的场景）
        const stored = this.readLease(faceId);
        if (stored && stored.tabId !== this.tabId) {
          this.leases[faceId] = stored;
          this.refreshFace(faceId);
          return;
        }
        if (!stored) {
          // 本页租约已过期且锁空闲：删除本地状态后重新走申请流程（排队者优先）
          delete this.leases[faceId];
          this.refreshFace(faceId);
          void this.acquire(faceId, lease.scope, window.location.pathname);
          return;
        }
        this.writeLease({ ...lease, heartbeatAt: Date.now(), tabName: this.tabName });
      });

      // 本页排队项续命
      this.waitlist
        .filter((w) => w.tabId === this.tabId)
        .forEach((w) => this.putWait({ ...w, pingAt: Date.now(), tabName: this.tabName }));

      // 清扫过期排队项
      const expired = this.waitlist.filter((w) => Date.now() - w.pingAt > WAIT_TTL_MS);
      expired.forEach((w) => this.removeWait(w.faceId, w.tabId));
    },

    /** 锁空闲时把队首等待者提升为持有者 */
    maybePromoteHead(faceId: string) {
      if (this.readLease(faceId)) return;
      const head = this.readWaits(faceId)[0];
      if (head?.tabId === this.tabId) {
        void this.acquire(faceId, head.scope, window.location.pathname);
      }
      // 队首是其他标签页时，由其自身心跳/广播检测到空闲后接手
    },

    heartbeat(faceId: string) {
      const lease = this.leases[faceId];
      if (lease?.tabId === this.tabId) {
        this.writeLease({ ...lease, heartbeatAt: Date.now(), tabName: this.tabName });
      }
    },

    /** 主动交还编辑权（草稿保留，可被接续） */
    release(faceId: string) {
      const lease = this.leases[faceId];
      if (lease?.tabId === this.tabId) {
        try {
          window.localStorage.removeItem(leaseKey(faceId));
        } catch {
          /* 忽略 */
        }
        delete this.leases[faceId];
        relayBus.post({ type: 'relay-release', faceId, tabId: this.tabId, at: Date.now() });
      }
      this.removeWait(faceId, this.tabId);
      this.refreshFace(faceId);
      this.maybePromoteHead(faceId);
    },

    /** 页面卸载/隐藏时释放本页持有的全部编辑权（同步执行，不能用异步） */
    releaseAllSync() {
      Object.keys(this.leases).forEach((faceId) => {
        if (this.leases[faceId]?.tabId !== this.tabId) return;
        try {
          window.localStorage.removeItem(leaseKey(faceId));
        } catch {
          /* 忽略 */
        }
        delete this.leases[faceId];
      });
      this.waitlist
        .filter((w) => w.tabId === this.tabId)
        .forEach((w) => {
          try {
            window.localStorage.removeItem(waitKey(w.faceId, w.tabId));
          } catch {
            /* 忽略 */
          }
        });
      this.waitlist = this.waitlist.filter((w) => w.tabId !== this.tabId);
    },

    // ---- 接力草稿（IndexedDB，崩溃后可接续） ----
    async loadDraft(faceId: string, scope: RelayScope): Promise<DraftRecord | undefined> {
      return db.drafts.get(`${faceId}:${scope}`);
    },
    async saveDraft(faceId: string, scope: RelayScope, payload: unknown, ownerName: string) {
      const record: DraftRecord = {
        id: `${faceId}:${scope}`,
        faceId,
        scope,
        payload: toPlain(payload),
        ownerTabId: this.tabId,
        ownerName,
        updatedAt: Date.now(),
      };
      await db.drafts.put(record);
      return record;
    },
    async clearDraft(faceId: string, scope: RelayScope) {
      await db.drafts.delete(`${faceId}:${scope}`);
    },
  },
});

export { LEASE_TTL_MS, LEASE_PREFIX };

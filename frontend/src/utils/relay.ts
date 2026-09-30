/**
 * 编录接力：跨标签页协调原语。
 *
 * 纯前端应用没有后端，标签页之间靠 BroadcastChannel 实时通信，
 * localStorage 作为兜底通道（storage 事件可跨标签页），
 * sessionStorage 记录标签页身份（刷新后身份不变，草稿还能接上）。
 *
 * 接力规则：每张掌子面同一时刻只允许一个页面持有编辑锁；
 * 持有者每 HEARTBEAT_MS 续约一次；超过 STALE_MS 无心跳即视为崩溃，
 * 编辑权自动释放，其他页面可接管；未提交草稿按掌子面保存，接管后可继续。
 */
export const RELAY_BC = 'gbtunnelface-relay-v1';
export const LS_TAB_KEY = 'gbtunnelface:tab-id';
export const LS_OPERATOR_KEY = 'gbtunnelface:operator';
export const LS_LOCK_PREFIX = 'gbtunnelface:lock:';
export const LS_DRAFT_PREFIX = 'gbtunnelface:draft:';

/** 心跳间隔：持有者每 2s 续约一次 */
export const HEARTBEAT_MS = 2000;
/** 心跳超时：超过 6s 无心跳视为页面崩溃，编辑权自动释放 */
export const STALE_MS = 6000;

/** 编辑锁 */
export interface FaceLock {
  faceId: string;
  /** 持有标签页 id（sessionStorage，刷新不变） */
  tabId: string;
  /** 占用者显示名 */
  operator: string;
  /** 首次持锁时间 */
  heldAt: number;
  /** 最近一次心跳时间 */
  lastBeat: number;
}

/** 未提交草稿（随锁接力） */
export interface FaceDraft {
  faceId: string;
  kind: 'joint' | 'water';
  tabId: string;
  operator: string;
  data: unknown;
  updatedAt: number;
}

/** 数据变更类型（用于判定失效重算通知） */
export type DataChangeKind = 'joint' | 'water' | 'face' | 'grade';

export type RelayMessage =
  | { type: 'lock:beat'; lock: FaceLock }
  | { type: 'lock:release'; faceId: string; tabId: string }
  | { type: 'lock:takeover'; lock: FaceLock }
  | { type: 'draft:put'; draft: FaceDraft }
  | { type: 'draft:clear'; faceId: string; kind: FaceDraft['kind'] | '' }
  | { type: 'data:changed'; faceId: string; kind: DataChangeKind; at: number };

/** 跨标签页总线（BroadcastChannel 不可用时降级为仅本地） */
let bc: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') bc = new BroadcastChannel(RELAY_BC);
} catch {
  bc = null;
}

type MessageHandler = (msg: RelayMessage) => void;
const handlers = new Set<MessageHandler>();

/** 订阅接力消息（含本页自发消息的本地回投），返回退订函数 */
export function onRelayMessage(handler: MessageHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

function deliver(msg: RelayMessage): void {
  handlers.forEach((h) => {
    try {
      h(msg);
    } catch {
      /* 单个监听者异常不影响其他监听者 */
    }
  });
}

/** 发送接力消息：BroadcastChannel 跨标签页 + 本页本地回投 */
export function postRelay(msg: RelayMessage): void {
  try {
    bc?.postMessage(msg);
  } catch {
    /* 通道异常时仅靠本地与 storage 事件 */
  }
  deliver(msg);
}

if (bc) {
  bc.onmessage = (e: MessageEvent) => {
    if (e.data && typeof e.data === 'object' && 'type' in e.data) {
      deliver(e.data as RelayMessage);
    }
  };
}

/** 数据变更监听（页面据此重算判定/刷新列表） */
type DataChangedHandler = (faceId: string, kind: DataChangeKind, at: number) => void;
const dataChangedHandlers = new Set<DataChangedHandler>();

export function onDataChanged(handler: DataChangedHandler): () => void {
  dataChangedHandlers.add(handler);
  return () => dataChangedHandlers.delete(handler);
}

/** 通知：某掌子面的节理/涌水/产状/级别数据已变更 */
export function notifyDataChanged(faceId: string, kind: DataChangeKind): void {
  const at = Date.now();
  postRelay({ type: 'data:changed', faceId, kind, at });
}

/** 读取或生成本标签页身份（sessionStorage，刷新后不变） */
export function ensureTabId(): string {
  try {
    let id = window.sessionStorage.getItem(LS_TAB_KEY);
    if (!id) {
      id = `tab_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      window.sessionStorage.setItem(LS_TAB_KEY, id);
    }
    return id;
  } catch {
    return `tab_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** 读取或生成操作者名（localStorage，可跨会话记住） */
export function ensureOperator(): string {
  try {
    let name = window.localStorage.getItem(LS_OPERATOR_KEY);
    if (!name) {
      name = `编录员·${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      window.localStorage.setItem(LS_OPERATOR_KEY, name);
    }
    return name;
  } catch {
    return '编录员';
  }
}

export function readLock(faceId: string): FaceLock | null {
  try {
    const raw = window.localStorage.getItem(LS_LOCK_PREFIX + faceId);
    return raw ? (JSON.parse(raw) as FaceLock) : null;
  } catch {
    return null;
  }
}

export function writeLock(lock: FaceLock): void {
  try {
    window.localStorage.setItem(LS_LOCK_PREFIX + lock.faceId, JSON.stringify(lock));
  } catch {
    /* 存储不可用时仅靠内存与通道 */
  }
}

export function removeLock(faceId: string): void {
  try {
    window.localStorage.removeItem(LS_LOCK_PREFIX + faceId);
  } catch {
    /* 忽略 */
  }
}

export function readDraft(faceId: string): FaceDraft | null {
  try {
    const raw = window.localStorage.getItem(LS_DRAFT_PREFIX + faceId);
    return raw ? (JSON.parse(raw) as FaceDraft) : null;
  } catch {
    return null;
  }
}

export function writeDraft(draft: FaceDraft): void {
  try {
    window.localStorage.setItem(LS_DRAFT_PREFIX + draft.faceId, JSON.stringify(draft));
  } catch {
    /* 忽略 */
  }
}

export function removeDraft(faceId: string): void {
  try {
    window.localStorage.removeItem(LS_DRAFT_PREFIX + faceId);
  } catch {
    /* 忽略 */
  }
}

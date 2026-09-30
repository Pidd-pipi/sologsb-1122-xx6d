import type { RelayMessage } from '../types/relay';

/**
 * 跨标签页消息总线：优先 BroadcastChannel（现代浏览器均支持），
 * 不可用时降级为 localStorage storage 事件（同源多标签页）。
 */
const CHANNEL_NAME = 'gbtunnelface:relay';
const FALLBACK_KEY = 'gbtunnelface:relay-bus';

type Listener = (message: RelayMessage) => void;

class RelayBus {
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<Listener>();

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (event: MessageEvent<RelayMessage>) => {
        this.dispatch(event.data);
      };
    } else if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key !== FALLBACK_KEY || !event.newValue) return;
        try {
          this.dispatch(JSON.parse(event.newValue) as RelayMessage);
        } catch {
          /* 忽略无法解析的降级消息 */
        }
      });
    }
  }

  private dispatch(message: RelayMessage) {
    this.listeners.forEach((fn) => fn(message));
  }

  post(message: RelayMessage): void {
    if (this.channel) {
      this.channel.postMessage(message);
      return;
    }
    try {
      window.localStorage.setItem(FALLBACK_KEY, JSON.stringify(message));
    } catch {
      /* localStorage 不可用时仅本页生效 */
    }
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const relayBus = new RelayBus();

/** 当前标签页 id（由 relayStore 启动时写入，避免业务 store 反向依赖 relayStore 形成循环） */
export const selfTabId: { current: string } = { current: '' };

/** 业务数据变更后通知其他标签页重新读取（接力数据统一来源） */
export function emitDataChange(
  table: RelayMessage['table'],
  faceId?: string,
  tabId?: string,
): void {
  relayBus.post({ type: 'data-change', table, faceId, tabId: tabId ?? selfTabId.current, at: Date.now() });
}

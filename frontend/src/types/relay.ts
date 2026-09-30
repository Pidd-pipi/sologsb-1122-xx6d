/** 编录接力的作用范围：每个掌子面同一时刻仅一个页面持有编辑权 */
export type RelayScope = 'joint' | 'water' | 'grade' | 'sketch' | 'face';

export const RELAY_SCOPE_TEXT: Record<RelayScope, string> = {
  joint: '节理录入',
  water: '涌水记录',
  grade: '级别判定',
  sketch: '岩性素描',
  face: '基本信息',
};

/** 编辑权租约（localStorage 持久化，跨标签页可见，带心跳 TTL） */
export interface RelayLease {
  faceId: string;
  scope: RelayScope;
  /** 持有页面 id */
  tabId: string;
  /** 持有者名称（地质员可自行修改） */
  tabName: string;
  /** 路由路径，便于占用者展示 */
  route: string;
  /** 最近一次心跳时间 */
  heartbeatAt: number;
  /** 租约获取时间 */
  acquiredAt: number;
}

/** 排队等待项 */
export interface WaitEntry {
  faceId: string;
  tabId: string;
  tabName: string;
  scope: RelayScope;
  joinedAt: number;
  /** 排队心跳，过期自动移出队列 */
  pingAt: number;
}

/** 接力草稿（IndexedDB 持久化，崩溃后由后续编辑者接续） */
export interface DraftRecord {
  /** `${faceId}:${scope}` */
  id: string;
  faceId: string;
  scope: RelayScope;
  /** 草稿内容（页面表单数据） */
  payload: unknown;
  /** 草稿归属页面（可为其他地质员接续） */
  ownerTabId: string;
  ownerName: string;
  updatedAt: number;
}

export type RelayMessageType =
  | 'relay-lock'
  | 'relay-release'
  | 'relay-tick'
  | 'data-change';

export interface RelayMessage {
  type: RelayMessageType;
  faceId?: string;
  /** data-change：变更的数据表 */
  table?: 'faces' | 'joints' | 'grades' | 'waters' | 'drafts';
  tabId: string;
  at: number;
}

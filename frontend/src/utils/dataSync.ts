import { useFaceStore } from '../stores/faceStore';
import { useJointStore } from '../stores/jointStore';
import { useGradeStore } from '../stores/gradeStore';
import { relayBus } from './relayBus';
import type { RelayMessage } from '../types/relay';

/**
 * 接力数据同步：其他标签页写入业务数据后，本页重新读取对应 store，
 * 保证台账、详情、判定页始终以最新接力数据为准；等待时也能离线查看本地副本。
 */
export function startDataSync(selfTabId: string): void {
  relayBus.on((msg: RelayMessage) => {
    if (msg.type !== 'data-change' || msg.tabId === selfTabId) return;
    void reloadTable(msg.table);
  });

  // 标签页重新可见时做一次兜底全量同步（折叠期间的 storage 节流可能漏消息）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void reloadAll();
    }
  });
}

async function reloadTable(table: RelayMessage['table']): Promise<void> {
  if (table === 'faces' || table === 'drafts') {
    await useFaceStore().load();
    return;
  }
  if (table === 'joints') {
    await useJointStore().load();
    return;
  }
  if (table === 'grades' || table === 'waters') {
    await useGradeStore().load();
  }
}

async function reloadAll(): Promise<void> {
  await Promise.all([
    useFaceStore().load(),
    useJointStore().load(),
    useGradeStore().load(),
  ]);
}

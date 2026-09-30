import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRelayStore } from '../stores/relayStore';

export type LockStatus = 'free' | 'holding' | 'locked' | 'stale';

/**
 * 编录接力锁：编辑页（节理/涌水/判定）挂载时调用。
 * - 空闲或同标签页：持有编辑权；
 * - 其他页面占用且心跳正常：只读，显示占用者；
 * - 占用者掉线（无心跳）：编辑权自动释放，本页面自动接力。
 * 离开页面 / 关闭标签页时释放锁。
 */
export function useFaceLock(faceId: Ref<string>) {
  const relay = useRelayStore();
  const status = ref<LockStatus>('free');

  function refresh() {
    const id = faceId.value;
    if (!id) {
      status.value = 'free';
      return;
    }
    const lock = relay.lockOf(id);
    if (!lock) {
      status.value = 'free';
      return;
    }
    if (lock.tabId === relay.tabId) {
      status.value = 'holding';
      return;
    }
    status.value = relay.isStale(id) ? 'stale' : 'locked';
  }

  function acquire(): 'holding' | 'locked' {
    const id = faceId.value;
    if (!id) return 'locked';
    const result = relay.acquire(id);
    refresh();
    return result;
  }

  function takeover() {
    const id = faceId.value;
    if (!id) return;
    relay.takeover(id);
    refresh();
    ElMessage.success('已接力编辑权，可继续编录');
  }

  let stop: (() => void) | undefined;

  onMounted(async () => {
    await relay.init();
    acquire();
    refresh();
    // 占用者掉线后自动接力（时钟每秒驱动 refresh）
    stop = watch(
      () => [relay.now, faceId.value, JSON.stringify(relay.lockOf(faceId.value))] as const,
      () => {
        const wasStale = status.value === 'stale';
        refresh();
        if (status.value === 'stale') {
          if (!wasStale) ElMessage.info('占用者已掉线，编辑权自动释放并接力到本页面');
          relay.takeover(faceId.value);
          refresh();
        }
      },
    );
  });

  onUnmounted(() => {
    stop?.();
    if (faceId.value) relay.release(faceId.value);
  });

  // 路由切到另一个掌子面：释放旧锁、申请新锁
  watch(faceId, (next, prev) => {
    if (prev) relay.release(prev);
    if (next) {
      acquire();
      refresh();
    }
  });

  return {
    status,
    holder: () => relay.lockOf(faceId.value),
    canWrite: () => status.value === 'holding',
    acquire,
    takeover,
    refresh,
  };
}

import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue';
import { useRelayStore } from '../stores/relayStore';
import type { DraftRecord, RelayScope } from '../types/relay';
import { debounce } from '../utils/timing';

export interface UseFaceLockOptions {
  faceId: Ref<string>;
  scope: RelayScope;
  /** 自动保存草稿的数据源（函数返回响应式表单快照） */
  draftSource?: () => unknown;
}

/**
 * 编录接力页面接入：
 * - holder 本页持有编辑权 / waiting 排队中 / occupied 他人占用 / free 空闲；
 * - 离开页面自动释放（草稿保留），页面崩溃由心跳 TTL 释放；
 * - 编辑中防抖自动写草稿，获得编辑权时提示可接续旧草稿。
 */
export function useFaceLock(options: UseFaceLockOptions) {
  const relay = useRelayStore();
  const { faceId, scope, draftSource } = options;

  const draft = shallowRef<DraftRecord | undefined>(undefined);
  const draftRestored = ref(false);

  const lease = computed(() => relay.leaseOf(faceId.value));
  const isHolder = computed(() => relay.isHolder(faceId.value));
  const waitPosition = computed(() => relay.myWaitPosition(faceId.value));
  const waits = computed(() => relay.waitsOf(faceId.value));

  const state = computed<'free' | 'holder' | 'waiting' | 'occupied'>(() => {
    if (isHolder.value) return 'holder';
    if (waitPosition.value > 0) return 'waiting';
    if (lease.value) return 'occupied';
    return 'free';
  });

  async function request() {
    const ok = await relay.acquire(faceId.value, scope, window.location.pathname);
    if (ok) await loadDraft();
    return ok;
  }

  function release() {
    relay.release(faceId.value);
  }

  async function loadDraft() {
    draft.value = await relay.loadDraft(faceId.value, scope);
  }

  async function clearDraft() {
    await relay.clearDraft(faceId.value, scope);
    draft.value = undefined;
  }

  /** 接续旧草稿后标记完成，页面据此决定是否回填 */
  function markDraftRestored() {
    draftRestored.value = true;
  }

  function discardDraft() {
    void clearDraft();
    draftRestored.value = false;
  }

  const persist = debounce(() => {
    if (!isHolder.value || !draftSource) return;
    void relay.saveDraft(faceId.value, scope, draftSource(), relay.tabName);
  }, 600);

  // 编辑中自动保存草稿
  watch(
    () => (draftSource && isHolder.value ? draftSource() : null),
    () => persist(),
    { deep: true },
  );

  // 无论首次申请还是排队后经队首提升成为持有者，都拉取（可能存在的崩溃者遗留）草稿
  watch(isHolder, (holder) => {
    if (holder) void loadDraft();
  });

  // 切换掌子面时重新拉取草稿
  watch(faceId, () => {
    draft.value = undefined;
    draftRestored.value = false;
    if (isHolder.value) void loadDraft();
  });

  onMounted(() => {
    relay.start();
    if (isHolder.value) void loadDraft();
  });

  // 离开页面（SPA 路由切走）主动交还；整页关闭/崩溃由 main.ts 的 pagehide 与心跳 TTL 兜底
  onBeforeUnmount(() => {
    relay.release(faceId.value);
  });

  return {
    relay,
    lease,
    isHolder,
    waitPosition,
    waits,
    state,
    draft,
    draftRestored,
    request,
    release,
    loadDraft,
    clearDraft,
    markDraftRestored,
    discardDraft,
  };
}

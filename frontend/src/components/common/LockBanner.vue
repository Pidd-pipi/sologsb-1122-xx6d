<script setup lang="ts">
import { computed } from 'vue';
import type { FaceLock } from '../../utils/relay';
import type { LockStatus } from '../../hooks/useFaceLock';

const props = defineProps<{
  status: LockStatus;
  holder?: FaceLock | null;
}>();

const emit = defineEmits<{
  (e: 'takeover'): void;
}>();

const holderName = computed(() => props.holder?.operator ?? '其他页面');
const staleSeconds = computed(() =>
  props.holder ? Math.max(0, Math.round((Date.now() - props.holder.lastBeat) / 1000)) : 0,
);
</script>

<template>
  <el-alert
    v-if="status === 'holding'"
    type="success"
    :closable="false"
    show-icon
    title="编录接力中：本页面持有该掌子面的编辑权，其他页面只读"
  />
  <el-alert
    v-else-if="status === 'locked'"
    type="warning"
    :closable="false"
    show-icon
    :title="`该掌子面正由 ${holderName} 编辑（占用者），当前为只读模式，可离线查看；对方关闭页面或掉线后编辑权将自动释放`"
  />
  <el-alert
    v-else-if="status === 'stale'"
    type="info"
    :closable="false"
    show-icon
    :title="`占用者已掉线（约 ${staleSeconds}s 无心跳），编辑权已自动释放`"
  >
    <div class="stale-row">
      <span>原页面未提交的草稿仍可接上，接管后继续编录。</span>
      <el-button size="small" type="primary" @click="emit('takeover')">接管编辑</el-button>
    </div>
  </el-alert>
</template>

<style scoped>
.stale-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
</style>

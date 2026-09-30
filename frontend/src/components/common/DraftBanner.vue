<script setup lang="ts">
import { computed } from 'vue';
import type { FaceDraft } from '../../utils/relay';

const props = defineProps<{
  draft?: FaceDraft | null;
  /** 本页面负责的草稿类型 */
  kind: FaceDraft['kind'];
  /** 草稿是否来自本标签页（刷新后重连） */
  fromSelf?: boolean;
}>();

const emit = defineEmits<{
  (e: 'resume'): void;
  (e: 'discard'): void;
}>();

const visible = computed(() => !!props.draft && props.draft.kind === props.kind);
const timeText = computed(() =>
  props.draft ? new Date(props.draft.updatedAt).toLocaleString('zh-CN') : '',
);
</script>

<template>
  <el-alert
    v-if="visible"
    type="warning"
    :closable="false"
    show-icon
    class="draft-banner"
    :title="`检测到 ${timeText} 未提交的${kind === 'joint' ? '节理产状' : '涌水记录'}草稿${fromSelf ? '' : '（来自接力页面）'}`"
  >
    <div class="draft-row">
      <span>已按草稿内容恢复表单，可继续编辑后保存。</span>
      <el-button size="small" type="primary" @click="emit('resume')">继续编辑</el-button>
      <el-button size="small" @click="emit('discard')">放弃草稿</el-button>
    </div>
  </el-alert>
</template>

<style scoped>
.draft-banner {
  margin-bottom: 10px;
}
.draft-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
</style>

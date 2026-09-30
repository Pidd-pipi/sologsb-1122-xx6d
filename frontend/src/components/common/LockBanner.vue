<script setup lang="ts">
import { computed } from 'vue';
import { Clock, Lock, Unlock, User } from '@element-plus/icons-vue';
import { RELAY_SCOPE_TEXT, type RelayLease, type WaitEntry } from '../../types/relay';

const props = defineProps<{
  state: 'free' | 'holder' | 'waiting' | 'occupied';
  scope: keyof typeof RELAY_SCOPE_TEXT;
  lease?: RelayLease;
  waitPosition: number;
  waits: WaitEntry[];
  tabName: string;
  /** 是否存在可接续草稿 */
  hasDraft?: boolean;
  draftOwner?: string;
}>();

const emit = defineEmits<{
  (e: 'request'): void;
  (e: 'release'): void;
  (e: 'rename', name: string): void;
  (e: 'restore-draft'): void;
  (e: 'discard-draft'): void;
}>();

const heartbeatAgo = computed(() => {
  if (!props.lease) return '';
  const sec = Math.max(0, Math.round((Date.now() - props.lease.heartbeatAt) / 1000));
  return `${sec} 秒前`;
});

const waitingOthers = computed(() => props.waits.filter((w) => w.tabName !== props.tabName).length);
</script>

<template>
  <el-alert
    :type="state === 'holder' ? 'success' : state === 'waiting' ? 'warning' : state === 'occupied' ? 'error' : 'info'"
    :closable="false"
    show-icon
    class="lock-banner"
  >
    <template #title>
      <div class="row">
        <template v-if="state === 'holder'">
          <el-icon><User /></el-icon>
          <span>
            你正在编录本掌子面（{{ RELAY_SCOPE_TEXT[scope] }}），其他标签页只能查看。
            <el-input
              :model-value="tabName"
              size="small"
              class="name-input"
              @change="(v: string) => emit('rename', v)"
            />
          </span>
          <el-tag v-if="hasDraft" size="small" type="warning">存在未接续草稿</el-tag>
          <el-button v-if="hasDraft" size="small" type="warning" plain @click="emit('restore-draft')">接续草稿</el-button>
          <el-button v-if="hasDraft" size="small" plain @click="emit('discard-draft')">丢弃草稿</el-button>
          <el-tag v-else size="small" type="success" effect="plain">草稿自动保存中</el-tag>
          <el-tag v-if="waitingOthers" size="small" effect="plain">另有 {{ waitingOthers }} 页等待</el-tag>
          <el-button size="small" @click="emit('release')">交还编辑权</el-button>
        </template>

        <template v-else-if="state === 'waiting'">
          <el-icon><Clock /></el-icon>
          <span>
            当前由 <strong>{{ lease?.tabName ?? '其他页面' }}</strong> 编录
            <span class="muted">（{{ RELAY_SCOPE_TEXT[lease?.scope ?? scope] }}，心跳 {{ heartbeatAgo }}）</span>，
            你排在第 <strong>{{ waitPosition }}</strong> 位，编辑权释放后自动接手；可先离线查看。
          </span>
        </template>

        <template v-else-if="state === 'occupied'">
          <el-icon><Lock /></el-icon>
          <span>
            本掌子面正由 <strong>{{ lease?.tabName ?? '其他页面' }}</strong>
            编录（{{ RELAY_SCOPE_TEXT[lease?.scope ?? scope] }}，心跳 {{ heartbeatAgo }}），
            编辑权释放或其页面崩溃（约 9 秒无心跳）后可申请；当前可离线查看。
          </span>
          <el-button size="small" type="warning" @click="emit('request')">申请编录权（自动排队）</el-button>
        </template>

        <template v-else>
          <el-icon><Unlock /></el-icon>
          <span>当前无人编录，数据只读展示；申请编辑权后可录入（未保存内容自动存草稿，崩溃可接续）。</span>
          <el-button size="small" type="primary" @click="emit('request')">申请编录权</el-button>
          <template v-if="hasDraft">
            <el-tag size="small" type="warning">
              存在{{ draftOwner && draftOwner !== tabName ? ` ${draftOwner} ` : '' }}未完成草稿
            </el-tag>
            <el-button size="small" type="warning" plain @click="emit('restore-draft')">接续草稿</el-button>
            <el-button size="small" plain @click="emit('discard-draft')">丢弃</el-button>
          </template>
        </template>
      </div>
    </template>
  </el-alert>
</template>

<style scoped>
.lock-banner {
  align-items: center;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.name-input {
  width: 150px;
  margin: 0 6px;
}
.muted {
  color: #8a939f;
}
</style>

<script setup lang="ts">
import type { TunnelFace } from '../../types/face';
import type { RockGrade } from '../../types/grade';
import type { RelayLease } from '../../types/relay';
import { RELAY_SCOPE_TEXT } from '../../types/relay';
import GradeTag from './GradeTag.vue';
import { formatChainage } from '../../utils/geoMath';

defineProps<{
  face: TunnelFace;
  grade?: RockGrade;
  /** 现行结论待复核 */
  reviewRequired?: boolean;
  /** 旧判定已失效且尚无新结论 */
  gradeStale?: boolean;
  jointCount?: number;
  waterCount?: number;
  /** 当前占用本掌子面的接力租约 */
  holder?: RelayLease;
  footer?: string;
}>();

const emit = defineEmits<{
  (e: 'open', id: string): void;
}>();
</script>

<template>
  <el-card class="face-card" shadow="hover" @click="emit('open', face.id)">
    <div class="row">
      <strong>{{ face.faceNo }}</strong>
      <GradeTag v-if="grade" :grade="grade" />
      <el-tag v-else-if="gradeStale" type="warning" size="small">判定已失效</el-tag>
      <GradeTag v-else label="未判定" />
      <el-tag v-if="reviewRequired" type="warning" size="small">待复核</el-tag>
      <el-tag size="small" effect="plain">{{ face.excavationMethod }}</el-tag>
    </div>
    <div v-if="holder" class="row">
      <el-tag type="danger" size="small">
        {{ holder.tabName }} 正在{{ RELAY_SCOPE_TEXT[holder.scope] }}编录
      </el-tag>
    </div>
    <div class="line">
      桩号 {{ formatChainage(face.chainage) }} · 编录区间
      {{ formatChainage(face.mileageRange[0]) }} ~ {{ formatChainage(face.mileageRange[1]) }}
    </div>
    <div class="line">岩性 {{ face.lithology }}（{{ face.weathering }}）· Rc {{ face.rockStrength }} MPa</div>
    <div class="line">
      产状 {{ face.attitude.dipDirection }}° ∠ {{ face.attitude.dipAngle }}°（走向 {{ face.attitude.strike }}°）· 断面
      {{ face.faceSize }} m
    </div>
    <div class="line">节理组 {{ jointCount ?? 0 }} 组 · 涌水记录 {{ waterCount ?? 0 }} 条 · 地质员 {{ face.geologist }}</div>
    <div class="line muted">最近编录 {{ new Date(face.recordedAt).toLocaleString('zh-CN') }}</div>
    <div v-if="footer" class="line footer">{{ footer }}</div>
  </el-card>
</template>

<style scoped>
.face-card {
  cursor: pointer;
  height: 100%;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.line {
  font-size: 13px;
  color: #5b6470;
  line-height: 1.7;
}
.muted {
  color: #97a0ad;
}
.footer {
  margin-top: 6px;
  color: #2f3a46;
  font-weight: 600;
}
</style>

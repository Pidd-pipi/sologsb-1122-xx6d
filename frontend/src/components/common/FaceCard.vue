<script setup lang="ts">
import GradeTag from './GradeTag.vue';
import type { TunnelFace } from '../../types/face';
import type { RockGrade } from '../../types/grade';
import { formatChainage } from '../../utils/geoMath';

defineProps<{
  face: TunnelFace;
  grade?: RockGrade;
  jointCount?: number;
  waterCount?: number;
  footer?: string;
  /** 占用者名称（其他页面正在编录） */
  occupant?: string;
  /** 占用者已掉线 */
  occupantStale?: boolean;
  /** 现行级别已失效（输入变更后未重算） */
  gradeStale?: boolean;
  /** 现行级别为人工修正（失效后标待复核） */
  gradeManual?: boolean;
}>();

const emit = defineEmits<{
  (e: 'open', id: string): void;
}>();
</script>

<template>
  <el-card class="face-card" shadow="hover" @click="emit('open', face.id)">
    <div class="row">
      <strong>{{ face.faceNo }}</strong>
      <GradeTag :grade="grade" />
      <el-tag v-if="gradeStale" size="small" :type="gradeManual ? 'warning' : 'danger'" effect="dark">
        {{ gradeManual ? '级别待复核' : '级别已失效' }}
      </el-tag>
      <el-tag v-if="occupant" size="small" type="warning" effect="plain">
        {{ occupantStale ? '占用者掉线' : `编录中 · ${occupant}` }}
      </el-tag>
      <el-tag size="small" effect="plain">{{ face.excavationMethod }}</el-tag>
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

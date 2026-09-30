<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useFaceStore } from '../stores/faceStore';
import { useGradeStore } from '../stores/gradeStore';
import { useJointStore } from '../stores/jointStore';
import { useFaceLock } from '../hooks/useFaceLock';
import { useGradeCalc } from '../hooks/useGradeCalc';
import SketchCanvas from '../components/common/SketchCanvas.vue';
import GradeTag from '../components/common/GradeTag.vue';
import LockBanner from '../components/common/LockBanner.vue';
import { attitudeText, formatChainage } from '../utils/geoMath';
import {
  GRADE_STATUS_TEXT,
  GRADE_SUPPORT,
  INVALID_REASON_TEXT,
  type InvalidationReason,
} from '../types/grade';
import { RELAY_SCOPE_TEXT } from '../types/relay';

const route = useRoute();
const router = useRouter();
const faceStore = useFaceStore();
const jointStore = useJointStore();
const gradeStore = useGradeStore();

const faceId = computed(() => String(route.params.id ?? ''));
const face = computed(() => faceStore.byId(faceId.value));
const joints = computed(() => jointStore.byFace(faceId.value));
const grades = computed(() => gradeStore.byFace(faceId.value));
const latest = computed(() => gradeStore.latestByFace(faceId.value));
const previousGrade = computed(() => grades.value[1]);
/** 最近一条失效记录（用于提示"旧结论已失效，正在重算/待复核"） */
const staleRecord = computed(() => grades.value.find((row) => row.status === 'stale'));

const sketchLock = useFaceLock({ faceId, scope: 'sketch' });

const { result, patch } = useGradeCalc(() => joints.value);
const segmentCount = ref(0);

/** 本掌子面是否正被某个页面编录（任何范围） */
const otherLease = computed(() => {
  const lease = sketchLock.relay.leaseOf(faceId.value);
  if (!lease) return undefined;
  return sketchLock.relay.isHolder(faceId.value) ? undefined : lease;
});

/** SketchCanvas 变更回调（用命名函数避免模板内联箭头参数丢类型） */
function onSketchChange(segs: { id: string }[]): void {
  segmentCount.value = segs.length;
}

function reasonText(reasons?: InvalidationReason[]): string {
  return (reasons ?? []).map((r) => INVALID_REASON_TEXT[r]).join('、');
}

/** 与上循环级别比对结论 */
const gradeCompare = computed(() => {
  if (!latest.value) return '本掌子面尚无级别判定记录';
  if (!previousGrade.value) return `本掌子面首次判定为 ${latest.value.grade} 级围岩`;
  const order = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ'];
  const delta = order.indexOf(latest.value.grade) - order.indexOf(previousGrade.value.grade);
  if (delta === 0) return `与上一循环一致（${latest.value.grade} 级）`;
  return delta > 0
    ? `较上一循环变差 ${delta} 级：${previousGrade.value.grade} → ${latest.value.grade}`
    : `较上一循环变好 ${-delta} 级：${previousGrade.value.grade} → ${latest.value.grade}`;
});

onMounted(async () => {
  await faceStore.load();
  await jointStore.load();
  await gradeStore.load();
  if (face.value) {
    patch({ rockStrength: face.value.rockStrength, spanWidth: Number(face.value.faceSize.split('×')[0]) || 12 });
  }
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>掌子面详情 · {{ face?.faceNo ?? '未找到' }}</h2>
      <GradeTag v-if="latest" :grade="latest.grade" />
      <el-tag v-else type="info">未判定级别</el-tag>
      <el-tag v-if="latest?.status === 'pending'" type="warning">待复核</el-tag>
      <el-tag type="info" effect="plain">节理 {{ joints.length }} 组</el-tag>
      <el-tag v-if="otherLease" type="danger" effect="dark" size="small">
        {{ otherLease.tabName }} 正在{{ RELAY_SCOPE_TEXT[otherLease.scope] }}编录
      </el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="router.push(`/faces/${faceId}/joints`)">节理录入</el-button>
      <el-button @click="router.push(`/faces/${faceId}/water`)">涌水记录</el-button>
      <el-button @click="router.push(`/grade/${faceId}`)">围岩级别判定</el-button>
      <el-button @click="router.push('/faces')">返回台账</el-button>
    </div>

    <el-alert v-if="!face" type="warning" :closable="false" show-icon title="未找到该掌子面（可能已被删除）" />

    <template v-if="face">
      <!-- 依据变化后旧围岩级别不再当现行结论 -->
      <el-alert
        v-if="staleRecord"
        type="warning"
        show-icon
        :closable="false"
        :title="`${reasonText(staleRecord.invalidatedReasons)}，原 ${staleRecord.grade} 级判定已失效；${latest ? `最新结论 ${latest.grade} 级${latest.status === 'pending' ? '（待复核）' : ''}` : '等待重新判定'}`"
      />

      <LockBanner
        :state="sketchLock.state.value"
        scope="sketch"
        :lease="sketchLock.lease.value"
        :wait-position="sketchLock.waitPosition.value"
        :waits="sketchLock.waits.value"
        :tab-name="sketchLock.relay.tabName"
        @request="sketchLock.request"
        @release="sketchLock.release"
        @rename="(name: string) => sketchLock.relay.setTabName(name)"
      />
    </template>

    <div v-if="face" class="grid">
      <div class="left">
        <el-card shadow="never">
          <template #header><strong>基本信息</strong></template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="掌子面编号">{{ face.faceNo }}</el-descriptions-item>
            <el-descriptions-item label="里程桩号">{{ formatChainage(face.chainage) }}</el-descriptions-item>
            <el-descriptions-item label="编录里程区间">
              {{ formatChainage(face.mileageRange[0]) }} ~ {{ formatChainage(face.mileageRange[1]) }}
            </el-descriptions-item>
            <el-descriptions-item label="开挖方式">{{ face.excavationMethod }}</el-descriptions-item>
            <el-descriptions-item label="开挖断面尺寸">{{ face.faceSize }} m</el-descriptions-item>
            <el-descriptions-item label="岩性 / 风化">{{ face.lithology }} / {{ face.weathering }}</el-descriptions-item>
            <el-descriptions-item label="饱和抗压强度">{{ face.rockStrength }} MPa</el-descriptions-item>
            <el-descriptions-item label="岩层产状">
              走向 {{ face.attitude.strike }}° · {{ attitudeText(face.attitude.dipDirection, face.attitude.dipAngle) }}
            </el-descriptions-item>
            <el-descriptions-item label="地质员">{{ face.geologist }}</el-descriptions-item>
            <el-descriptions-item label="编录时间">
              {{ new Date(face.recordedAt).toLocaleString('zh-CN') }}
            </el-descriptions-item>
          </el-descriptions>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>级别与支护</strong></template>
          <div v-if="latest" class="grade-box">
            <div class="grade-line">
              <GradeTag :grade="latest.grade" />
              <el-tag size="small" :type="latest.status === 'pending' ? 'warning' : 'success'">
                {{ GRADE_STATUS_TEXT[latest.status ?? 'active'] }}
              </el-tag>
              <el-tag v-if="latest.autoRecomputed" size="small" type="warning" effect="plain">自动重算</el-tag>
            </div>
            <span class="muted">[BQ] = {{ latest.correctedBq }}（BQ {{ latest.bqValue }}，修正 {{ latest.correction }}）</span>
            <p v-if="latest.status === 'pending' && latest.autoGrade" class="muted">
              人工修正保留：系统自动建议 {{ latest.autoGrade }} 级（[BQ] {{ latest.autoCorrectedBq }}），请到判定页复核。
            </p>
            <p class="support">{{ latest.supportSuggestion || GRADE_SUPPORT[latest.grade] }}</p>
            <p class="muted">{{ gradeCompare }}</p>
          </div>
          <div v-else>
            <p class="muted">尚未判定级别，按当前参数实时试算：</p>
            <GradeTag :grade="result.grade" />
            <p class="support">{{ result.support }}</p>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>节理组列表（{{ joints.length }} 组）</strong></template>
          <el-table :data="joints" size="small" border>
            <el-table-column label="组号" width="70">
              <template #default="{ row }">J{{ row.setNo }}</template>
            </el-table-column>
            <el-table-column label="产状" width="140">
              <template #default="{ row }">{{ attitudeText(row.dipDirection, row.dipAngle) }}</template>
            </el-table-column>
            <el-table-column prop="spacing" label="间距 cm" width="90" />
            <el-table-column prop="persistence" label="延伸 m" width="90" />
            <el-table-column prop="aperture" label="张开 mm" width="90" />
            <el-table-column prop="fillMaterial" label="充填" width="90" />
            <el-table-column prop="waterWet" label="渗水" width="90" />
            <el-table-column prop="jointCount" label="条数" width="80" />
          </el-table>
          <el-empty v-if="joints.length === 0" description="暂无节理组记录" :image-size="60" />
        </el-card>
      </div>

      <el-card shadow="never">
        <template #header>
          <div class="card-head">
            <strong>岩性素描图</strong>
            <span class="muted">已布置 {{ segmentCount }} 条结构面线段（自动保存在浏览器本地）</span>
          </div>
        </template>
        <SketchCanvas
          :face-id="face.id"
          :lithology="face.lithology"
          :attitude="face.attitude"
          :readonly="!sketchLock.isHolder.value"
          @change="onSketchChange"
        />
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: 620px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.left {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.support {
  margin: 8px 0;
  color: #2f3a46;
}
.grade-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.grade-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>

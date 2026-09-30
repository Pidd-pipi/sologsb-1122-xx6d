<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useFaceStore } from '../stores/faceStore';
import { useGradeStore, signatureOf } from '../stores/gradeStore';
import { useJointStore } from '../stores/jointStore';
import { useGradeCalc } from '../hooks/useGradeCalc';
import { useFaceLock } from '../hooks/useFaceLock';
import GradeTag from '../components/common/GradeTag.vue';
import LockBanner from '../components/common/LockBanner.vue';
import {
  GROUNDWATERS,
  GRADE_STATUS_TEXT,
  GRADE_SUPPORT,
  INVALID_REASON_TEXT,
  ROCK_GRADES,
  type Groundwater,
  type InvalidationReason,
  type RockGrade,
} from '../types/grade';
import { attitudeText, estimateJv, formatChainage } from '../utils/geoMath';

const route = useRoute();
const router = useRouter();
const faceStore = useFaceStore();
const gradeStore = useGradeStore();
const jointStore = useJointStore();

const faceId = computed(() => String(route.params.faceId ?? ''));
const face = computed(() => faceStore.byId(faceId.value));
const joints = computed(() => jointStore.byFace(faceId.value));
const waters = computed(() => gradeStore.watersByFace(faceId.value));
const history = computed(() => gradeStore.byFace(faceId.value));
const latest = computed(() => gradeStore.latestByFace(faceId.value));

const { input, result, patch } = useGradeCalc(() => joints.value);
const manual = ref(false);
const manualGrade = ref<RockGrade>('Ⅲ');

const lock = useFaceLock({
  faceId,
  scope: 'grade',
  draftSource: () => ({ input: { ...input.value }, manual: manual.value, manualGrade: manualGrade.value }),
});

function rename(name: string) {
  lock.relay.setTabName(name);
}

const finalGrade = computed<RockGrade>(() => (manual.value ? manualGrade.value : result.value.grade));
const finalSupport = computed(() => GRADE_SUPPORT[finalGrade.value]);

const pendingRecord = computed(() =>
  latest.value?.status === 'pending' && latest.value.reviewRequired ? latest.value : undefined,
);

const compareText = computed(() => {
  if (!latest.value) return '本掌子面尚无历史判定，保存后将成为首次记录';
  const order = ROCK_GRADES;
  const delta = order.indexOf(finalGrade.value) - order.indexOf(latest.value.grade);
  if (delta === 0) return `与上循环级别一致（${latest.value.grade} 级）`;
  return delta > 0
    ? `较上循环变差 ${delta} 级：${latest.value.grade} → ${finalGrade.value}`
    : `较上循环变好 ${-delta} 级：${latest.value.grade} → ${finalGrade.value}`;
});

watch(
  () => result.value.grade,
  (g) => {
    manualGrade.value = g;
  },
  { immediate: true },
);

/** 进入页面时若存在判定输入草稿，提示可接续 */
function restoreDraft() {
  const payload = lock.draft.value?.payload as
    | { input?: typeof input.value; manual?: boolean; manualGrade?: RockGrade }
    | undefined;
  if (!payload) {
    lock.markDraftRestored();
    return;
  }
  if (payload.input) patch(payload.input);
  if (typeof payload.manual === 'boolean') manual.value = payload.manual;
  if (payload.manualGrade) manualGrade.value = payload.manualGrade;
  ElMessage.success('已接续上次未保存的判定输入');
  lock.markDraftRestored();
}

async function save() {
  if (!lock.isHolder.value) {
    ElMessage.warning('请先申请并取得本掌子面的编辑权');
    return;
  }
  if (!face.value) {
    ElMessage.error('未找到该掌子面');
    return;
  }
  const { signature, text } = signatureOf(face.value, joints.value, waters.value);
  await gradeStore.saveGrade({
    faceId: face.value.id,
    grade: finalGrade.value,
    bqValue: result.value.bq,
    rqd: input.value.rqd,
    jv: result.value.jv,
    kv: input.value.kv,
    groundwater: input.value.groundwater,
    spanWidth: input.value.spanWidth,
    correction: Number((result.value.k1 + result.value.k2 + input.value.extraCorrection).toFixed(3)),
    correctedBq: result.value.correctedBq,
    supportSuggestion: finalSupport.value,
    manualAdjusted: manual.value,
    status: 'active',
    reviewRequired: false,
    basisSignature: signature,
    basisText: text,
  });
  await lock.clearDraft();
  ElMessage.success(`已保存 ${finalGrade.value} 级围岩判定`);
}

/** 复核：确认保留的人工级别为现行结论 */
async function confirmKept() {
  if (!pendingRecord.value || !lock.isHolder.value) {
    ElMessage.warning('复核操作需要编辑权');
    return;
  }
  await gradeStore.confirmReview(pendingRecord.value.id);
  ElMessage.success('已复核确认，该级别成为现行结论');
}

/** 复核：采用系统自动算得的级别 */
async function adoptAuto() {
  if (!pendingRecord.value || !lock.isHolder.value) return;
  await gradeStore.adoptAuto(pendingRecord.value.id);
  ElMessage.success('已采用系统自动重算级别');
}

/** 复核：人工改判 */
async function reviewAdjust(grade: RockGrade) {
  if (!pendingRecord.value || !lock.isHolder.value) return;
  await gradeStore.reviewAdjust(pendingRecord.value.id, grade, GRADE_SUPPORT[grade]);
  ElMessage.success(`已复核改判为 ${grade} 级`);
}

function reasonText(reasons?: InvalidationReason[]): string {
  return (reasons ?? []).map((r) => INVALID_REASON_TEXT[r]).join('、');
}

/** 失效/被取代历史行灰显划线 */
function historyRowClass({ row }: { row: { status?: string } }): string {
  if (row.status === 'stale' || row.status === 'superseded') return 'grade-row-stale';
  return '';
}

onMounted(async () => {
  await faceStore.load();
  await jointStore.load();
  await gradeStore.load();
  if (face.value) {
    patch({
      rockStrength: face.value.rockStrength,
      spanWidth: Number(face.value.faceSize.split('×')[0]) || 12,
    });
  }
  // 进入即申请编录权；他人占用时自动排队，等待期间离线只读查看
  await lock.request();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>围岩级别判定 · {{ face?.faceNo ?? '未知' }}</h2>
      <GradeTag :grade="finalGrade" />
      <el-tag type="info" effect="plain">节理 {{ joints.length }} 组 · 自动 Jv {{ estimateJv(joints) }}</el-tag>
      <div class="spacer" />
      <el-button @click="router.push(`/faces/${faceId}`)">返回掌子面详情</el-button>
      <el-button @click="router.push(`/faces/${faceId}/joints`)">节理录入</el-button>
    </div>

    <LockBanner
      :state="lock.state.value"
      scope="grade"
      :lease="lock.lease.value"
      :wait-position="lock.waitPosition.value"
      :waits="lock.waits.value"
      :tab-name="lock.relay.tabName"
      :has-draft="!!lock.draft.value && !lock.draftRestored.value"
      :draft-owner="lock.draft.value?.ownerName"
      @request="lock.request"
      @release="lock.release"
      @rename="rename"
      @restore-draft="restoreDraft"
      @discard-draft="lock.discardDraft"
    />

    <!-- 依据变化后：人工修正保留，挂待复核 -->
    <el-alert
      v-if="pendingRecord"
      type="warning"
      show-icon
      :closable="false"
      :title="`因${reasonText(pendingRecord.invalidatedReasons)}，原人工修正 ${pendingRecord.grade} 级已保留但标记待复核；系统自动重算建议为 ${pendingRecord.autoGrade} 级（[BQ] ${pendingRecord.autoCorrectedBq}）`"
    >
      <div class="review-actions">
        <el-button size="small" type="primary" :disabled="!lock.isHolder.value" @click="confirmKept">
          复核确认保留 {{ pendingRecord.grade }} 级
        </el-button>
        <el-button size="small" :disabled="!lock.isHolder.value" @click="adoptAuto">
          采用自动 {{ pendingRecord.autoGrade }} 级
        </el-button>
        <el-radio-group
          size="small"
          :disabled="!lock.isHolder.value"
          @change="(g: RockGrade) => reviewAdjust(g)"
        >
          <el-radio-button v-for="g in ROCK_GRADES" :key="g" :value="g">{{ g }}</el-radio-button>
        </el-radio-group>
        <span class="muted">复核改判</span>
      </div>
    </el-alert>

    <el-alert v-if="!face" type="warning" :closable="false" show-icon title="未找到该掌子面" />

    <div class="grid">
      <el-card shadow="never">
        <template #header><strong>逐项指标输入</strong></template>
        <fieldset :disabled="!lock.isHolder.value" class="lock-fieldset">
        <el-form label-width="150px">
          <el-form-item label="饱和抗压强度 Rc">
            <el-input-number v-model="input.rockStrength" :min="1" :max="300" :step="1" />
            <span class="hint">MPa</span>
          </el-form-item>
          <el-form-item label="岩石质量指标 RQD">
            <el-slider v-model="input.rqd" :min="0" :max="100" :step="1" style="width: 240px" />
            <span class="hint">{{ input.rqd }} %</span>
          </el-form-item>
          <el-form-item label="节理体密度 Jv">
            <el-input-number v-model="input.jv" :min="0" :max="60" :step="0.1" :precision="1" />
            <span class="hint">条/m³（0 表示按节理间距自动估算 {{ estimateJv(joints) }}）</span>
          </el-form-item>
          <el-form-item label="岩体完整性系数 Kv">
            <el-slider v-model="input.kv" :min="0" :max="1" :step="0.01" style="width: 240px" />
            <span class="hint">{{ input.kv }}</span>
          </el-form-item>
          <el-form-item label="出水状态">
            <el-select v-model="input.groundwater" style="width: 200px">
              <el-option v-for="g in GROUNDWATERS" :key="g" :label="g" :value="g" />
            </el-select>
          </el-form-item>
          <el-form-item label="洞跨">
            <el-input-number v-model="input.spanWidth" :min="1" :max="60" :step="0.5" />
            <span class="hint">m</span>
          </el-form-item>
          <el-form-item label="其它修正系数">
            <el-input-number v-model="input.extraCorrection" :min="0" :max="1" :step="0.01" :precision="2" />
          </el-form-item>
        </el-form>
        </fieldset>
      </el-card>

      <div class="right">
        <el-card shadow="never">
          <template #header><strong>实时算得的级别与支护建议</strong></template>
          <div class="result">
            <GradeTag :grade="finalGrade" />
            <span class="muted">BQ = {{ result.bq }} · [BQ] = {{ result.correctedBq }}</span>
            <el-tag v-if="manual" type="warning" size="small">人工修正</el-tag>
            <el-tag v-if="latest?.status === 'pending'" type="warning" size="small">现行结论待复核</el-tag>
            <el-tag v-else-if="latest" type="success" size="small">现行 {{ latest.grade }} 级</el-tag>
          </div>
          <p class="support">{{ finalSupport }}</p>
          <fieldset :disabled="!lock.isHolder.value" class="lock-fieldset">
            <el-checkbox v-model="manual">启用人工修正级别</el-checkbox>
            <el-radio-group v-if="manual" v-model="manualGrade" style="margin-top: 8px">
              <el-radio-button v-for="g in ROCK_GRADES" :key="g" :value="g">{{ g }}</el-radio-button>
            </el-radio-group>
          </fieldset>
          <el-divider />
          <p class="muted">{{ compareText }}</p>
          <el-button type="primary" :disabled="!lock.isHolder.value" @click="save">保存判定结果</el-button>
          <span v-if="!lock.isHolder.value" class="hint">取得编辑权后可保存</span>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>计算过程</strong></template>
          <ol class="steps">
            <li v-for="(line, i) in result.explanation" :key="i">{{ line }}</li>
          </ol>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>本掌子面历史判定</strong></template>
          <el-table :data="history" size="small" border :row-class-name="historyRowClass">
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ new Date(row.judgedAt).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column label="级别" width="90">
              <template #default="{ row }"><GradeTag :grade="row.grade" /></template>
            </el-table-column>
            <el-table-column prop="bqValue" label="BQ" width="90" />
            <el-table-column prop="correctedBq" label="[BQ]" width="90" />
            <el-table-column prop="rqd" label="RQD" width="80" />
            <el-table-column prop="kv" label="Kv" width="80" />
            <el-table-column prop="groundwater" label="出水" width="120" />
            <el-table-column label="修正" width="80">
              <template #default="{ row }">{{ row.manualAdjusted ? '人工' : '自动' }}</template>
            </el-table-column>
            <el-table-column label="接力状态" width="170">
              <template #default="{ row }">
                <el-tag
                  size="small"
                  :type="row.status === 'active' ? 'success' : row.status === 'pending' ? 'warning' : 'info'"
                >
                  {{ GRADE_STATUS_TEXT[(row.status ?? 'active') as keyof typeof GRADE_STATUS_TEXT] }}
                </el-tag>
                <el-tag v-if="row.autoRecomputed" size="small" type="warning" effect="plain">自动重算</el-tag>
                <div v-if="row.status === 'stale'" class="stale-reason">
                  {{ reasonText(row.invalidatedReasons) }}
                </div>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="history.length === 0" description="尚无历史判定" :image-size="60" />
        </el-card>

        <el-card v-if="face" shadow="never">
          <template #header><strong>掌子面摘要</strong></template>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="桩号">{{ formatChainage(face.chainage) }}</el-descriptions-item>
            <el-descriptions-item label="开挖方式">{{ face.excavationMethod }}</el-descriptions-item>
            <el-descriptions-item label="岩性">{{ face.lithology }}（{{ face.weathering }}）</el-descriptions-item>
            <el-descriptions-item label="断面尺寸">{{ face.faceSize }} m</el-descriptions-item>
            <el-descriptions-item label="岩层产状">
              {{ attitudeText(face.attitude.dipDirection, face.attitude.dipAngle) }}
            </el-descriptions-item>
            <el-descriptions-item label="地质员">{{ face.geologist }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
      </div>
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
  grid-template-columns: 520px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.right {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.result {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.support {
  color: #2f3a46;
  margin: 6px 0;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.hint {
  margin-left: 8px;
  color: #97a0ad;
  font-size: 12px;
}
.steps {
  margin: 0;
  padding-left: 18px;
  color: #5b6470;
  font-size: 13px;
  line-height: 1.9;
}
.lock-fieldset {
  border: none;
  padding: 0;
  margin: 0;
}
.review-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.stale-reason {
  font-size: 11px;
  color: #b06a1e;
  margin-top: 2px;
}
:deep(.grade-row-stale) {
  color: #a7afba;
}
:deep(.grade-row-stale .grade-tag) {
  opacity: 0.55;
  text-decoration: line-through;
}
</style>

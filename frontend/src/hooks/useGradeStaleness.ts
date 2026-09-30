import { computed } from 'vue';
import { useJointStore } from '../stores/jointStore';
import { useGradeStore } from '../stores/gradeStore';
import { useFaceStore } from '../stores/faceStore';
import type { RockMassGrade } from '../types/grade';

export interface GradeStaleness {
  /** 现行级别是否已因输入变更而失效 */
  stale: boolean;
  /** 现行级别是否为人工修正（人工修正保留但标待复核） */
  manual: boolean;
  /** 失效原因列表 */
  reasons: string[];
  /** 现行（最近一次）级别判定记录 */
  grade?: RockMassGrade;
}

/** 时间容差：避免同一秒内写入造成的误判 */
const TOLERANCE_MS = 1000;

/**
 * 围岩级别失效判定：
 * 节理、涌水或岩层产状在最近一次级别判定之后发生变化，
 * 自动判定立即失效（提示重算）；人工修正结论保留但标「待复核」。
 * 台账、详情、判定页共用同一判定口径。
 */
export function useGradeStaleness() {
  const jointStore = useJointStore();
  const gradeStore = useGradeStore();
  const faceStore = useFaceStore();

  const byFace = computed<Record<string, GradeStaleness>>(() => {
    const map: Record<string, GradeStaleness> = {};
    // gradeStore.items 已按 judgedAt 降序，每个 faceId 第一条即现行结论
    for (const grade of gradeStore.items) {
      if (map[grade.faceId]) continue;
      const t = grade.judgedAt;
      const reasons: string[] = [];

      if (jointStore.byFace(grade.faceId).some((j) => (j.createdAt ?? 0) > t + TOLERANCE_MS)) {
        reasons.push('节理产状有新增或变更');
      }
      if (gradeStore.watersByFace(grade.faceId).some((w) => w.measuredAt > t + TOLERANCE_MS)) {
        reasons.push('涌水记录有新增或变更');
      }
      const face = faceStore.byId(grade.faceId);
      if (face && (face.updatedAt ?? face.recordedAt) > t + TOLERANCE_MS) {
        reasons.push('岩层产状或掌子面信息已变更');
      }

      map[grade.faceId] = {
        stale: reasons.length > 0,
        manual: grade.manualAdjusted,
        reasons,
        grade,
      };
    }
    return map;
  });

  return { byFace };
}

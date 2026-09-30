import type { Attitude, TunnelFace } from '../types/face';
import { GRADE_SUPPORT, type Groundwater, type InvalidationReason, type RockGrade, type RockMassGrade } from '../types/grade';
import type { JointSet } from '../types/joint';
import type { WaterInflow } from '../types/water';
import { GROUNDWATER_K1, gradeFromBq, spanK2 } from '../hooks/useGradeCalc';
import { estimateJv } from './geoMath';

/**
 * 判定依据快照：节理、涌水、岩层产状三类输入。
 * 任一项变化都会改变签名，旧判定立即失效重算。
 */
export interface GradeBasis {
  joints: {
    setNo: number;
    dipDirection: number;
    dipAngle: number;
    spacing: number;
    aperture: number;
    fillMaterial: string;
    waterWet: string;
    jointCount: number;
  }[];
  water: {
    type: string;
    estimatedFlow: number;
    changeTrend: string;
    chainage: number;
  }[];
  attitude: Pick<Attitude, 'strike' | 'dipDirection' | 'dipAngle'>;
  rockStrength: number;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** FNV-1a 32 位哈希，作为判定依据签名 */
export function basisSignature(basis: GradeBasis): string {
  const text = stableJson(basis);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildBasis(
  face: TunnelFace | undefined,
  joints: JointSet[],
  waters: WaterInflow[],
): GradeBasis {
  return {
    joints: joints
      .map((j) => ({
        setNo: j.setNo,
        dipDirection: j.dipDirection,
        dipAngle: j.dipAngle,
        spacing: j.spacing,
        aperture: j.aperture,
        fillMaterial: j.fillMaterial,
        waterWet: j.waterWet,
        jointCount: j.jointCount,
      }))
      .sort((a, b) => a.setNo - b.setNo),
    water: waters
      .map((w) => ({
        type: w.type,
        estimatedFlow: w.estimatedFlow,
        changeTrend: w.changeTrend,
        chainage: w.chainage,
      }))
      .sort((a, b) => a.chainage - b.chainage),
    attitude: face
      ? { ...face.attitude }
      : { strike: 0, dipDirection: 0, dipAngle: 0 },
    rockStrength: face?.rockStrength ?? 0,
  };
}

/** 判定依据摘要（台账/详情追溯用） */
export function basisText(basis: GradeBasis): string {
  return `节理 ${basis.joints.length} 组 · 涌水 ${basis.water.length} 条 · 产状 ${basis.attitude.dipDirection}°∠${basis.attitude.dipAngle}°`;
}

/** 由最近涌水记录推断判定用出水状态 */
export function groundwaterFromWaters(waters: WaterInflow[]): Groundwater | undefined {
  const latest = [...waters].sort((a, b) => b.measuredAt - a.measuredAt)[0];
  if (!latest) return undefined;
  if (latest.estimatedFlow >= 60 || latest.type === '股状' || latest.changeTrend === '突增') {
    return '涌流状出水';
  }
  if (latest.estimatedFlow >= 20 || latest.type === '线流') return '线状出水';
  if (latest.type === '滴水') return '点滴状出水';
  return '潮湿';
}

export interface RecomputeOptions {
  face?: TunnelFace;
  joints: JointSet[];
  waters: WaterInflow[];
  /** 失效原因 */
  reason: InvalidationReason;
}

/**
 * 依据变化后重算判定：
 * - 自动判定：以新依据重算，重新成为现行结论；
 * - 人工修正：保留人工级别（人工修正保留），自动结果仅作建议，挂待复核。
 */
export function recomputeGrade(previous: RockMassGrade, opts: RecomputeOptions): RockMassGrade {
  const { face, joints, waters, reason } = opts;
  const groundwater =
    reason === 'water'
      ? groundwaterFromWaters(waters) ?? previous.groundwater
      : previous.groundwater;
  const jv = estimateJv(joints) || previous.jv;
  const spanWidth = face
    ? Number(face.faceSize.split('×')[0]) || previous.spanWidth
    : previous.spanWidth;
  const rockStrength =
    face?.rockStrength ??
    // 拿不到掌子面时由旧 BQ 反推：Rc = (BQ − 90 − 250Kv) / 3
    Math.max(0, Math.round((previous.bqValue - 90 - 250 * previous.kv) / 3));
  const { kv, rqd } = previous;
  // 保留原判定的"其它修正 K3"：由旧记录自身的 K1/K2 反推，不随本次新出水状态改变
  const extraCorrection = round3(
    previous.correction -
      (GROUNDWATER_K1[previous.groundwater] ?? 0) -
      spanK2(previous.spanWidth),
  );
  const bq = round1(90 + 3 * rockStrength + 250 * kv);
  const correction = round3(
    (GROUNDWATER_K1[groundwater] ?? 0) + spanK2(spanWidth) + extraCorrection,
  );
  const correctedBq = round1(bq - 100 * correction);
  const autoGrade: RockGrade = gradeFromBq(correctedBq);

  const basis = buildBasis(face, joints, waters);

  const base: RockMassGrade = {
    ...previous,
    id: `grade_rc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    judgedAt: Date.now(),
    bqValue: bq,
    rqd,
    jv,
    kv,
    groundwater,
    spanWidth,
    correction,
    correctedBq,
    basisSignature: basisSignature(basis),
    basisText: basisText(basis),
    invalidatedReasons: [],
    invalidatedAt: undefined,
    autoRecomputed: true,
    reviewedAt: undefined,
  };

  if (previous.manualAdjusted) {
    // 人工修正保留但标待复核：级别沿用人工值，自动结果仅作建议
    return {
      ...base,
      grade: previous.grade,
      supportSuggestion: previous.supportSuggestion,
      status: 'pending',
      reviewRequired: true,
      manualAdjusted: true,
      autoGrade,
      autoCorrectedBq: correctedBq,
    };
  }

  // 自动判定：[BQ] 实质变化时按新结果定级；数值未变（如仅节理条数变化、
  // 或历史记录级别与其 [BQ] 存在老数据偏差）则沿用原级别，避免无谓跳变
  const unchanged = Math.abs(correctedBq - (previous.correctedBq ?? correctedBq)) < 0.05;
  return {
    ...base,
    grade: unchanged ? previous.grade : autoGrade,
    supportSuggestion: unchanged ? previous.supportSuggestion : GRADE_SUPPORT[autoGrade],
    status: 'active',
    reviewRequired: false,
    manualAdjusted: false,
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

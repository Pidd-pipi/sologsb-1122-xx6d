/** 围岩级别 Ⅰ ~ Ⅵ */
export type RockGrade = 'Ⅰ' | 'Ⅱ' | 'Ⅲ' | 'Ⅳ' | 'Ⅴ' | 'Ⅵ';

export const ROCK_GRADES: RockGrade[] = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ'];

/** 出水状态 */
export type Groundwater = '干燥' | '潮湿' | '点滴状出水' | '线状出水' | '涌流状出水';

export const GROUNDWATERS: Groundwater[] = ['干燥', '潮湿', '点滴状出水', '线状出水', '涌流状出水'];

/** 判定记录接力状态：现行 / 待复核 / 已失效（依据变化）/ 已被新判定取代 */
export type GradeStatus = 'active' | 'pending' | 'stale' | 'superseded';

/** 失效触发原因 */
export type InvalidationReason = 'joint' | 'water' | 'attitude';

export const GRADE_STATUS_TEXT: Record<GradeStatus, string> = {
  active: '现行',
  pending: '待复核',
  stale: '已失效',
  superseded: '已取代',
};

export const INVALID_REASON_TEXT: Record<InvalidationReason, string> = {
  joint: '节理产状变化',
  water: '涌水情况变化',
  attitude: '岩层产状变化',
};

/** 围岩级别判定记录 */
export interface RockMassGrade {
  id: string;
  faceId: string;
  grade: RockGrade;
  /** 基本质量指标 BQ */
  bqValue: number;
  /** 岩石质量指标 % */
  rqd: number;
  /** 节理体密度 条/m³ */
  jv: number;
  /** 岩体完整性系数 */
  kv: number;
  groundwater: Groundwater;
  /** 洞跨 m */
  spanWidth: number;
  /** 修正系数合计 */
  correction: number;
  /** 修正后的 [BQ] */
  correctedBq: number;
  /** 支护建议 */
  supportSuggestion: string;
  /** 是否人工修正级别 */
  manualAdjusted: boolean;
  judgedAt: number;
  /** 接力状态（v3，老数据视为 active） */
  status?: GradeStatus;
  /** 判定依据签名：节理/涌水/产状快照哈希，依据变化即失效 */
  basisSignature?: string;
  /** 判定依据摘要文本，便于追溯 */
  basisText?: string;
  /** 失效原因（stale 时记录） */
  invalidatedReasons?: InvalidationReason[];
  /** 失效时间 */
  invalidatedAt?: number;
  /** 待复核：人工修正保留或复核流程未完成 */
  reviewRequired?: boolean;
  /** 是否依据变化后系统自动重算的记录 */
  autoRecomputed?: boolean;
  /** 人工修正保留时，系统自动算得的建议级别 */
  autoGrade?: RockGrade;
  /** 自动算得的 [BQ] */
  autoCorrectedBq?: number;
  /** 复核通过时间 */
  reviewedAt?: number;
}

export type RockMassGradeDraft = Omit<RockMassGrade, 'id' | 'judgedAt'>;

/** 补齐老记录缺失的接力字段 */
export function normalizeGrade(row: RockMassGrade): RockMassGrade {
  return {
    ...row,
    status: row.status ?? 'active',
    invalidatedReasons: row.invalidatedReasons ?? [],
    reviewRequired: row.reviewRequired ?? false,
    autoRecomputed: row.autoRecomputed ?? false,
    manualAdjusted: row.manualAdjusted ?? false,
  };
}

/** 是否仍是现行结论（待复核记录也占现行位，等待人工处置） */
export function isCurrentGrade(row: RockMassGrade): boolean {
  const status = row.status ?? 'active';
  return status === 'active' || status === 'pending';
}

/** 级别色带（用于 <GradeTag>） */
export const GRADE_COLOR: Record<RockGrade, string> = {
  'Ⅰ': '#1f7a4d',
  'Ⅱ': '#3f9e63',
  'Ⅲ': '#c9a227',
  'Ⅳ': '#e08b2f',
  'Ⅴ': '#d3542f',
  'Ⅵ': '#a02622',
};

/** 等级对应的支护建议 */
export const GRADE_SUPPORT: Record<RockGrade, string> = {
  'Ⅰ': '局部锚杆（φ22，L=2.0 m，间距 1.5 m），喷射混凝土 5 cm',
  'Ⅱ': '系统锚杆（φ22，L=2.5 m，间距 1.2 m）+ 喷射混凝土 8 cm',
  'Ⅲ': '系统锚杆（φ25，L=3.0 m，间距 1.0 m）+ 喷射混凝土 12 cm + 钢筋网',
  'Ⅳ': '钢拱架（I16，间距 1.0 m）+ 系统锚杆（φ25，L=3.5 m）+ 喷射混凝土 20 cm',
  'Ⅴ': '超前小导管（φ42，L=4.5 m，环向间距 0.4 m）+ 钢拱架（I18，间距 0.75 m）+ 喷射混凝土 25 cm',
  'Ⅵ': '超前管棚（φ108，L=20 m）+ 钢拱架（I20b，间距 0.5 m）+ 双层钢筋网 + 喷射混凝土 30 cm，必要时超前预注浆',
};

/** 由涌水量与出水状态给出建议措施 */
export function waterMeasure(flow: number, type: string): string {
  if (flow >= 60 || type === '股状' || type === '涌流状出水') {
    return '立即停止掌子面作业，实施超前预注浆 + 径向注浆封堵，加强排水与监测';
  }
  if (flow >= 20) return '布设环向排水盲管 + 局部注浆堵水，加密涌水量监测频次';
  if (flow >= 5) return '设置纵向排水沟与集水坑，记录变化趋势，待喷锚后复测';
  return '常规排水，保持观察并纳入日常编录';
}

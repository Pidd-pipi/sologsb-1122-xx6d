import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import type {
  InvalidationReason,
  RockGrade,
  RockMassGrade,
  RockMassGradeDraft,
} from '../types/grade';
import { isCurrentGrade, normalizeGrade } from '../types/grade';
import type { WaterInflow, WaterInflowDraft } from '../types/water';
import type { JointSet } from '../types/joint';
import type { TunnelFace } from '../types/face';
import { basisSignature, basisText, buildBasis, recomputeGrade } from '../utils/gradeBasis';
import { emitDataChange } from '../utils/relayBus';

interface GradeState {
  items: RockMassGrade[];
  waters: WaterInflow[];
  loaded: boolean;
}

/** 依据变化后短时间内合并多次失效（一次连续录入只重算一次） */
const pending = new Map<string, Set<InvalidationReason>>();
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

export const useGradeStore = defineStore('grade', {
  state: (): GradeState => ({ items: [], waters: [], loaded: false }),
  getters: {
    /** 全部判定（新→旧，含失效/被取代记录用于追溯） */
    byFace: (state) => (faceId: string) =>
      state.items
        .filter((it) => it.faceId === faceId)
        .map(normalizeGrade)
        .sort((a, b) => b.judgedAt - a.judgedAt),
    /** 现行结论（active/pending；失效、已被取代的不再当现行） */
    latestByFace: (state) => (faceId: string) =>
      state.items
        .filter((it) => it.faceId === faceId)
        .map(normalizeGrade)
        .filter(isCurrentGrade)
        .sort((a, b) => b.judgedAt - a.judgedAt)[0],
    watersByFace: (state) => (faceId: string) =>
      state.waters
        .filter((it) => it.faceId === faceId)
        .sort((a, b) => a.chainage - b.chainage),
  },
  actions: {
    async load() {
      const grades = (await db.grades.toArray()).map(normalizeGrade);
      this.items = grades.sort((a, b) => b.judgedAt - a.judgedAt);
      const waters = await db.waters.toArray();
      this.waters = waters.sort((a, b) => a.chainage - b.chainage);
      this.loaded = true;
    },

    /** 保存一次判定（新判定保存后旧记录转为 superseded） */
    async saveGrade(draft: RockMassGradeDraft) {
      const plain = toPlain(draft);
      const record: RockMassGrade = { ...plain, id: newId('grade'), judgedAt: Date.now() };
      await this.putWithSuperseded(record);
      return record;
    },

    /** 兼容旧调用 */
    async addGrade(draft: RockMassGradeDraft) {
      return this.saveGrade(draft);
    },

    async putWithSuperseded(record: RockMassGrade) {
      const faceId = record.faceId;
      await db.transaction('rw', db.grades, async () => {
        const current = await db.grades.where('faceId').equals(faceId).toArray();
        for (const row of current) {
          if (isCurrentGrade(normalizeGrade(row))) {
            await db.grades.put(toPlain({ ...row, status: 'superseded' }));
          }
        }
        await db.grades.put(toPlain(normalizeGrade(record)));
      });
      this.items = (await db.grades.toArray())
        .map(normalizeGrade)
        .sort((a, b) => b.judgedAt - a.judgedAt);
      emitDataChange('grades', faceId);
    },

    async addWater(draft: WaterInflowDraft) {
      const record: WaterInflow = { ...toPlain(draft), id: newId('water'), measuredAt: Date.now() };
      await db.waters.put(toPlain(record));
      this.waters = [...this.waters, record].sort((a, b) => a.chainage - b.chainage);
      emitDataChange('waters', record.faceId);
      // 涌水变化 → 现行判定立即失效重算
      this.invalidateForFace(record.faceId, 'water');
      return record;
    },

    async removeWater(id: string) {
      const target = this.waters.find((it) => it.id === id);
      await db.waters.delete(id);
      this.waters = this.waters.filter((it) => it.id !== id);
      if (target) {
        emitDataChange('waters', target.faceId);
        this.invalidateForFace(target.faceId, 'water');
      }
    },

    /**
     * 依据（节理/涌水/岩层产状）变化后：
     * 现行记录立即标记失效，并按原输入参数 + 新依据重算一条新记录。
     * 多次触发按掌子面合并，连续录入只在停顿后重算一次。
     */
    invalidateForFace(faceId: string, reason: InvalidationReason) {
      const reasons = pending.get(faceId) ?? new Set<InvalidationReason>();
      reasons.add(reason);
      pending.set(faceId, reasons);
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        void this.flushInvalidations();
      }, 800);
    },

    async flushInvalidations() {
      if (pending.size === 0) return;
      const batch = new Map(pending);
      pending.clear();
      for (const [faceId, reasons] of batch) {
        await this.recompute(faceId, Array.from(reasons));
      }
    },

    async recompute(faceId: string, reasons: InvalidationReason[]) {
      const latest = this.items
        .filter((it) => it.faceId === faceId)
        .map(normalizeGrade)
        .filter(isCurrentGrade)
        .sort((a, b) => b.judgedAt - a.judgedAt)[0];
      if (!latest) return;

      // 直接读库取最新依据：触发重算的页面（如涌水页）未必加载了节理/掌子面 store
      const [faceRow, jointRows, waterRows] = await Promise.all([
        db.faces.get(faceId),
        db.joints.where('faceId').equals(faceId).toArray(),
        db.waters.where('faceId').equals(faceId).toArray(),
      ]);

      const basis = buildBasis(faceRow, jointRows, waterRows);
      // 依据签名未变（如仅非判定字段变化）则不重算
      if (latest.basisSignature && latest.basisSignature === basisSignature(basis)) return;

      const recomputed = recomputeGrade(latest, {
        face: faceRow,
        joints: jointRows,
        waters: waterRows,
        reason: reasons[0],
      });
      recomputed.invalidatedReasons = reasons;

      await db.transaction('rw', db.grades, async () => {
        await db.grades.put(
          toPlain({
            ...latest,
            status: 'stale',
            invalidatedReasons: mergeReasons(latest.invalidatedReasons, reasons),
            invalidatedAt: Date.now(),
          }),
        );
        await db.grades.put(toPlain(normalizeGrade(recomputed)));
      });
      this.items = (await db.grades.toArray())
        .map(normalizeGrade)
        .sort((a, b) => b.judgedAt - a.judgedAt);
      emitDataChange('grades', faceId);
    },

    /** 复核通过：确认待复核记录为现行结论 */
    async confirmReview(id: string) {
      const row = this.items.find((it) => it.id === id);
      if (!row) return;
      const reviewedAt = Date.now();
      await db.grades.put(
        toPlain({ ...row, status: 'active', reviewRequired: false, reviewedAt }),
      );
      this.items = this.items.map((it) =>
        it.id === id ? { ...it, status: 'active', reviewRequired: false, reviewedAt } : it,
      );
      emitDataChange('grades', row.faceId);
    },

    /** 复核时改判为指定级别（人工复核修正） */
    async reviewAdjust(id: string, grade: RockGrade, suggestion: string) {
      const row = this.items.find((it) => it.id === id);
      if (!row) return;
      const reviewedAt = Date.now();
      await db.grades.put(
        toPlain({
          ...row,
          grade,
          supportSuggestion: suggestion,
          status: 'active',
          reviewRequired: false,
          manualAdjusted: true,
          reviewedAt,
        }),
      );
      this.items = this.items.map((it) =>
        it.id === id
          ? {
              ...it,
              grade,
              supportSuggestion: suggestion,
              status: 'active',
              reviewRequired: false,
              manualAdjusted: true,
              reviewedAt,
            }
          : it,
      );
      emitDataChange('grades', row.faceId);
    },

    /** 放弃人工保留，采用系统自动算得的级别（人工修正记录上有 autoGrade） */
    async adoptAuto(id: string) {
      const row = this.items.find((it) => it.id === id);
      if (!row || !row.autoGrade) return;
      await db.grades.put(
        toPlain({
          ...row,
          grade: row.autoGrade,
          correctedBq: row.autoCorrectedBq ?? row.correctedBq,
          status: 'active',
          reviewRequired: false,
          manualAdjusted: false,
          reviewedAt: Date.now(),
        }),
      );
      this.items = (await db.grades.toArray())
        .map(normalizeGrade)
        .sort((a, b) => b.judgedAt - a.judgedAt);
      emitDataChange('grades', row.faceId);
    },
  },
});

function mergeReasons(
  old: InvalidationReason[] | undefined,
  add: InvalidationReason[],
): InvalidationReason[] {
  return Array.from(new Set([...(old ?? []), ...add]));
}

/** 供判定页保存时计算依据签名 */
export function signatureOf(
  face: TunnelFace | undefined,
  joints: JointSet[],
  waters: WaterInflow[],
) {
  const basis = buildBasis(face, joints, waters);
  return { signature: basisSignature(basis), text: basisText(basis) };
}

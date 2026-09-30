import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import type { JointSet, JointSetDraft } from '../types/joint';
import { emitDataChange } from '../utils/relayBus';

interface JointState {
  items: JointSet[];
  loaded: boolean;
}

/** 延迟拿 gradeStore，避免与 gradeStore 的模块初始化顺序耦合 */
async function invalidateGrade(faceId: string): Promise<void> {
  const { useGradeStore } = await import('./gradeStore');
  useGradeStore().invalidateForFace(faceId, 'joint');
}

export const useJointStore = defineStore('joint', {
  state: (): JointState => ({ items: [], loaded: false }),
  getters: {
    byFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => a.setNo - b.setNo),
  },
  actions: {
    async load() {
      const rows = await db.joints.toArray();
      rows.sort((a, b) => a.setNo - b.setNo);
      this.items = rows;
      this.loaded = true;
    },
    async add(draft: JointSetDraft) {
      const record: JointSet = { ...toPlain(draft), id: newId('joint') };
      await db.joints.put(toPlain(record));
      this.items = [...this.items, record];
      emitDataChange('joints', record.faceId);
      // 节理产状变化 → 现行判定立即失效重算
      void invalidateGrade(record.faceId);
      return record;
    },
    async update(id: string, patch: Partial<JointSet>) {
      const plain = toPlain(patch);
      await db.joints.update(id, plain);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...plain } : it));
      const target = this.items.find((it) => it.id === id);
      if (target) {
        emitDataChange('joints', target.faceId);
        void invalidateGrade(target.faceId);
      }
    },
    async remove(id: string) {
      const target = this.items.find((it) => it.id === id);
      await db.joints.delete(id);
      this.items = this.items.filter((it) => it.id !== id);
      if (target) {
        emitDataChange('joints', target.faceId);
        void invalidateGrade(target.faceId);
      }
    },
    /** 把同组产状合并到指定组：把被合并组的条数累加到目标组并删除被合并组 */
    async mergeInto(targetId: string, sourceIds: string[]) {
      const target = this.items.find((it) => it.id === targetId);
      if (!target) return;
      const sources = this.items.filter((it) => sourceIds.includes(it.id));
      const extra = sources.reduce((s, j) => s + j.jointCount, 0);
      await this.update(targetId, { jointCount: target.jointCount + extra });
      for (const s of sources) {
        await this.remove(s.id);
      }
    },
  },
});

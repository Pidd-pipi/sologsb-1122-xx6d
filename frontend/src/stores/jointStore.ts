import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { notifyDataChanged } from '../utils/relay';
import type { JointSet, JointSetDraft } from '../types/joint';

interface JointState {
  items: JointSet[];
  loaded: boolean;
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
      const record: JointSet = { ...toPlain(draft), id: newId('joint'), createdAt: Date.now() };
      await db.joints.put(toPlain(record));
      this.items = [...this.items, record];
      notifyDataChanged(record.faceId, 'joint');
      return record;
    },
    async update(id: string, patch: Partial<JointSet>) {
      const plain = toPlain(patch);
      await db.joints.update(id, plain);
      const target = this.items.find((it) => it.id === id);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...plain } : it));
      if (target) notifyDataChanged(target.faceId, 'joint');
    },
    async remove(id: string) {
      const target = this.items.find((it) => it.id === id);
      await db.joints.delete(id);
      this.items = this.items.filter((it) => it.id !== id);
      if (target) notifyDataChanged(target.faceId, 'joint');
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

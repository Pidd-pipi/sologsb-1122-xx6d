import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import type { Attitude, TunnelFace, TunnelFaceDraft } from '../types/face';
import { emitDataChange } from '../utils/relayBus';

/** 延迟拿 gradeStore，避免模块循环初始化耦合 */
async function invalidateGrade(faceId: string): Promise<void> {
  const { useGradeStore } = await import('./gradeStore');
  useGradeStore().invalidateForFace(faceId, 'attitude');
}

interface FaceState {
  items: TunnelFace[];
  loaded: boolean;
}

export const useFaceStore = defineStore('face', {
  state: (): FaceState => ({ items: [], loaded: false }),
  getters: {
    byId: (state) => (id: string) => state.items.find((it) => it.id === id),
    latest: (state) =>
      [...state.items].sort((a, b) => b.chainage - a.chainage)[0],
  },
  actions: {
    async load() {
      const rows = await db.faces.toArray();
      rows.sort((a, b) => b.chainage - a.chainage);
      this.items = rows;
      this.loaded = true;
    },
    async add(draft: TunnelFaceDraft) {
      const record: TunnelFace = { ...toPlain(draft), id: newId('face'), recordedAt: Date.now() };
      await db.faces.put(toPlain(record));
      this.items = [...this.items, record].sort((a, b) => b.chainage - a.chainage);
      emitDataChange('faces', record.id);
      return record;
    },
    async update(id: string, patch: Partial<TunnelFace>) {
      const plain = toPlain(patch);
      await db.faces.update(id, plain);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...plain } : it));
      emitDataChange('faces', id);
      // 岩层产状变化 → 现行判定立即失效重算
      if (plain.attitude) {
        void invalidateGrade(id);
      }
    },
    /** 单独更新岩层产状（素描/基本信息编录用） */
    async updateAttitude(id: string, attitude: Attitude) {
      await this.update(id, { attitude: toPlain(attitude) });
    },
    async remove(id: string) {
      await db.faces.delete(id);
      this.items = this.items.filter((it) => it.id !== id);
      emitDataChange('faces', id);
    },
    /** 复制上一循环（里程更小的最近一个掌子面）的信息作为草稿 */
    previousDraft(id: string): TunnelFaceDraft | undefined {
      const current = this.items.find((it) => it.id === id);
      if (!current) return undefined;
      const prev = [...this.items]
        .filter((it) => it.chainage < current.chainage)
        .sort((a, b) => b.chainage - a.chainage)[0];
      if (!prev) return undefined;
      const { id: _omit, recordedAt: _omit2, ...draft } = prev;
      return toPlain(draft);
    },
  },
});

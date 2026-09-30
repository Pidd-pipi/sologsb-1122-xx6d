/**
 * 编录接力逻辑冒烟测试（node 环境直接跑 TS 源码）：
 * 锁申请 / 心跳续约 / 掉线自动释放 / 接管 / 草稿接力 / 判定失效。
 * 运行：npx tsx scripts/relay-smoke.ts
 */
import { createPinia, setActivePinia } from 'pinia';
import { useRelayStore } from '../src/stores/relayStore';
import { useJointStore } from '../src/stores/jointStore';
import { useGradeStore } from '../src/stores/gradeStore';
import { useFaceStore } from '../src/stores/faceStore';
import { useGradeStaleness } from '../src/hooks/useGradeStaleness';
import type { FaceLock } from '../src/utils/relay';
import { STALE_MS } from '../src/utils/relay';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// node 环境无 localStorage / window，补一个内存版（接力锁/草稿都依赖它）
const memory = new Map<string, string>();
const localStoragePolyfill = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  key: (i: number) => Array.from(memory.keys())[i] ?? null,
  get length() {
    return memory.size;
  },
};
(globalThis as any).localStorage = localStoragePolyfill;
(globalThis as any).window = globalThis;

setActivePinia(createPinia());
const relay = useRelayStore();
relay.tabId = 'tabA';
relay.operator = '页面A';
relay.now = Date.now();

console.log('—— 锁生命周期 ——');
assert(relay.acquire('f1') === 'holding', '空闲掌子面申请 → holding');
assert(relay.locks['f1']?.tabId === 'tabA', '锁属于本标签页');
assert(relay.acquire('f1') === 'holding', '同标签页重复申请 → holding（接力无缝）');

relay.tabId = 'tabB';
assert(relay.acquire('f1') === 'locked', '其他标签页申请 → locked');
assert(relay.occupiedByOther('f1')?.operator === '页面A', '占用者信息可读');

// 模拟 A 崩溃：心跳停在 STALE_MS 之前
relay.tabId = 'tabA';
relay.locks['f1'].lastBeat = Date.now() - (STALE_MS + 1000);
relay.now = Date.now();
relay.tabId = 'tabB';
assert(relay.isStale('f1') === true, '超过 6s 无心跳 → 判定掉线');
assert(relay.acquire('f1') === 'holding', '掉线后申请 → 自动接力 holding');
assert(relay.locks['f1']?.tabId === 'tabB', '编辑权已转到 B');

console.log('—— 心跳与反接管 ——');
// A 持有 f2；B 仅通过 localStorage 接管（模拟通道消息丢失的兜底场景）
relay.tabId = 'tabA';
relay.acquire('f2');
const bLock: FaceLock = {
  faceId: 'f2',
  tabId: 'tabB',
  operator: '页面B',
  heldAt: Date.now(),
  lastBeat: Date.now(),
};
memory.set('gbtunnelface:lock:f2', JSON.stringify(bLock));
relay.beat();
assert(relay.locks['f2'] === undefined, '心跳发现已被接管 → 自动松手');

console.log('—— 掉线清扫 ——');
relay.tabId = 'tabA';
relay.acquire('f3');
relay.locks['f3'].lastBeat = Date.now() - (STALE_MS + 1000);
relay.tabId = 'tabB';
relay.sweepStale();
assert(relay.locks['f3'] === undefined, 'sweepStale 清掉掉线锁（编辑权自动释放）');

console.log('—— 释放 ——');
relay.tabId = 'tabB';
relay.release('f1');
assert(relay.locks['f1'] === undefined, '主动释放后锁消失');

console.log('—— 草稿接力 ——');
relay.putDraft('f1', 'joint', { setNo: 2, dipDirection: 130 });
assert(relay.draftOf('f1')?.kind === 'joint', '草稿已暂存');
assert((relay.draftOf('f1')?.data as any).setNo === 2, '草稿内容正确');
relay.clearDraft('f1', 'joint');
assert(relay.draftOf('f1') === undefined, '提交后草稿清除');

console.log('—— 跨标签页消息 ——');
const remoteLock: FaceLock = {
  faceId: 'f4',
  tabId: 'tabC',
  operator: '页面C',
  heldAt: Date.now(),
  lastBeat: Date.now(),
};
relay.onMessage({ type: 'lock:beat', lock: remoteLock });
assert(relay.locks['f4']?.tabId === 'tabC', '收到他人心跳 → 同步占用者');
relay.onMessage({ type: 'lock:release', faceId: 'f4', tabId: 'tabC' });
assert(relay.locks['f4'] === undefined, '收到释放消息 → 锁移除');
relay.onMessage({ type: 'lock:beat', lock: { ...remoteLock, tabId: 'tabB' } });
assert(relay.locks['f4'] === undefined, '自己的心跳消息不回灌');

console.log('—— 判定失效重算 ——');
const jointStore = useJointStore();
const gradeStore = useGradeStore();
const faceStore = useFaceStore();
const T0 = Date.now() - 100000;
faceStore.items = [
  {
    id: 'f1',
    faceNo: 'ZK-102',
    chainage: 12480,
    mileageRange: [12480, 12483],
    excavationMethod: '台阶法',
    faceSize: '12.6×9.8',
    lithology: '石灰岩',
    weathering: '微风化',
    rockStrength: 62,
    attitude: { strike: 42, dipDirection: 132, dipAngle: 34 },
    recordedAt: T0,
    updatedAt: T0,
    geologist: '岑柏川',
  },
];
jointStore.items = [
  {
    id: 'j1',
    faceId: 'f1',
    setNo: 1,
    dipDirection: 128,
    dipAngle: 72,
    spacing: 42,
    persistence: 3.6,
    aperture: 1.2,
    fillMaterial: '方解石',
    roughness: '粗糙',
    waterWet: '潮湿',
    jointCount: 9,
    createdAt: T0,
  },
];
gradeStore.items = [
  {
    id: 'g1',
    faceId: 'f1',
    grade: 'Ⅲ',
    bqValue: 358,
    rqd: 78,
    jv: 6.2,
    kv: 0.61,
    groundwater: '点滴状出水',
    spanWidth: 12.6,
    correction: 0.1,
    correctedBq: 348,
    supportSuggestion: '',
    manualAdjusted: false,
    judgedAt: T0,
  },
];
gradeStore.waters = [];

const { byFace } = useGradeStaleness();
assert(byFace.value['f1']?.stale === false, '判定后无变更 → 现行有效');

// 新录入一节理组（时间晚于判定）
jointStore.items = [
  ...jointStore.items,
  {
    id: 'j2',
    faceId: 'f1',
    setNo: 2,
    dipDirection: 216,
    dipAngle: 46,
    spacing: 68,
    persistence: 2.4,
    aperture: 0.6,
    fillMaterial: '泥质',
    roughness: '平整',
    waterWet: '滴水',
    jointCount: 5,
    createdAt: Date.now(),
  },
];
assert(byFace.value['f1']?.stale === true, '节理变化 → 自动判定立即失效');
assert(byFace.value['f1']?.reasons.some((r) => r.includes('节理')), '失效原因含节理变更');

// 人工修正级别 + 涌水变化 → 保留但标待复核
gradeStore.items = [{ ...gradeStore.items[0], id: 'g2', manualAdjusted: true, judgedAt: T0 }];
gradeStore.waters = [
  {
    id: 'w1',
    faceId: 'f1',
    position: '拱顶',
    type: '滴水',
    estimatedFlow: 6,
    waterTemp: 14,
    waterPressure: 0.12,
    changeTrend: '增大',
    measuredAt: Date.now(),
    chainage: 12480,
  },
];
assert(byFace.value['f1']?.stale === true, '涌水变化 → 人工修正结论标待复核');
assert(byFace.value['f1']?.manual === true, '人工修正标记保留');
assert(byFace.value['f1']?.reasons.some((r) => r.includes('涌水')), '失效原因含涌水变更');

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);

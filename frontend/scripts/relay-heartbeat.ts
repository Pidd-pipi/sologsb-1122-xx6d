/**
 * 编录接力心跳时序测试（假时钟）：
 * 持有 → 心跳续约 → 崩溃停跳 → 6s 无心跳自动释放 → 他页接管。
 * 运行：npx tsx scripts/relay-heartbeat.ts
 */
import { createPinia, setActivePinia } from 'pinia';
import { useRelayStore } from '../src/stores/relayStore';
import { HEARTBEAT_MS, STALE_MS } from '../src/utils/relay';

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

// ---- 浏览器环境桩 ----
const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  key: (i: number) => Array.from(memory.keys())[i] ?? null,
  get length() {
    return memory.size;
  },
};
const sessionMemory = new Map<string, string>();
(globalThis as any).sessionStorage = {
  getItem: (k: string) => (sessionMemory.has(k) ? sessionMemory.get(k)! : null),
  setItem: (k: string, v: string) => void sessionMemory.set(k, v),
};
(globalThis as any).window = globalThis;
(globalThis as any).document = { addEventListener: () => {}, hidden: false };
(globalThis as any).addEventListener = () => {};

// ---- 假时钟：按绝对触发时间推进定时器 ----
const timers: Array<{ cb: () => void; ms: number; next: number }> = [];
(globalThis as any).setInterval = (cb: () => void, ms: number) => {
  timers.push({ cb, ms, next: Date.now() + ms });
  return timers.length as any;
};
(globalThis as any).clearInterval = () => {};

let nowOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + nowOffset;

function advance(ms: number) {
  const target = Date.now() + ms;
  while (Date.now() < target) {
    const nextFire = Math.min(...timers.map((t) => t.next), target);
    if (nextFire > Date.now()) nowOffset += nextFire - Date.now();
    for (const t of timers) {
      if (t.next <= Date.now()) {
        t.cb();
        t.next = Date.now() + t.ms;
      }
    }
  }
}

// ---- 场景：A 持有，B 等待，A 崩溃 ----
setActivePinia(createPinia());
const relay = useRelayStore();
relay.init();

console.log('—— 持锁与心跳 ——');
relay.acquire('f1');
assert(relay.locks['f1']?.tabId === relay.tabId, 'A 持有 f1');
const beat0 = relay.locks['f1'].lastBeat;

advance(HEARTBEAT_MS);
assert(relay.locks['f1'].lastBeat > beat0, `${HEARTBEAT_MS}ms 后心跳续约`);
const beat1 = relay.locks['f1'].lastBeat;

advance(HEARTBEAT_MS);
assert(relay.locks['f1'].lastBeat > beat1, '心跳持续续约，锁保持有效');

console.log('—— A 崩溃（停掉全部定时器）——');
timers.length = 0; // 页面死亡：心跳与清扫定时器全停
const crashBeat = relay.locks['f1'].lastBeat;

console.log('—— B 视角：等待自动释放 ——');
// B 是另一个标签页：独立 store 实例 + 独立 sessionStorage（标签页身份隔离）
sessionMemory.clear();
setActivePinia(createPinia());
const relayB = useRelayStore();
relayB.init();
assert(relayB.locks['f1']?.tabId === relay.tabId, 'B 看到 A 仍持有');
assert(relayB.acquire('f1') === 'locked', 'A 心跳未超时 → B 只能只读等待');

advance(STALE_MS - HEARTBEAT_MS - 500); // 约 3.5s
assert(relayB.isStale('f1') === false, '未到 6s 心跳超时 → 仍显示占用者');
assert(relayB.acquire('f1') === 'locked', '等待中：编辑权未释放');

advance(STALE_MS - 3500 + 1000); // 再推 3.5s，累计 7.0s 越过 6s 超时线
const released = relayB.isStale('f1') || !relayB.locks['f1'];
assert(released, '超过 6s 无心跳 → 占用者掉线，编辑权自动释放');
assert(relayB.acquire('f1') === 'holding', '编辑权自动释放 → B 接力成功');
assert(relayB.locks['f1']?.tabId === relayB.tabId, 'f1 编辑权已转到 B');

console.log('—— 崩溃后草稿仍可接上 ——');
// A 崩溃前暂存的草稿还在 localStorage
relayB.putDraft('f1', 'joint', { setNo: 3, dipDirection: 200 });
timers.length = 0; // B 也“崩溃”
setActivePinia(createPinia());
const relayC = useRelayStore();
relayC.init();
const draft = relayC.draftOf('f1');
assert(draft?.kind === 'joint', 'C 上线后看到未提交草稿');
assert((draft?.data as any)?.setNo === 3, '草稿内容完整，可继续编录');

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);

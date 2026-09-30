import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import App from './App.vue';
import router from './router';
import { ensureSeedData, markDbVersion } from './utils/db';
import { useRelayStore } from './stores/relayStore';
import { startDataSync } from './utils/dataSync';

async function bootstrap() {
  // 先完成 IndexedDB 迁移与示范数据灌入，再挂载应用
  await ensureSeedData();
  markDbVersion();

  const app = createApp(App);
  const pinia = createPinia();
  app.use(pinia);
  app.use(router);
  app.use(ElementPlus, { locale: zhCn });

  // 接力：心跳/占用者 + 跨标签页数据同步（纯本地，离线可用）
  const relay = useRelayStore(pinia);
  relay.start();
  startDataSync(relay.tabId);
  // 整页卸载时同步交还本页持有的全部编辑权（崩溃则由心跳 TTL 兜底）
  window.addEventListener('pagehide', () => relay.releaseAllSync());

  app.mount('#app');
}

void bootstrap();

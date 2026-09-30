# sologsb-1122 隧道掌子面地质编录台（gbtunnelface）

面向隧道施工地质人员的掌子面编录工作台：逐循环编录围岩级别、岩性、节理产状与涌水情况，绘制岩性素描并用数字表示结构面，实时按 BQ 指标判定围岩级别并给出支护建议。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21822**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| UI | Element Plus 2 |
| 构建 | Vite 5 |
| 状态管理 | Pinia |
| 路由 | Vue Router 4（history 模式） |
| 本地存储 | IndexedDB（Dexie 4）+ localStorage（素描线段、接力租约），含结构版本号与升级迁移 |
| 多标签页协作 | Web Locks API + BroadcastChannel + localStorage 心跳租约（无后端，纯浏览器原语） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1122/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── types/{face,joint,grade,water,relay}.ts
        ├── stores/{face,joint,grade,relayStore}.ts
        ├── components/common/{SketchCanvas,JointPolarPlot,GradeTag,FaceCard,LockBanner}.vue
        ├── hooks/{useFaceFilter,useGradeCalc,useFaceLock}.ts
        ├── pages/{FaceList,FaceDetail,JointEntry,WaterView,GradeJudge}.vue
        └── utils/{db,geoMath,id,relayBus,gradeBasis,dataSync,timing}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/faces` | 掌子面台账：里程区间/岩性/围岩级别/开挖方式筛选 + 级别分布条 | TunnelFace、RockMassGrade |
| `/faces/:id` | 掌子面详情：基本信息 + 岩性素描图 + 节理组列表 + 与上循环级别比对 | TunnelFace、JointSet、RockMassGrade |
| `/faces/:id/joints` | 节理产状录入：极点图/玫瑰图、同组产状合并、异常倾角提示 | JointSet |
| `/faces/:id/water` | 涌水记录与沿里程趋势折线，标记突变点与建议措施 | WaterInflow |
| `/grade/:faceId` | 围岩级别判定：逐项输入 RQD/Jv/Kv/出水状态，实时算级别与支护建议，可人工修正并保存 | RockMassGrade、TunnelFace |

`/` 重定向到 `/faces`，未匹配路由同样兜底到 `/faces`。

## 数据存储说明

- 数据库名 `gbtunnelface`，当前结构版本 **v3**（`localStorage['gbtunnelface:db-version']` 记录）。
- 五张表：`faces`（掌子面）、`joints`（节理组）、`grades`（围岩级别判定）、`waters`（涌水记录）、`drafts`（编录接力草稿）。
- v1 → v2 迁移：为老掌子面补 `attitude`、`mileageRange`，为级别记录补 `correctedBq`、`manualAdjusted`，为涌水补 `chainage`，并新增索引。
- v2 → v3 迁移：新增 `drafts` 草稿表（主键 `faceId:scope`），`grades` 增加接力状态索引；判定记录新增的 `status / basisSignature / reviewRequired / autoGrade` 等字段为可选项，老数据自动按「现行」对待。
- 岩性素描的结构面线段单独存 `localStorage['gbtunnelface:sketch:<faceId>']`，刷新后仍在。
- 接力租约存 `localStorage['gbtunnelface:relay:lock:<faceId>]`、排队项存 `localStorage['gbtunnelface:relay:wait:<faceId>:<tabId>]`。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范掌子面、4 组节理、1 条级别判定与 3 条涌水记录。

## 编录接力（多标签页同一掌子面）

纯前端、无需后端，全部基于浏览器原语，断网可用：

- **同一时刻一个页面可写**：每张掌子面只有一把编辑权。进入节理/涌水/判定页自动申请；被占用时自动 FIFO 排队，其他页面在横幅与台账卡片上看到占用者（可改名，如地质员姓名）、正在编录的内容与心跳时间，等待期间数据**只读但可离线查看**。
- **崩溃/无心跳自动释放**：持有者每 2.5s 续租，租约 TTL 9s；页面正常关闭走 `pagehide` 同步释放，崩溃或掉线超过 TTL 由心跳清扫自动释放，队首等待者随即接手。抢占临界区用 Web Locks API 串行化，非安全上下文降级为乐观 CAS。
- **草稿接力**：编辑中表单每 0.6s 防抖写入 IndexedDB `drafts` 表；原页面崩溃后，接手者进入时可一键「接续草稿」回填，也可丢弃；正式保存后草稿清除。
- **跨标签页实时一致**：所有写操作经 BroadcastChannel（降级 storage 事件）通知其他标签页重读，台账、详情、判定页与素描图均以接力后的最新数据为准。

## 判定失效与重算

- 每条判定保存时记录**依据签名**（节理产状、涌水、岩层产状等输入的稳定哈希）与依据摘要。
- **节理、涌水或岩层产状任一变化**，旧现行判定立即标记 `stale`（已失效，不再当现行结论），并在约 0.8s 合并连续录入后按原 RQD/Kv/洞跨等参数自动重算一条新判定；涌水升级会重推地下水修正系数 K1。
- **自动判定**：以新依据重算的级别直接成为现行结论；**人工修正**：保留人工级别但状态置为「待复核」，同时给出系统自动算得的建议级别与 [BQ]，在判定页可「确认保留 / 采用自动 / 复核改判」，处置后恢复现行。
- 台账、详情、判定页统一只把 `active / pending` 当现行；`stale / superseded` 记录保留可追溯，列表中灰显划线并标注失效原因。

## 功能要点

- **围岩级别实时判定**：`BQ = 90 + 3σc + 250Kv`，`[BQ] = BQ − 100(K1 + K2 + K3)`（K1 由出水状态、K2 由洞跨取值），再按 >550/451~550/351~450/251~350/151~250/≤150 映射到 Ⅰ~Ⅵ 级，并给出对应支护建议；支持人工修正级别。
- **级别比对**：详情页与判定页自动与上一循环级别比对，输出「变好/变差 N 级」结论。
- **素描交互**：`<SketchCanvas>` 在图上单击即按当前岩层产状布置结构面线段，带岩性填充纹样、比例尺、图例与撤销/清空，线段本地持久化。
- **节理统计**：`<JointPolarPlot>` 等面积投影极点图 + 走向玫瑰图，按组着色；按倾向 30° 聚类支持同组产状合并。
- **异常提示**：倾角超出 0~90° 直接拦截；涌水量较上一点翻倍或趋势突增标记为突变点并给出措施。

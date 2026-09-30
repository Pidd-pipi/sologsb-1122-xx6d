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
| 本地存储 | IndexedDB（Dexie 4）+ localStorage（素描线段），含结构版本号与升级迁移 |

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
        ├── types/{face,joint,grade,water}.ts
        ├── stores/{face,joint,grade}Store.ts
        ├── components/common/{SketchCanvas,JointPolarPlot,GradeTag,FaceCard}.vue
        ├── hooks/{useFaceFilter,useGradeCalc}.ts
        ├── pages/{FaceList,FaceDetail,JointEntry,WaterView,GradeJudge}.vue
        └── utils/{db,geoMath,id}.ts
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

- 数据库名 `gbtunnelface`，当前结构版本 **v2**（`localStorage['gbtunnelface:db-version']` 记录）。
- 四张表：`faces`（掌子面）、`joints`（节理组）、`grades`（围岩级别判定）、`waters`（涌水记录）。
- v1 → v2 迁移：为老掌子面补 `attitude`、`mileageRange`，为级别记录补 `correctedBq`、`manualAdjusted`，为涌水补 `chainage`，并新增索引。
- 岩性素描的结构面线段单独存 `localStorage['gbtunnelface:sketch:<faceId>']`，刷新后仍在。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范掌子面、4 组节理、1 条级别判定与 3 条涌水记录。

## 功能要点

- **编录接力（多标签页协同）**：每张掌子面同一时刻只允许一个页面持有编辑锁，节理 / 涌水 / 判定页打开即接力，其他页面只读并显示占用者；持有者每 2s 心跳续约，超过 6s 无心跳（页面崩溃 / 被强杀）编辑权自动释放，等待页自动接力。未提交的表单草稿按掌子面暂存，刷新或接管后可接上继续。台账、详情、判定页都读接力数据，等待期间可离线查看已载入内容。
- **判定失效重算**：节理、涌水或岩层产状在最近一次级别判定之后发生变化，自动判定立即失效并提示重算；人工修正结论保留但标「待复核」。台账卡片、详情页、判定页历史表均有「已失效 / 待复核 / 现行」标记。
- **围岩级别实时判定**：`BQ = 90 + 3σc + 250Kv`，`[BQ] = BQ − 100(K1 + K2 + K3)`（K1 由出水状态、K2 由洞跨取值），再按 >550/451~550/351~450/251~350/151~250/≤150 映射到 Ⅰ~Ⅵ 级，并给出对应支护建议；支持人工修正级别。
- **级别比对**：详情页与判定页自动与上一循环级别比对，输出「变好/变差 N 级」结论。
- **素描交互**：`<SketchCanvas>` 在图上单击即按当前岩层产状布置结构面线段，带岩性填充纹样、比例尺、图例与撤销/清空，线段本地持久化。
- **节理统计**：`<JointPolarPlot>` 等面积投影极点图 + 走向玫瑰图，按组着色；按倾向 30° 聚类支持同组产状合并。
- **异常提示**：倾角超出 0~90° 直接拦截；涌水量较上一点翻倍或趋势突增标记为突变点并给出措施。

## 接力实现说明

| 组成 | 位置 | 职责 |
| --- | --- | --- |
| 接力原语 | `src/utils/relay.ts` | BroadcastChannel 实时通道 + localStorage 兜底；锁 / 草稿类型；心跳常量（2s/6s）；数据变更通知 |
| 接力状态 | `src/stores/relayStore.ts` | 锁与草稿的内存态、申请 / 续约 / 释放 / 接管、掉线清扫、跨标签页消息同步 |
| 编辑锁钩子 | `src/hooks/useFaceLock.ts` | 编辑页挂载即接力、掉线自动接管、离开释放 |
| 失效判定钩子 | `src/hooks/useGradeStaleness.ts` | 按判定后是否有节理 / 涌水 / 产状变更给出现行结论状态 |
| 锁横幅 / 草稿横幅 | `src/components/common/{LockBanner,DraftBanner}.vue` | 占用者 / 掉线接管 / 草稿恢复提示 |

标签页身份存 sessionStorage（刷新后身份不变、草稿可接上），操作者名存 localStorage。数据变更后由写入方广播 `data:changed`，其他页面防抖 400ms 后重载 stores，台账 / 详情 / 判定页随之刷新。

## 接力逻辑测试

```bash
cd frontend
npx tsx scripts/relay-smoke.ts       # 锁生命周期 / 草稿 / 失效判定（23 项）
npx tsx scripts/relay-heartbeat.ts   # 心跳续约 / 崩溃自动释放 / 接管时序（12 项，假时钟）
```

# 行星排共享轴角速度联立求解后端

教学用理想行星齿轮传动速度分析服务。输入若干单排行星机构及其共享轴，给定部分轴转速后**联立**求解全部轴的有符号转速（精确有理数）。仅做运动学：不生成齿廓、不模拟接触/惯性、不计算扭矩强度、润滑与公差。

## 模型约定

- 每根轴用唯一 ID 表示，**从同一观察方向看正转为正**，转速单位 rpm。
- 每排只有太阳轮（S）、内齿圈（R）、行星架（C）三个外部构件，各自引用已声明的轴。
- 每排满足 Willis 关系：`Ns*ωs + Nr*ωr - (Ns+Nr)*ωc = 0`（内啮合符号已含在公式中，不改为外啮合）。
- 齿数约束：`Ns`、`Nr` 为正整数，`Nr > Ns` 且 `Nr - Ns` 为正偶数（行星轮齿数 `(Nr-Ns)/2`，不额外校核装配空间）。
- 共享轴 ID 即表示同一根轴，不产生额外未知量；同一排中多个构件可引用同一轴（构件锁连），组装时先合并系数，不拒绝此类模型。
- 固定转速约束 `ω = v`（`v=0` 表示固定到机架）；锁连约束 `ωa = ωb`（两个不同 ID 的轴）。
- 所有已声明轴（包括未连接的孤立轴）都参与自由度解释。
- 所有计算使用 BigInt 精确有理数，不做浮点判秩；小数仅用于展示。

## 求解语义

- `UNIQUE`：唯一解，逐轴给出精确分数与展示小数，并返回每条原约束代入后的精确残差（全零）。
- `UNDERDETERMINED`：欠定。返回自由轴、自由变量置零的特解、每个自由变量一条齐次方向；任意参数组合 `特解 + Σ t_i·方向_i` 都满足原约束。可用 `substitute` 代入指定自由参数得到一个候选解，但不修改原系统自由度。
- `INCONSISTENT`：矛盾。返回原约束的线性组合见证，代回可核验 `0 = 非零`。冗余但一致的等式不算冲突。
- `BUDGET_EXCEEDED`：中间分数超出计算预算（与"约束不足"是不同状态）。

## 安装与运行（Windows 本地，Node.js >= 22，无需 Docker/WSL）

```
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 运行测试（含独立有理数核对）
npm start         # 启动 HTTP API（默认自动选择空闲端口）
npm run demo      # 运行演示（300 / -400 / 75 三个案例）
```

数据保存在项目内 `data/gears.db`（可用环境变量 `GEAR_DB`、`GEAR_DATA_DIR` 覆盖），端口用 `PORT` 指定，缺省自动选空闲端口。

## CLI

```
node dist/cli.js serve [port]
node dist/cli.js add-axis S
node dist/cli.js add-row 20 60 S R C
node dist/cli.js fix S 1200
node dist/cli.js fix R 0
node dist/cli.js lock A B
node dist/cli.js update-row 1 30 90     # 修改齿数，生成新版本
node dist/cli.js solve                  # 联立求解
node dist/cli.js substitute R=0 C=300   # 代入自由参数（欠定时）
node dist/cli.js equations              # 查询等式来源
node dist/cli.js report                 # 导出报告
node dist/cli.js snapshot <version>     # 查询冻结结果
node dist/cli.js axes / rows / constraints
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/axes` `{id}` | 创建轴（幂等） |
| GET | `/axes` | 有序轴列表 |
| POST | `/rows` `{Ns,Nr,sun,ring,carrier}` | 创建行星排 |
| PATCH | `/rows/:id` | 修改齿数/引用（生成新版本） |
| POST | `/constraints/fixed` `{axis,value}` | 固定转速（幂等） |
| POST | `/constraints/lock` `{a,b}` | 锁连两轴（幂等） |
| DELETE | `/constraints/:id` | 删除约束 |
| GET | `/equations` | 组装后的方程及来源 |
| POST | `/solve` | 联立求解并冻结结果 |
| POST | `/substitute` `{params:{轴:值}}` | 代入自由参数 |
| GET | `/report` | 完整报告 |
| GET | `/snapshots/:version` | 查询历史冻结结果 |

转速输入：有符号整数字符串（如 `"-400"`）或 `{"num":"1","den":"3"}`，统一约成分母为正的既约分数。

## 错误码

`BAD_AXIS_ID` / `AXIS_NOT_FOUND` / `BAD_TEETH` / `ROW_NOT_FOUND` / `CONSTRAINT_NOT_FOUND` / `SAME_AXIS` / `BAD_NUMBER` / `DENOMINATOR_ZERO` / `DIGITS_EXCEEDED` / `LIMIT_EXCEEDED` / `NOT_UNDERDETERMINED` / `VERSION_NOT_FOUND` / `BAD_JSON` / `NOT_FOUND` / `INTERNAL`。失败请求不会修改已保存系统；重复创建轴、重复导入相同固定转速/锁连为幂等操作。

## 限制

- 默认上限：轴 64、行星排 64、输入整数 60 位、中间分数 2048 bit（超限返回 `BUDGET_EXCEEDED` / `LIMIT_EXCEEDED`，而非"无解"）。
- 使用 Node 内置 `node:sqlite`（实验性 API，Node >= 22 可用）。
- 仅运动学速度分析，不做强度、效率、润滑、装配空间校核。

# 行星排共享轴角速度联立求解后端

教学用**理想行星齿轮传动速度分析**服务。输入若干单排行星机构及其共享轴，给定部分轴的转速后，**联立**求解全部轴的有符号转速。只做 API 与 CLI，无界面。

- 技术栈：TypeScript + Node.js（>= 22，使用内置 `node:sqlite`）+ SQLite，Windows 本地运行，无 Docker / WSL / 外部服务。
- 每排只有太阳轮、内齿圈、行星架三个外部构件；不生成齿廓、不模拟接触/惯性，不算扭矩、强度、润滑与公差。
- 核心关系为 Willis 方程：`Ns*ωs + Nr*ωr - (Ns+Nr)*ωc = 0`。各排约束按共享轴身份组装成线性方程组联立求解，**不是**把固定传动比逐级相乘。

## 符号约定与模型假设

- 每根轴用唯一 ID 表示；所有转速从**同一观察方向**看，正转为正，单位 rpm。
- 齿数 `Ns`、`Nr` 为正整数，要求 `Nr > Ns` 且差为正偶数（行星轮齿数 `(Nr-Ns)/2` 为整数）；不额外校验装配空间。
- 同一排的三个构件可以引用**同一根轴**（构件锁连），组装方程时先合并该轴的系数，不拒绝此类模型。
- 固定转速是独立线性约束，`0` 表示固连机架；也可声明两根不同 ID 的轴锁连（`ωa - ωb = 0`）。共享 ID 本身就是同一未知量，不重复制造变量。
- 所有已声明的轴（包括未连接的孤立轴）都参与自由度解释。

## 精确算术

- 转速输入支持有符号整数字符串（`"1200"`、`"-400"`）、分数字符串（`"-3/4"`）或对象（`{"num": -3, "den": 4}`），分母非零，统一约成分母为正的既约分数。
- 系数与消元全部使用 BigInt 有理数，不把超出安全整数范围的分数转浮点判秩。
- 自行实现小规模 Gauss-Jordan 消元，按轴声明顺序从左到右确定主元。

## 求解结果状态

| 状态 | 含义 |
| --- | --- |
| `unique` | 唯一解：给出每轴精确分数与仅用于展示的小数，并逐条返回代入后的精确零残差 |
| `underdetermined` | 欠定：给出自由轴列表、自由变量置零的特解、每个自由变量一条齐次方向；任意参数组合 `x = 特解 + Σ t_i·方向_i` 都满足原约束。可用代入接口生成候选解，但不改变系统自由度 |
| `inconsistent` | 矛盾：仅当某行系数全零而右端非零时判定；返回造成矛盾的原约束线性组合，代回可核验“零等于非零”。冗余但一致的等式不算冲突 |
| `budget_exceeded` | 计算预算不足（中间分数超出比特上限），与约束不足是不同的状态 |

限制：轴数 ≤ 64、行星排 ≤ 32、输入整数 ≤ 50 位、中间分数分子/分母 ≤ 4096 bit，超限返回未完成（`budget_exceeded` 或参数错误），而不是无解。

## 持久化与幂等

- SQLite 保存有序轴、齿数、原约束、版本与冻结求解结果；每次成功修改（齿数、转速、锁连、轴）生成新版本并冻结该版本的求解结果，可查询历史版本。
- 写接口支持 `Idempotency-Key` 请求头：重复请求返回首次响应；校验失败不写入、不覆盖原系统。
- 重启后仍可核对原始等式、特解、方向与矛盾见证。

## 构建、测试、启动、演示

```powershell
npm install        # 安装 devDependencies（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API 服务（默认自动选择空闲端口，--port 可指定）
npm run demo       # 运行三个演示场景
```

数据目录默认为项目内 `data/`（可用环境变量 `DATA_DIR`、`DB_PATH` 覆盖）。端口用 `--port` 或环境变量 `PORT` 配置，默认 `0`（自动选空闲端口），启动后打印实际端口。

## CLI

```powershell
node dist/src/cli.js create-axis --id S
node dist/src/cli.js add-gearset --id g1 --ns 20 --nr 60 --sun S --ring R --carrier C
node dist/src/cli.js fix-speed --id f1 --axis S --value 1200
node dist/src/cli.js fix-speed --id f2 --axis R --value 0
node dist/src/cli.js lock --id l1 --a A --b B
node dist/src/cli.js solve            # 当前版本冻结结果
node dist/src/cli.js state            # 轴/行星排/约束
node dist/src/cli.js equations        # 每条方程的来源与系数
node dist/src/cli.js substitute --params "{\"C\": \"100\"}"
node dist/src/cli.js report --out report.json
node dist/src/cli.js serve --port 8080
```

## HTTP API（仅监听 127.0.0.1）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/axes` | `{id}` 创建轴 |
| POST | `/gearsets` | `{id, ns, nr, sun, ring, carrier}` 创建行星排 |
| POST | `/fixed` | `{id, axis, value}` 固定转速（`value` 为整数/分数字符串或 `{num,den}`） |
| POST | `/locks` | `{id, a, b}` 两轴锁连 |
| POST | `/solve` | 返回当前版本冻结的求解结果 |
| GET | `/state` | 查询系统状态与版本 |
| GET | `/equations` | 查询每条方程的来源、系数与右端 |
| POST | `/substitute` | `{params: {自由轴: 值}}` 生成候选解并返回精确残差 |
| GET | `/report` | 导出完整报告（`?version=N` 可查历史版本） |

错误统一返回 `{ok:false, error:{code, message}}`，错误码包括 `E_AXIS_ID`、`E_TEETH`、`E_TEETH_ORDER`、`E_TEETH_PARITY`、`E_SPEED`、`E_REF`、`E_DUP`、`E_LOCK_SELF`、`E_LIMIT`、`E_ARGS`、`E_JSON`、`E_NOT_FOUND`、`E_INTERNAL`。

## 演示结果

- `Ns=20, Nr=60`，太阳轮 1200 rpm、齿圈固定 ⇒ 行星架 **300** rpm。
- 改为行星架固定、太阳轮 1200 rpm ⇒ 齿圈 **-400** rpm。
- 两排串联（第一排行星架与第二排太阳轮共轴，两排齿圈均固定）⇒ 末端行星架 **75** rpm。

## 测试

`npm test` 覆盖：欠定模型、重复一致约束、冲突转速（含矛盾组合的独立代入核验）、构件锁连、孤立轴、分数输入、预算超限、持久化与历史版本、幂等。所有解、基方向与矛盾组合都用独立的有理数代入核对残差，不只依赖求解状态。

## 限制

- 仅教学用理想运动学模型，不涉及动力学与强度。
- 消元为稠密 Gauss-Jordan，适合小规模（几十轴）系统。
- `node:sqlite` 在部分 Node 版本会打印 ExperimentalWarning，不影响功能。

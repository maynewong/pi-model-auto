# Quota-Aware Routing — MVP 实现文档

## 0. 目标与范围

让路由器在"某个订阅/账号打满"时**自动避开它、切到下一个可用模型**，并在窗口重置后自动恢复。只用两路**可靠信号**，不做预测性调度。

**In scope（本期做）**
- 接 `onResponse` 抓取速率限制响应头，归一化成统一的额度状态。
- 把 `429` / `retry-after` 当作"硬见底"的地面真相，给对应 plan 打冷却。
- 选择模型时跳过处于冷却期的 plan；跨 turn 自动恢复。
- （可选）turn 内 429 失败时，自动重选下一个 plan 重试。
- 冷却状态持久化，跨 session 存活（5h 窗口远长于一个 session）。
- 状态栏显示当前 plan 的冷却/剩余信息。

**Out of scope（明确不做）**
- 自计量账本估算（消耗累加）。
- rolling/calendar 窗口的精确建模。
- drain-first / deadline-aware 等贪心调度。
- 通过 `provider + baseUrl + auth identity` 区分同一 provider 下的多个账号/订阅/API key。

---

## 1. 核心概念

### 1.1 Plan 的定义
MVP 里 **`planKey = provider + baseUrl + auth identity`**。其中 auth identity 来自解析后的 `apiKey` / `headers` / `env`，只保存稳定 hash，不把明文密钥写入状态文件或状态栏。
> 同一 provider 下的 API 付费账号、订阅账号、兼容代理只要 baseUrl 或认证身份不同，就会进入不同额度桶。

### 1.2 两路信号
| 信号 | 来源 | 含义 | 可靠性 |
|---|---|---|---|
| 速率限制头 | `onResponse(response).headers` | `remaining` / `limit` / `resetAt` | 高（有头时直接采信） |
| 429 + retry-after | `onResponse` 的 `status===429`，或错误事件 | 真见底 + 重开时间 | 最高（地面真相） |

策略：**头里 remaining 低于阈值 → 软冷却预防；真 429 → 硬冷却纠偏。**

---

## 2. 数据结构

新增文件 `src/quota.ts`：

```ts
export interface RateLimitSnapshot {
  remaining?: number;   // 剩余额度（token 或 request，单位不强求统一）
  limit?: number;       // 总额度
  resetAt?: number;     // 窗口重开的绝对时间戳 (ms)，已归一化
}

export type PlanStatus = "ok" | "cooldown";

export interface PlanState {
  planKey: string;
  status: PlanStatus;
  cooldownUntil?: number;   // ms；status==="cooldown" 时有效
  reason?: string;          // "429" | "low-remaining" | ...
  lastSnapshot?: RateLimitSnapshot;
  updatedAt: number;
}

export interface QuotaConfig {
  enabled: boolean;       // 默认 true
  reserveRatio: number;   // 默认 0.05；remaining/limit 低于此 → 软冷却
  inTurnRetry: boolean;   // 默认 true；429 时 turn 内重选重试
  maxRetries: number;     // 默认 2
  defaultCooldownMs: number; // 默认 300000(5min)；拿不到 reset 时的兜底冷却
}
```

`QuotaState` 用一个 class 或闭包持有 `Map<string, PlanState>`，对外暴露：

```ts
isAvailable(planKey: string, now: number): boolean      // status==="ok" 或 cooldownUntil<=now
recordResponse(planKey, status, headers, provider, now) // 成功响应：解析头，更新 remaining/软冷却
recordRateLimited(planKey, retryAfterMs?, resetAt?, now) // 429：打硬冷却
snapshot(planKey): PlanState | undefined                // 给状态栏/调试用
load(file) / persist(file)                              // JSON 持久化
```

---

## 3. 头部归一化

`src/quota.ts` 内 `parseRateLimitHeaders(provider, headers): RateLimitSnapshot`。
头是 `Record<string,string>`（pi 已 lower-case key，见 SDK `utils/headers.ts`）。

```ts
function parseRateLimitHeaders(provider: string, h: Record<string,string>): RateLimitSnapshot {
  const snap: RateLimitSnapshot = {};

  // --- Anthropic：reset 是 RFC3339 时间戳 ---
  if (h["anthropic-ratelimit-tokens-remaining"] != null) {
    snap.remaining = num(h["anthropic-ratelimit-tokens-remaining"]);
    snap.limit = num(h["anthropic-ratelimit-tokens-limit"]);
    snap.resetAt = parseRfc3339(h["anthropic-ratelimit-tokens-reset"]);
  }

  // --- OpenAI 系：reset 是时长字符串 "6m0s" / "1s" ---
  else if (h["x-ratelimit-remaining-tokens"] != null) {
    snap.remaining = num(h["x-ratelimit-remaining-tokens"]);
    snap.limit = num(h["x-ratelimit-limit-tokens"]);
    const d = parseDuration(h["x-ratelimit-reset-tokens"]); // ms
    if (d != null) snap.resetAt = nowFn() + d;
  }

  // --- 通用兜底：retry-after（秒 或 HTTP-date） ---
  const ra = parseRetryAfter(h["retry-after"]);
  if (ra != null && snap.resetAt == null) snap.resetAt = nowFn() + ra;

  return snap;
}
```

辅助解析器（都要容错，解析失败返回 `undefined`，绝不抛）：
- `parseRfc3339(s)` → `Date.parse(s)`，NaN 返回 undefined。
- `parseDuration("6m0s")` → 正则 `(\d+)h?(\d+)m?(\d+)s?` 累加成 ms；也接受纯秒。
- `parseRetryAfter(s)` → 纯数字当秒；否则尝试 `Date.parse` 当 HTTP-date 再减 now。
- `num(s)` → `Number(s)`，NaN 返回 undefined。

> **重要**：各家头名以"路线一实测探针"结果为准。先按上表实现，跑一遍真请求确认 key 名再微调。订阅型 OAuth（`isUsingOAuth===true`）很可能拿不到 remaining，那就只靠 429，是预期内的。

---

## 4. 状态更新逻辑

```ts
// 成功/普通响应
recordResponse(planKey, status, headers, provider, now) {
  const snap = parseRateLimitHeaders(provider, headers);
  const st = this.get(planKey);
  st.lastSnapshot = snap;
  st.updatedAt = now;

  if (status === 429) { this.recordRateLimited(planKey, undefined, snap.resetAt, now); return; }

  // 软冷却：剩余比例过低，提前避让到 resetAt
  if (snap.remaining != null && snap.limit) {
    if (snap.remaining / snap.limit <= cfg.reserveRatio) {
      st.status = "cooldown";
      st.cooldownUntil = snap.resetAt ?? now + cfg.defaultCooldownMs;
      st.reason = "low-remaining";
      return;
    }
  }
  st.status = "ok"; st.cooldownUntil = undefined; st.reason = undefined;
}

// 硬见底
recordRateLimited(planKey, retryAfterMs, resetAt, now) {
  const st = this.get(planKey);
  st.status = "cooldown";
  st.cooldownUntil = resetAt ?? (retryAfterMs != null ? now + retryAfterMs : now + cfg.defaultCooldownMs);
  st.reason = "429";
  st.updatedAt = now;
}

isAvailable(planKey, now) {
  const st = this.map.get(planKey);
  if (!st || st.status === "ok") return true;
  if (st.cooldownUntil != null && now >= st.cooldownUntil) { // 自动恢复
    st.status = "ok"; st.cooldownUntil = undefined; st.reason = undefined;
    return true;
  }
  return false;
}
```

---

## 5. 接入点改动（`src/index.ts`）

### 5.1 session_start：加载持久化状态 + 初始化
```ts
let quota: QuotaState;                                   // 模块级
pi.on("session_start", async (_e, ctx) => {
  ...
  quota = new QuotaState(loadQuotaConfig(cfg));
  quota.load(quotaStateFile(ctx));                       // ~/.pi/agent/quota-state.json
});
```

### 5.2 选择阶段过滤冷却 plan
在 `selectModel` / `selectFromPool` 之前，先把 pool 过滤一遍。最小侵入做法：在 `index.ts` 的 `streamSimple` 里构造一个"可用视图"再传给选择：

```ts
const now = Date.now();
const usablePool = filterPoolByQuota(pool, quota, now);   // 见下
const decision = decide(context, options, forcedRoute, cfg);
const selection = selectModel(decision, usablePool, context, options, ctx, cfg);
```

`filterPoolByQuota`（放 `quota.ts` 或 `index.ts`）：

```ts
function filterPoolByQuota(pool: Pool, q: QuotaState, now: number): Pool {
  const keep = (m: ResolvedModel) => q.isAvailable(m.model.provider, now);
  const f = (arr: ResolvedModel[]) => arr.filter(keep);
  const next = { cheapPool: f(pool.cheapPool), strongPool: f(pool.strongPool),
                 standardPool: f(pool.standardPool), unknownPool: f(pool.unknownPool),
                 all: f(pool.all) };
  // 全被冷却时：降级为"无视冷却"，至少别让 agent 卡死
  if (next.all.length === 0) return pool;
  return next;
}
```

> 强制路由（`@model:` / `@cheap` / `@strong`）**不过滤**——用户显式指定时尊重意图，让 429 自然冒泡。

### 5.3 delegation：接 onResponse 抓头
```ts
const target = selection.selected.model;
const planKey = target.provider;

const inner = aiStreamSimple(target, context, {
  ...options,
  apiKey: auth.apiKey, headers: auth.headers, env: auth.env,
  reasoning, maxTokens,
  onResponse: (resp) => {
    quota.recordResponse(planKey, resp.status, resp.headers, target.provider, Date.now());
    quota.persist(quotaStateFile(ctx));
  },
});
```

### 5.4 终端事件：兜底捕获 429
有些 provider 的 429 不走 `onResponse` 而是直接报错。在现有 `for await` 里补：

```ts
for await (const event of inner) {
  stream.push(event);
  if (event.type === "error" && looksRateLimited(event.error)) {
    quota.recordRateLimited(planKey, undefined, undefined, Date.now());
    quota.persist(quotaStateFile(ctx));
  }
  if (event.type === "done" || event.type === "error") logTerminalEvent(...);
}
```

```ts
function looksRateLimited(msg: AssistantMessage): boolean {
  const t = `${msg.stopReason ?? ""} ${msg.errorMessage ?? ""}`.toLowerCase();
  return t.includes("429") || t.includes("rate limit") || t.includes("too many requests") || t.includes("quota");
}
```

---

## 6.（可选）Turn 内 failover 重试

只在"还没向用户 stream 出任何内容"时安全。把 5.3/5.4 包成一个带重试的循环：

```ts
let attempts = 0, excluded = new Set<string>();
while (true) {
  const usablePool = filterPoolByQuota(pool, quota, Date.now(), excluded);
  const selection = selectModel(decision, usablePool, context, options, ctx, cfg);
  const target = selection.selected.model;
  const planKey = target.provider;

  let emittedContent = false, rateLimited = false;
  const inner = aiStreamSimple(target, context, { ...wired });
  for await (const event of inner) {
    if (event.type === "error" && looksRateLimited(event.error)) {
      quota.recordRateLimited(planKey, ...); rateLimited = true; break; // 不 push
    }
    if (event.type === "chunk" /* 任何已产出内容 */) emittedContent = true;
    stream.push(event);
    if (event.type === "done" || event.type === "error") logTerminalEvent(...);
  }

  if (rateLimited && !emittedContent && cfg.quota.inTurnRetry && attempts < cfg.quota.maxRetries) {
    excluded.add(planKey); attempts++; continue;            // 换 plan 重试
  }
  if (rateLimited && (emittedContent || attempts >= cfg.quota.maxRetries)) {
    stream.push(makeRouterError(routerModel, new Error(`rate limited on ${planKey}, no fallback left`)));
  }
  break;
}
stream.end();
```

`filterPoolByQuota` 增加 `excluded: Set<string>` 参数，`keep` 里加 `&& !excluded.has(m.model.provider)`。

> 谨慎：一旦内容已 stream（`emittedContent`），**不能重试**，否则用户会看到半截被覆盖。MVP 可以先**不做 turn 内重试**（`inTurnRetry:false`），只靠跨 turn 避让——更稳，价值也已占大头。把本节当增强项。

---

## 7. 持久化

`~/.pi/agent/quota-state.json`：

```ts
function quotaStateFile(ctx): string { return join(getAgentDir(), "quota-state.json"); }

persist(file) { writeFileSync(file, JSON.stringify({ version:2, plans:[...map.values()] })); }
load(file)    { if (!existsSync(file)) return;
                try { for (const p of JSON.parse(read).plans) map.set(p.planKey, p); } catch {} }
```
- 写入时机：每次 `recordResponse` / `recordRateLimited` 后（量很小，直接同步写可接受；嫌频繁可 debounce）。
- 读取时机：`session_start`。
- 容错：解析失败静默忽略，等价于"无冷却记录"。

---

## 8. 配置

`RouterConfig` 加 `quota?: Partial<QuotaConfig>`，`DEFAULT_CONFIG` 给默认值，`loadConfig` 里浅合并（仿现有 `weights`）：

```jsonc
{
  "router": {
    "quota": {
      "enabled": true,
      "reserveRatio": 0.05,
      "inTurnRetry": false,
      "maxRetries": 2,
      "defaultCooldownMs": 300000
    }
  }
}
```
`enabled:false` 时 `filterPoolByQuota` 直接返回原 pool 且不接 `onResponse`，完全旁路。

---

## 9. 可观测性

### 9.1 状态栏
`shortStatus` 里追加冷却提示：
```ts
const st = quota.snapshot(chosenProvider);
const tag = st?.status === "cooldown"
  ? ` ⏳${Math.ceil((st.cooldownUntil! - Date.now())/60000)}m`
  : st?.lastSnapshot?.remaining != null && st.lastSnapshot.limit
    ? ` ${Math.round(100*st.lastSnapshot.remaining/st.lastSnapshot.limit)}%`
    : "";
// 🧭 gpt-5.5 · strong  /  🧭 gpt-5.5 · strong ⏳12m
```

### 9.2 `/router` 命令
`describeRouter` 末尾增加一段"plans"，列出每个 plan 的 status / cooldownUntil / remaining，方便调试。

### 9.3 日志
冷却变更时（进入/退出 cooldown）写一行到现有 `router.log`：`{ts, planKey, status, reason, cooldownUntil}`。

---

## 10. 已知限制（写进 README，避免误信）
- **planKey 不包含 model id**：同一账号下不同 model 共享冷却，符合 provider/account 额度桶语义。
- **订阅型 OAuth 可能无 remaining 头**：这类只有真撞 429 才会冷却，没有提前避让。属预期。
- **软冷却依赖头单位一致性**：remaining/limit 可能是 request 维度而非 token 维度，比例阈值仍有效，但语义需在探针后确认。
- **估算漂移不处理**：本期不自计量，不累加消耗。

---

## 11. 测试方案
- **单测**（`quota.ts` 纯函数，最高价值）：
  - `parseRateLimitHeaders`：anthropic / openai / 仅 retry-after / 空头 四类样本。
  - `parseRfc3339` / `parseDuration` / `parseRetryAfter` 容错（坏输入 → undefined）。
  - `QuotaState` 状态机：429→cooldown→到点自动恢复；low-remaining→软冷却；isAvailable 边界。
  - `filterPoolByQuota`：部分冷却、全冷却降级、excluded 叠加。
- **手测/探针**：先做"头部 dump 探针"（第 3 节 onResponse 落 jsonl），各 plan 各发一条，核对 key 名与单位，再据此校正解析器。
- **集成**：人为把某 provider 的 `defaultCooldownMs` 调长 + mock 一个 429，确认下一 turn 自动切换、窗口后恢复。

---

## 12. 分步实施清单（建议 PR 粒度）
1. **PR1 探针**：`streamSimple` 接 `onResponse`，把 `{provider,status,headers}` 落 `header-probe.jsonl`（仅日志，不改路由）。跑真请求，定下各家头名。
2. **PR2 核心**：`quota.ts`（数据结构 + 解析 + 状态机 + 持久化）+ 单测。纯模块，不接路由。
3. **PR3 接入避让**：`filterPoolByQuota` + `onResponse`/终端事件接 `recordResponse`/`recordRateLimited` + 配置项。跨 turn 自动避让 & 恢复。
4. **PR4 可观测**：状态栏冷却标记 + `/router` plans 段 + 日志。
5. **PR5（可选）**：turn 内 failover 重试。
6. **PR6 文档**：README 增"Quota-aware routing"段 + 已知限制。
</content>
</invoke>

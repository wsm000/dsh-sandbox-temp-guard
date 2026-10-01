# dsh-sandbox-temp-guard

[English](#english) · 中文

DeepSeek Harness（DSH）Windows 沙箱自愈插件：当系统临时目录清理把会话私有 temp 目录
（`%TEMP%\dsh-XXXXXX`）删掉时，自动重建目录并补回 ACL 授权，让命令不再报
`SANDBOX_UNAVAILABLE`；同时对仍然漏网的"后端不可用"错误追加排查指引，避免 Agent
把它误判成"沙箱已损坏"而反复申请 `danger-full-access` 提权。

对应上游讨论：[deepseek-ai/deepseek-harness Discussion #8550](https://github.com/deepseek-ai/deepseek-harness/discussions/8550)

## 它解决什么

在 Windows 上，`@deepseek-ai/dsh-sandbox-local` 为每个 (会话, 工作区) 组合创建一次
私有临时目录并缓存整个 provider 生命周期：

```js
const tempDir = mkdtempSync(join(tmpdir(), 'dsh-'))   // %TEMP%\dsh-XXXXXX
// + 一个可撤销的 capability-SID ACL 授权
this.tempCapabilities.set(key, { dir: tempDir, writeSid, grant })
```

之后每次 `confine()` 都直接复用缓存的 `dir`，**不检查目录是否还存在**。一旦
Storage Sense / 清理工具 / 手动删除把这个目录清掉：

1. runner 收到 `--temp <已消失的路径>`，`requireDirectory` 失败 →
   `windows-acl-run: --temp is not an existing directory`（exit 127）
2. seam 按 fail-closed 原则抛出 `SandboxUnavailableError`（`SANDBOX_UNAVAILABLE`）
3. **该会话内此后每条命令都失败，且重试无效**（失败发生在命令执行之前），
   直到 DSH 重启。缓存里的坏路径会一直用下去。

同一个环境里多个会话会相继中招（实测 `dsh-X5ECMI`、`dsh-uTBiqr`、`dsh-r0YqAq`）。

## 插件做什么

1. **修复（核心）**：在每次工具执行前（并可配置地周期性）找到活跃 sandbox provider
   缓存的 temp capability，对缺失的目录执行 `mkdirSync` 并重新 `grant.add(dir)`
   （目录没了，挂在它上面的 ACE 也随之消失，必须补授）。命令随即恢复正常，
   错误根本不会浮到模型面前。
2. **注解（卫生）**：如果 `SANDBOX_UNAVAILABLE` / `windows-acl-run: --temp` 仍然出现
   在工具结果里，`tools/post-execute` 会给结果追加一段指引，明确告诉模型：
   *这是后端基础设施故障，不是策略拒绝；不要用 sandbox_permissions 提权；守卫已重建
   temp 目录，请原样重试一次；仍失败则需要重开会话。*

## 安装

任选其一（版本以 DSH 0.1.7-rc.2 实测，安装机制来自官方 `dsh plugin`）：

```sh
# npm（发布后）
npx @deepseek-ai/dsh plugin --profile desktop add dsh-sandbox-temp-guard

# 本地 tarball（开发/内测）
pnpm pack                                   # 得到 dsh-sandbox-temp-guard-0.1.0.tgz
npx @deepseek-ai/dsh plugin --profile desktop remove dsh-sandbox-temp-guard   # 版本变化时先移除
npx @deepseek-ai/dsh plugin --profile desktop add ./dsh-sandbox-temp-guard-0.1.0.tgz
```

源码直载 overlay（插件零运行时依赖，可用此方式热加载）：

```yaml
# dev.patch.yml
- insert:
    - id: sandbox-temp-guard
      name: 'file:///C:/abs/path/to/dsh-sandbox-temp-guard/src/index.js'
      config:
        repairBeforeToolExecution: true
        sweepIntervalMs: 60000
        annotateBackendFailure: true
```

```sh
npx @deepseek-ai/dsh --profile dev --patch ./dev.patch.yml
```

## 配置（cordis.patch.yml）

| 键 | 默认 | 说明 |
|---|---|---|
| `repairBeforeToolExecution` | `true` | 每次工具执行前扫一遍并修复 |
| `sweepIntervalMs` | `60000` | 周期兜底扫描间隔，`0` 关闭 |
| `annotateBackendFailure` | `true` | 对后端失败结果追加排查指引 |

## 验证

```sh
node test/run-test.mjs     # 17 项离线断言：发现/重建/补授/容错/钩子接线/注解
```

## 设计约束与已知限制

- **零运行时依赖**（仅 node 内置模块），因此 tarball / npm / `file://` overlay
  三种安装方式都可用；`ctx.get('sandbox')` 为可选访问，缺失时安全降级。
- 对 provider 内部结构（`tempCapabilities`）的访问是**通用发现**（遍历对象图寻找
  Map 形态、条目含 `{ dir, grant.add }` 的缓存），上游改名时退化为 no-op 而不是崩溃。
  已在 DSH 0.1.7-rc.2 的 `dsh-sandbox-local` 上验证字段形状。
- 本插件是**上游修复落地前的过渡方案**；上游正确修法是在
  `materializeAclGrant()` 复用缓存前检查目录存在、缺失则重建并补授。
- 只处理 temp 目录被清理这一种故障；provider 完全不可用（如 ACL 后端崩溃）时，
  注解会提示重开会话，这是当前唯一恢复手段。

MIT License.

---

<a id="english"></a>

# dsh-sandbox-temp-guard (English)

A self-healing guard plugin for the DeepSeek Harness Windows ACL sandbox.

**The bug** ([upstream Discussion #8550](https://github.com/deepseek-ai/deepseek-harness/discussions/8550)):
`@deepseek-ai/dsh-sandbox-local` caches one private temp directory per
(session, workspace) — `%TEMP%\dsh-XXXXXX` plus a capability-SID ACL grant — for the
provider's lifetime and reuses the cached path unconditionally. Once OS temp cleanup
deletes that directory, every `confine()` passes a stale `--temp`, the
`windows-acl-run` runner refuses to start (`--temp is not an existing directory`,
exit 127), and the seam fails closed with `SANDBOX_UNAVAILABLE` — **every command in
that session then fails until DSH restarts**.

**The plugin**:

1. *Repair* — before every tool execution (plus a periodic sweep), locate the live
   sandbox provider's cached temp capabilities, recreate missing directories, and
   re-apply their capability ACEs. The failure never reaches the model.
2. *Annotate* — if a `SANDBOX_UNAVAILABLE` / `windows-acl-run: --temp` failure still
   lands in a tool result, append a remediation block: it is a **backend
   infrastructure failure, not a policy denial**; do **not** escalate with
   `sandbox_permissions`; retry once; restart the session if it persists.

**Install** (DSH ≥ 0.1.7-rc.2, verified on 0.1.7-rc.2):

```sh
npx @deepseek-ai/dsh plugin --profile desktop add dsh-sandbox-temp-guard   # npm
npx @deepseek-ai/dsh plugin --profile desktop add ./dsh-sandbox-temp-guard-0.1.0.tgz   # tarball
```

Source-overlay (`--patch`) install works too — the plugin has **zero runtime
dependencies** (node builtins only).

**Config** (`cordis.patch.yml`): `repairBeforeToolExecution` (true),
`sweepIntervalMs` (60000), `annotateBackendFailure` (true).

**Tests**: `node test/run-test.mjs` — 17 offline assertions covering discovery,
recreation, ACE re-grant, failure containment, hook wiring, annotation, and
missing-service degradation.

This is a stopgap until the framework fix lands (recreate-on-reuse inside
`materializeAclGrant`). MIT.

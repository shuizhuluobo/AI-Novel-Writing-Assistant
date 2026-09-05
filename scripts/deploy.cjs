#!/usr/bin/env node
/**
 * 本地部署与更新脚本。
 *
 * 目标：
 * - 从 git 拉最新代码时，不会把本地改过的默认端口冲掉。
 * - 任何可能动到数据库的步骤之前，先备份 SQLite 并校验备份文件。
 * - 任何一步失败都停下来，并打印可执行的回滚指引。
 *
 * 用法：
 *   node scripts/deploy.cjs status    查看分支、端口、服务与数据库状态
 *   node scripts/deploy.cjs start     启动后端 + 前端
 *   node scripts/deploy.cjs stop      停止后端 + 前端
 *   node scripts/deploy.cjs restart   重启后端 + 前端
 *   node scripts/deploy.cjs ports     只检查（并默认修复）端口配置
 *   node scripts/deploy.cjs update    拉最新代码并重新部署
 *
 * 常用参数：
 *   --no-fix-ports      端口被改回默认值时只报告，不自动修复
 *   --skip-install      跳过 pnpm install
 *   --skip-build        跳过构建（只拉代码 + 重启）
 *   --branch <name>     指定要更新的分支，默认用当前分支
 */

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const serverDir = path.join(repoRoot, "server");
const tmpDir = path.join(repoRoot, ".tmp");
const logDir = path.join(tmpDir, "deploy-logs");
const backupDir = path.join(serverDir, "tmp", "db-backups");
const DEFAULT_SERVER_PORT = 39001;
const DEFAULT_CLIENT_PORT = 39002;

function parseEnvFile(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) {
    return result;
  }

  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    result[line.slice(0, separatorIndex).trim()] = line.slice(separatorIndex + 1).trim();
  }

  return result;
}

function resolvePortEnv(name, fallback) {
  const fromProcess = Number(process.env[name]);
  if (Number.isInteger(fromProcess) && fromProcess > 0) {
    return fromProcess;
  }
  return fallback;
}

const serverEnv = parseEnvFile(path.join(serverDir, ".env"));
const clientEnv = parseEnvFile(path.join(repoRoot, "client", ".env"));

const SERVER_PORT = resolvePortEnv("PORT", Number(serverEnv.PORT) || DEFAULT_SERVER_PORT);
const CLIENT_PORT = resolvePortEnv("CLIENT_PORT", Number(clientEnv.CLIENT_PORT) || DEFAULT_CLIENT_PORT);

function readServerEnvPort() {
  return Number(serverEnv.PORT) || DEFAULT_SERVER_PORT;
}

function log(message) {
  console.log(`[deploy] ${message}`);
}

function warn(message) {
  console.warn(`[deploy] ${message}`);
}

function fail(message, hints = []) {
  console.error(`[deploy] ${message}`);
  for (const hint of hints) {
    console.error(`[deploy]   ${hint}`);
  }
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
    encoding: "utf8",
  });

  if (result.status !== 0 && !options.allowFailure) {
    fail(`命令执行失败：${command} ${args.join(" ")}`);
  }

  return result;
}

function capture(command, args, options = {}) {
  return run(command, args, { ...options, stdio: "pipe" }).stdout ?? "";
}

// ---------------------------------------------------------------------------
// 端口守卫：拉完代码后确保本地端口没被上游覆盖
// ---------------------------------------------------------------------------

const PORT_GUARDS = [
  {
    label: "后端端口常量 server/src/app.ts",
    file: "server/src/app.ts",
    regex: /const DEFAULT_SERVER_PORT = \d+/,
    expected: () => `const DEFAULT_SERVER_PORT = ${readServerEnvPort()}`,
  },
  {
    label: "前端代理端口 client/vite.config.ts",
    file: "client/vite.config.ts",
    regex: /const DEFAULT_SERVER_PORT = \d+/,
    expected: () => `const DEFAULT_SERVER_PORT = ${readServerEnvPort()}`,
  },
  {
    label: "前端默认端口 client/vite.config.ts",
    file: "client/vite.config.ts",
    regex: /const DEFAULT_CLIENT_PORT = \d+/,
    expected: () => `const DEFAULT_CLIENT_PORT = ${CLIENT_PORT}`,
  },
  {
    label: "前端兜底 API 端口 client/src/lib/constants.ts",
    file: "client/src/lib/constants.ts",
    regex: /const DEFAULT_SERVER_PORT = \d+/,
    expected: () => `const DEFAULT_SERVER_PORT = ${readServerEnvPort()}`,
  },
  {
    label: "等待脚本默认端口 scripts/wait-for-port.cjs",
    file: "scripts/wait-for-port.cjs",
    regex: /port: \d+,/,
    expected: () => `port: ${readServerEnvPort()},`,
  },
  {
    label: "示例环境变量端口 .env.example",
    file: ".env.example",
    regex: /^PORT=\d+$/m,
    expected: () => `PORT=${readServerEnvPort()}`,
  },
  {
    label: "示例前端 API 地址 .env.example",
    file: ".env.example",
    regex: /^VITE_API_BASE_URL=http:\/\/localhost:\d+\/api$/m,
    expected: () => `VITE_API_BASE_URL=http://localhost:${readServerEnvPort()}/api`,
  },
  {
    label: "示例 CORS 来源 .env.example",
    file: ".env.example",
    regex: /^CORS_ORIGIN=http:\/\/localhost:\d+$/m,
    expected: () => `CORS_ORIGIN=http://localhost:${CLIENT_PORT}`,
  },
];

function checkPorts({ fix }) {
  const drifted = [];

  for (const guard of PORT_GUARDS) {
    const filePath = path.join(repoRoot, guard.file);
    if (!fs.existsSync(filePath)) {
      warn(`跳过端口检查，文件不存在：${guard.file}`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf8");
    const expected = guard.expected();
    if (content.includes(expected)) {
      continue;
    }

    const match = content.match(guard.regex);
    if (!match) {
      warn(`端口检查未命中，可能需要人工确认：${guard.label}（期望 ${expected}）`);
      continue;
    }

    drifted.push({ guard, filePath, content, expected, current: match[0] });
  }

  if (drifted.length === 0) {
    log(`端口检查通过：后端 ${readServerEnvPort()}，前端 ${CLIENT_PORT}`);
    return;
  }

  for (const item of drifted) {
    warn(`端口被改动：${item.guard.label} 当前 ${item.current}，期望 ${item.expected}`);
  }

  if (!fix) {
    fail("端口配置与预期不一致（未自动修复）。", [
      "确认后重新执行 node scripts/deploy.cjs ports 自动修复。",
    ]);
  }

  for (const item of drifted) {
    fs.writeFileSync(item.filePath, item.content.replace(item.guard.regex, item.expected), "utf8");
    log(`已修复：${item.guard.label} -> ${item.expected}`);
  }
}

// ---------------------------------------------------------------------------
// 服务启停
// ---------------------------------------------------------------------------

function findPidByPort(port) {
  const ssResult = spawnSync("ss", ["-ltnp"], { encoding: "utf8" });
  if (ssResult.status === 0 && ssResult.stdout) {
    for (const line of ssResult.stdout.split("\n")) {
      if (!new RegExp(`:${port}\\s`).test(line)) {
        continue;
      }
      const pidMatch = line.match(/pid=(\d+)/);
      if (pidMatch) {
        return Number(pidMatch[1]);
      }
    }
  }

  // 兜底：直接扫进程命令行
  const patterns = port === SERVER_PORT ? ["dist/app.js"] : ["vite preview", "vite.js preview"];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      if (patterns.some((pattern) => cmdline.includes(pattern))) {
        return Number(entry);
      }
    } catch {
      // 进程已退出或无权读取，忽略。
    }
  }

  return null;
}

function isPortListening(port) {
  return findPidByPort(port) !== null;
}

function stopByPort(port, label) {
  const pid = findPidByPort(port);
  if (!pid) {
    log(`${label} 未在运行（端口 ${port}）`);
    return;
  }

  log(`停止 ${label}（端口 ${port}，pid ${pid}）`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!isPortListening(port)) {
      log(`${label} 已停止`);
      return;
    }
    spawnSync("sleep", ["0.5"]);
  }

  warn(`${label} 未响应 SIGTERM，强制结束`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 进程可能已经退出。
  }
}

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve(response.statusCode != null && response.statusCode < 500);
      });
      request.on("error", () => {
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(attempt, 800);
      });
      request.setTimeout(3000, () => {
        request.destroy();
      });
    };

    attempt();
  });
}

async function startService({ name, args, port, healthUrl, env }) {
  fs.mkdirSync(logDir, { recursive: true });
  const stdout = fs.openSync(path.join(logDir, `${name}.log`), "a");
  const stderr = fs.openSync(path.join(logDir, `${name}.err.log`), "a");

  const child = spawn("pnpm", args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", stdout, stderr],
  });
  child.unref();

  log(`启动 ${name}（pid ${child.pid}），日志 ${path.relative(repoRoot, path.join(logDir, `${name}.log`))}`);

  const healthy = await waitForHttp(healthUrl, 90_000);
  if (!healthy) {
    fail(`${name} 启动后健康检查未通过：${healthUrl}`, [
      `查看日志：tail -f ${path.join(logDir, `${name}.log`)}`,
    ]);
  }

  log(`${name} 已就绪：端口 ${port}`);
}

async function startAll() {
  if (isPortListening(SERVER_PORT)) {
    log(`后端已在运行（端口 ${SERVER_PORT}）`);
  } else {
    await startService({
      name: "api",
      args: ["--filter", "@ai-novel/server", "start"],
      port: SERVER_PORT,
      healthUrl: `http://127.0.0.1:${SERVER_PORT}/api/health`,
    });
  }

  if (isPortListening(CLIENT_PORT)) {
    log(`前端已在运行（端口 ${CLIENT_PORT}）`);
  } else {
    await startService({
      name: "web",
      args: ["--filter", "@ai-novel/client", "preview"],
      port: CLIENT_PORT,
      healthUrl: `http://127.0.0.1:${CLIENT_PORT}/`,
      env: { PORT: String(SERVER_PORT), CLIENT_PORT: String(CLIENT_PORT) },
    });
  }
}

function stopAll() {
  stopByPort(CLIENT_PORT, "前端");
  stopByPort(SERVER_PORT, "后端");
}

// ---------------------------------------------------------------------------
// 数据库备份
// ---------------------------------------------------------------------------

function resolveDatabasePath() {
  const rawUrl = serverEnv.DATABASE_URL || "file:./dev.db";
  if (!rawUrl.startsWith("file:")) {
    return null;
  }

  const relativePath = rawUrl.slice("file:".length) || "./dev.db";
  return path.isAbsolute(relativePath) ? relativePath : path.join(serverDir, relativePath);
}

function backupDatabase() {
  const databasePath = resolveDatabasePath();
  if (!databasePath || !fs.existsSync(databasePath)) {
    log("未找到 SQLite 数据库文件，跳过备份。");
    return null;
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const backupPath = path.join(backupDir, `dev_before_update_${stamp}.db`);
  const sourceSize = fs.statSync(databasePath).size;

  fs.copyFileSync(databasePath, backupPath);
  const backupSize = fs.statSync(backupPath).size;
  if (!fs.existsSync(backupPath) || backupSize < sourceSize) {
    fail("数据库备份校验失败，已中止。", [
      `源文件：${databasePath}（${sourceSize} 字节）`,
      `备份文件：${backupPath}（${backupSize} 字节）`,
    ]);
  }

  log(`数据库已备份：${backupPath}（${backupSize} 字节）`);
  return backupPath;
}

function isSqliteSchemaChanged() {
  const schemaPath = path.join(serverDir, "src", "prisma", "schema.sqlite.prisma");
  if (!fs.existsSync(schemaPath)) {
    return false;
  }

  const hashPath = path.join(tmpDir, "deploy-schema.hash");
  const currentHash = require("node:crypto")
    .createHash("sha256")
    .update(fs.readFileSync(schemaPath))
    .digest("hex");
  const previousHash = fs.existsSync(hashPath) ? fs.readFileSync(hashPath, "utf8").trim() : "";

  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(hashPath, currentHash, "utf8");
  return currentHash !== previousHash;
}

// ---------------------------------------------------------------------------
// 更新流程
// ---------------------------------------------------------------------------

function gitCapture(args) {
  return capture("git", args, { cwd: repoRoot }).trim();
}

function currentBranch() {
  return gitCapture(["rev-parse", "--abbrev-ref", "HEAD"]);
}

function hasTrackedChanges() {
  return gitCapture(["status", "--porcelain", "--untracked-files=no"]).length > 0;
}

function parseArgs(argv) {
  const options = {
    command: "status",
    fixPorts: true,
    skipInstall: false,
    skipBuild: false,
    branch: null,
  };

  const commands = new Set(["status", "start", "stop", "restart", "ports", "update"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (commands.has(arg)) {
      options.command = arg;
      continue;
    }
    if (arg === "--no-fix-ports") {
      options.fixPorts = false;
      continue;
    }
    if (arg === "--skip-install") {
      options.skipInstall = true;
      continue;
    }
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--branch" && argv[index + 1]) {
      options.branch = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

async function update(options) {
  const branch = options.branch ?? currentBranch();
  const oldHead = gitCapture(["rev-parse", "HEAD"]);

  log(`当前分支 ${branch}，HEAD ${oldHead.slice(0, 8)}`);

  const dirty = hasTrackedChanges();
  if (dirty) {
    // 只暂存已跟踪文件的改动（端口改动都在已跟踪文件里），不搬动你的临时文件。
    log("检测到未提交改动，先暂存（stash），更新完成后自动恢复。");
    run("git", ["stash", "push", "--message", `deploy-update-${Date.now()}`]);
  }

  const pulled = run("git", ["pull", "--rebase", "origin", branch], { allowFailure: true });
  if (pulled.status !== 0) {
    warn("拉取失败，正在中止 rebase 并恢复现场。");
    run("git", ["rebase", "--abort"], { allowFailure: true });
    if (dirty) {
      run("git", ["stash", "pop"], { allowFailure: true });
    }
    fail("代码更新失败：与上游改动冲突，需要人工处理。", [
      "手动执行 git pull --rebase 并解决冲突后，再重新运行本脚本。",
      "如需放弃本地改动：git rebase --abort && git reset --hard origin/" + branch,
    ]);
  }

  const newHead = gitCapture(["rev-parse", "HEAD"]);
  if (newHead === oldHead) {
    log("代码已是最新。");
  } else {
    log(`代码已更新：${oldHead.slice(0, 8)} -> ${newHead.slice(0, 8)}`);
  }

  // 先恢复本地改动，再做端口守卫，避免同一处改动被应用两次导致冲突。
  if (dirty) {
    const popped = run("git", ["stash", "pop"], { allowFailure: true });
    if (popped.status !== 0) {
      fail("本地改动恢复时冲突，已暂停后续步骤（未构建、未改动数据库）。", [
        "手动解决冲突：git status 查看冲突文件，解决后执行 git stash drop。",
      ]);
    }
    log("本地改动已恢复。");
  }

  checkPorts({ fix: options.fixPorts });

  const lockPath = path.join(repoRoot, "pnpm-lock.yaml");
  const lockHashPath = path.join(tmpDir, "deploy-lock.hash");
  const lockHash = fs.existsSync(lockPath)
    ? require("node:crypto").createHash("sha256").update(fs.readFileSync(lockPath)).digest("hex")
    : "";
  const previousLockHash = fs.existsSync(lockHashPath)
    ? fs.readFileSync(lockHashPath, "utf8").trim()
    : "";
  const nodeModulesExists = fs.existsSync(path.join(repoRoot, "node_modules"));

  if (options.skipInstall) {
    log("跳过依赖安装。");
  } else if (lockHash !== previousLockHash || !nodeModulesExists) {
    log("依赖有变化或尚未安装，执行 pnpm install...");
    run("pnpm", ["install"]);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(lockHashPath, lockHash, "utf8");
  } else {
    log("依赖无变化，跳过 pnpm install。");
  }

  const backupPath = backupDatabase();

  if (options.skipBuild) {
    log("跳过构建。");
  } else {
    log("开始构建...");
    run("pnpm", ["--filter", "@ai-novel/shared", "build"]);
    run("pnpm", ["--filter", "@ai-novel/server", "prisma:generate"]);
    run("pnpm", ["--filter", "@ai-novel/server", "build"]);
    run("pnpm", ["--filter", "@ai-novel/client", "build"]);
    log("构建完成。");
  }

  if (!options.skipBuild && isSqliteSchemaChanged()) {
    log("检测到 Prisma schema 变化，执行 prisma db push（已提前备份数据库）。");
    run("pnpm", ["--filter", "@ai-novel/server", "prisma:push"]);
  }

  log("重启服务...");
  stopAll();
  await startAll();

  log("更新完成。");
  log(`前端 http://localhost:${CLIENT_PORT} | 后端 http://localhost:${SERVER_PORT}`);
  if (backupPath) {
    log(`如需回滚数据库：cp ${backupPath} ${resolveDatabasePath()}`);
  }
  log(`如需回滚代码：git reset --hard ${oldHead}`);
}

async function showStatus() {
  const branch = currentBranch();
  const head = gitCapture(["rev-parse", "--short", "HEAD"]);
  const dirty = hasTrackedChanges();
  const databasePath = resolveDatabasePath();

  log(`分支 ${branch} @ ${head}${dirty ? "（有未提交改动）" : "（工作区干净）"}`);
  log(`端口：后端 ${SERVER_PORT}（${isPortListening(SERVER_PORT) ? "运行中" : "未运行"}），`
    + `前端 ${CLIENT_PORT}（${isPortListening(CLIENT_PORT) ? "运行中" : "未运行"}）`);
  log(`数据库：${databasePath}${databasePath && fs.existsSync(databasePath) ? `（${fs.statSync(databasePath).size} 字节）` : "（不存在）"}`);

  const backups = fs.existsSync(backupDir)
    ? fs.readdirSync(backupDir).filter((name) => name.endsWith(".db")).sort().slice(-3)
    : [];
  if (backups.length > 0) {
    log(`最近备份：${backups.join(", ")}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  switch (options.command) {
    case "status":
      await showStatus();
      break;
    case "ports":
      checkPorts({ fix: options.fixPorts });
      break;
    case "start":
      await startAll();
      break;
    case "stop":
      stopAll();
      break;
    case "restart":
      stopAll();
      await startAll();
      break;
    case "update":
      await update(options);
      break;
    default:
      fail(`未知命令：${options.command}`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

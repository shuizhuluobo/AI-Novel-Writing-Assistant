#!/usr/bin/env node
/**
 * 本地 Qdrant 管理（知识库 / 章节生成上下文检索用）。
 *
 * 不使用 Docker：直接下载官方静态二进制并后台运行。
 * 仅在 RAG_ENABLED 非 false 时才会真正启动（server/.env 里未设置则按代码默认值 true 处理）。
 *
 * 用法：
 *   node scripts/qdrant.cjs status   查看运行状态（端口 / 健康）
 *   node scripts/qdrant.cjs ensure   未运行就下载并启动（已运行则跳过）
 *   node scripts/qdrant.cjs start    强制下载并启动
 *   node scripts/qdrant.cjs stop     停止 Qdrant
 *
 * 环境变量：
 *   QDRANT_VERSION   二进制版本，默认 1.13.4
 *   QDRANT_PORT      监听端口，默认 6333
 *   QDRANT_URL       REST 地址，默认 http://127.0.0.1:6333
 */

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const tmpDir = path.join(repoRoot, ".tmp");
const qdrantDir = path.join(tmpDir, "qdrant");
const binPath = path.join(qdrantDir, "qdrant");
const logPath = path.join(qdrantDir, "qdrant.log");

const VERSION = process.env.QDRANT_VERSION || "1.9.1";
const PORT = Number(process.env.QDRANT_PORT || "6333");
const QDRANT_URL = (process.env.QDRANT_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");

function log(message) {
  console.log(`[qdrant] ${message}`);
}

function warn(message) {
  console.warn(`[qdrant] ${message}`);
}

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
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

const serverEnv = parseEnvFile(path.join(repoRoot, "server", ".env"));
const rawRagEnabled = serverEnv.RAG_ENABLED;
const ragEnabled = !rawRagEnabled || !["0", "false", "off", "no"].includes(rawRagEnabled.trim().toLowerCase());

function platformAsset() {
  const arch = process.arch; // x64 | arm64
  const platform = process.platform; // linux | darwin
  if (platform === "linux" && arch === "x64") return "qdrant-x86_64-unknown-linux-gnu.tar.gz";
  if (platform === "linux" && arch === "arm64") return "qdrant-aarch64-unknown-linux-gnu.tar.gz";
  if (platform === "darwin" && arch === "arm64") return "qdrant-aarch64-apple-darwin.tar.gz";
  if (platform === "darwin" && arch === "x64") return "qdrant-x86_64-apple-darwin.tar.gz";
  return null;
}

function findPidByPort(port) {
  const ss = spawnSync("ss", ["-ltnp"], { encoding: "utf8" });
  if (ss.status === 0 && ss.stdout) {
    for (const line of ss.stdout.split("\n")) {
      if (!new RegExp(`:${port}\\s`).test(line)) {
        continue;
      }
      const match = line.match(/pid=(\d+)/);
      if (match) {
        return Number(match[1]);
      }
    }
  }
  return null;
}

function qdrantHealthy() {
  return new Promise((resolve) => {
    const request = http.get(`${QDRANT_URL}/healthz`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(2000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      qdrantHealthy().then((ok) => {
        if (ok) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(attempt, 1000);
      });
    };
    attempt();
  });
}

function downloadBinary() {
  const asset = platformAsset();
  if (!asset) {
    warn("当前平台不支持自动下载 Qdrant 二进制（需 linux/darwin + x64/arm64）。");
    warn("请手动从 https://github.com/qdrant/qdrant/releases 下载并放到 " + binPath);
    process.exit(1);
  }

  fs.mkdirSync(qdrantDir, { recursive: true });
  const archivePath = path.join(qdrantDir, asset);
  const url = `https://github.com/qdrant/qdrant/releases/download/v${VERSION}/${asset}`;

  log(`下载 Qdrant v${VERSION}（${asset}）...`);
  const result = spawnSync("curl", ["-fSL", "--retry", "2", "-o", archivePath, url], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    warn("下载失败，请检查网络或手动下载后放到 " + binPath);
    process.exit(1);
  }

  log("解压中...");
  const extract = spawnSync("tar", ["-xzf", archivePath, "-C", qdrantDir], { stdio: "inherit" });
  if (extract.status !== 0) {
    warn("解压失败，请确认系统已安装 tar。");
    process.exit(1);
  }
  fs.rmSync(archivePath, { force: true });
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(path.join(qdrantDir, "version.txt"), VERSION, "utf8");

  // 若二进制与当前系统不兼容（如 glibc 版本过低），稍后启动会失败，这里直接校验一次。
  const probe = spawnSync(binPath, ["--version"], { stdio: "ignore" });
  if (probe.status !== 0) {
    warn("下载的 Qdrant 二进制在当前系统无法运行（可能 glibc 版本过低）。");
    warn("请手动下载兼容版本放到 " + binPath + "，或设置 QDRANT_VERSION 重试。");
    fs.rmSync(binPath, { force: true });
    process.exit(1);
  }

  log("Qdrant 二进制已就绪：" + binPath);
}

function start() {
  fs.mkdirSync(qdrantDir, { recursive: true });
  fs.mkdirSync(path.join(qdrantDir, "storage"), { recursive: true });
  const out = fs.openSync(logPath, "a");
  const child = spawn(binPath, [], {
    cwd: qdrantDir,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  log(`启动 Qdrant（pid ${child.pid}，存储 ${path.join(qdrantDir, "storage")}），日志 ${logPath}`);
}

function stop() {
  const pid = findPidByPort(PORT);
  if (!pid) {
    log("Qdrant 未在运行（端口 " + PORT + "）");
    return;
  }
  log("停止 Qdrant（端口 " + PORT + "，pid " + pid + "）");
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // 进程可能已退出
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!findPidByPort(PORT)) {
      log("Qdrant 已停止");
      return;
    }
    spawnSync("sleep", ["0.5"]);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 忽略
  }
}

async function ensure() {
  if (!ragEnabled) {
    log("RAG_ENABLED 为 false，跳过 Qdrant（如需启用，在 server/.env 设置 RAG_ENABLED=true）。");
    return;
  }
  if (await qdrantHealthy()) {
    log("Qdrant 已在运行：" + QDRANT_URL);
    return;
  }
  if (fs.existsSync(binPath)) {
    const marker = path.join(qdrantDir, "version.txt");
    const installed = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
    const runs = spawnSync(binPath, ["--version"], { stdio: "ignore" }).status === 0;
    if (installed !== VERSION || !runs) {
      log("现有 Qdrant 二进制需要更新，重新下载...");
      fs.rmSync(binPath, { force: true });
    }
  }
  if (!fs.existsSync(binPath)) {
    downloadBinary();
  }
  start();
  const ok = await waitForHealth(30_000);
  if (!ok) {
    warn("Qdrant 启动后健康检查未通过，日志尾部：");
    try {
      console.warn(fs.readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n"));
    } catch {
      // 忽略
    }
    process.exit(1);
  }
  log("Qdrant 已就绪：" + QDRANT_URL);
}

async function status() {
  const running = await qdrantHealthy();
  const pid = findPidByPort(PORT);
  if (!ragEnabled) {
    log("RAG_ENABLED=false，Qdrant 未启用（地址 " + QDRANT_URL + "）。");
    return;
  }
  log(`Qdrant 地址 ${QDRANT_URL}：${running ? "运行中" : "未运行"}${pid ? `（pid ${pid}）` : ""}`);
  log(`二进制：${fs.existsSync(binPath) ? binPath : "未下载"}`);
}

async function main() {
  const command = process.argv[2] || "ensure";
  switch (command) {
    case "status":
      await status();
      break;
    case "ensure":
      await ensure();
      break;
    case "start":
      if (!fs.existsSync(binPath)) {
        downloadBinary();
      }
      await (async () => {
        start();
        const ok = await waitForHealth(30_000);
        if (!ok) {
          warn("Qdrant 启动后健康检查未通过。");
          process.exit(1);
        }
        log("Qdrant 已就绪：" + QDRANT_URL);
      })();
      break;
    case "stop":
      stop();
      break;
    default:
      warn("未知命令：" + command + "（支持 status / ensure / start / stop）");
      process.exit(1);
  }
}

main().catch((error) => {
  warn(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

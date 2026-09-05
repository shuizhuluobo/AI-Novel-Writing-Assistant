import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

interface DesktopPackageJson {
  version?: unknown;
}

function clearStaleOptimizeCache(rootDir: string): void {
  const cacheDir = path.resolve(rootDir, "node_modules/.vite");
  const depsDir = path.join(cacheDir, "deps");
  const metadataPath = path.join(depsDir, "_metadata.json");
  if (!fs.existsSync(metadataPath)) {
    return;
  }

  try {
    const rawMetadata = fs.readFileSync(metadataPath, "utf8");
    const metadata = JSON.parse(rawMetadata) as {
      optimized?: Record<string, { src?: string }>;
    };
    const hasMissingSource = Object.values(metadata.optimized ?? {}).some((entry) => {
      if (!entry?.src) {
        return false;
      }
      const resolvedSource = path.resolve(depsDir, entry.src);
      return !fs.existsSync(resolvedSource);
    });
    if (!hasMissingSource) {
      return;
    }
  } catch {
    // Broken metadata should be treated the same as stale metadata.
  }

  fs.rmSync(cacheDir, { recursive: true, force: true });
  console.info("[vite] Cleared stale optimize cache because cached dependency sources no longer exist.");
}

// 默认端口刻意避开 3000 / 5173 这类常见开发端口：后端 API 39001，前端 39002。
const DEFAULT_SERVER_PORT = 39001;
const DEFAULT_CLIENT_PORT = 39002;

function resolveApiProxyTarget(): string {
  const configuredHost = process.env.HOST?.trim();
  const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
  const targetHost = configuredHost && !["0.0.0.0", "::"].includes(configuredHost)
    ? configuredHost
    : "127.0.0.1";
  return `http://${targetHost}:${port}`;
}

function resolveClientPort(): number {
  const parsed = Number(process.env.CLIENT_PORT ?? DEFAULT_CLIENT_PORT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CLIENT_PORT;
}

function resolveDesktopAppVersion(): string {
  const desktopPackagePath = path.resolve(__dirname, "../desktop/package.json");
  const packageJson = JSON.parse(fs.readFileSync(desktopPackagePath, "utf8")) as DesktopPackageJson;
  const version = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`desktop/package.json version must be stable semver like 0.3.19, got ${version || "(empty)"}.`);
  }
  return version;
}

clearStaleOptimizeCache(__dirname);

const isDesktopRelativeBaseBuild = process.env.AI_NOVEL_CLIENT_BASE === "relative";
const appVersion = resolveDesktopAppVersion();

export default defineConfig({
  base: isDesktopRelativeBaseBuild ? "./" : "/",
  plugins: [react()],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@ai-novel/shared": path.resolve(__dirname, "../shared"),
    },
  },
  build: {
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (id.includes("@assistant-ui") || id.includes("@langchain/langgraph-sdk")) {
            return "assistant-ui";
          }
          if (id.includes("platejs") || id.includes("@platejs")) {
            return "plate-editor";
          }
          return "vendor";
        },
      },
    },
  },
  server: {
    host: true,
    port: resolveClientPort(),
    strictPort: true,
    proxy: {
      "/api": {
        target: resolveApiProxyTarget(),
        changeOrigin: true,
      },
    },
  },
  preview: {
    // 部署 / 预览态同样把 /api 代理到后端，前端产物就不需要写死后端地址。
    host: true,
    port: resolveClientPort(),
    strictPort: true,
    proxy: {
      "/api": {
        target: resolveApiProxyTarget(),
        changeOrigin: true,
        ws: true,
      },
    },
  },
});

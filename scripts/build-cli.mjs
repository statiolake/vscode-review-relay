import { mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const allTargets = [
  ["darwin", "arm64"], ["darwin", "amd64"],
  ["linux", "arm64"], ["linux", "amd64"],
  ["windows", "arm64"], ["windows", "amd64"]
];
const nodePlatform = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
const nodeArch = { arm64: "arm64", x64: "amd64" }[process.arch];
const targets = process.argv.includes("--all") ? allTargets : [[nodePlatform, nodeArch]];

for (const [goos, goarch] of targets) {
  if (!goos || !goarch) throw new Error(`Unsupported build host: ${process.platform}-${process.arch}`);
  const directory = join("bin", `${goos}-${goarch}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const output = join(directory, goos === "windows" ? "review-relay.exe" : "review-relay");
  const result = spawnSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", output, "./cmd/review-relay"], {
    stdio: "inherit", env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" }
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

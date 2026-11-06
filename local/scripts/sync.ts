/**
 * 在本机把上游 master 合并进当前的本地化分支并安装依赖。
 *
 *   bun local/scripts/sync.ts                 # 合并 + 安装依赖
 *   bun local/scripts/sync.ts --install http://127.0.0.1:3000   # 另外把适配文件重新装进运行中的 Toonflow
 *
 * 冲突时停在合并状态，由你解决后提交；不会自动推送。
 */
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const upstream = "https://github.com/HBAI-Ltd/Toonflow-app.git";
const args = process.argv.slice(2);

function run(command: string[], allowFailure = false) {
  console.log(`$ ${command.join(" ")}`);
  const result = Bun.spawnSync(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0 && !allowFailure) process.exit(result.exitCode ?? 1);
  return result.exitCode === 0;
}

function output(command: string[]) {
  return Bun.spawnSync(command, { cwd: root }).stdout.toString().trim();
}

if (output(["git", "status", "--porcelain"])) {
  console.error("工作区有未提交的改动，请先提交或暂存");
  process.exit(1);
}
if (!output(["git", "remote"]).split("\n").includes("upstream")) run(["git", "remote", "add", "upstream", upstream]);
run(["git", "fetch", "upstream", "master"]);
if (!run(["git", "merge", "--no-edit", "upstream/master"], true)) {
  console.error("\n合并冲突。解决后 git add 并 git commit，再重新运行本脚本。上游文件的本地改动清单见 local/readme.md。");
  process.exit(1);
}
run(["bun", "install"]);
const install = args.indexOf("--install");
if (install >= 0) run(["bun", "local/scripts/install.ts", "--server", args[install + 1] ?? "http://127.0.0.1:3000"]);
console.log("\n同步完成，确认无误后 git push origin HEAD");

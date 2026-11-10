/**
 * 看一眼 main 的状态：默认分支、分支头、最近 CI、最新正式版。
 *
 *   node tools/status.mjs
 *
 * 只读：不动仓库、不发布。
 */
import { execFileSync } from "node:child_process";

const repo = "BangBang-03/dsh-memory-portrait";

function resolveToken() {
	if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
	const out = execFileSync("git", ["credential", "fill"], {
		input: "protocol=https\nhost=github.com\n\n",
		encoding: "utf8",
	});
	const match = /^password=(.+)$/mu.exec(out);
	if (match) return match[1].trim();
	throw new Error("拿不到 token：设置 GH_TOKEN，或在凭据管理器里存好 github.com 凭据");
}

const token = resolveToken();
async function api(apiPath) {
	const response = await fetch("https://api.github.com" + apiPath, {
		headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json", "user-agent": "dsh-memory-status" },
	});
	if (!response.ok) return null;
	return response.json();
}

const info = await api(`/repos/${repo}`);
if (!info) {
  console.error("读不到仓库信息（token 失效 / 限流 / 网络不通）");
  process.exit(1);
}
console.log("repo       " + repo + "   (默认分支 " + info.default_branch + ")");

const branches = (await api(`/repos/${repo}/branches?per_page=100`)) ?? [];
for (const branch of branches) {
	const ahead = branch.name === info.default_branch ? "  ← 默认" : "";
	console.log("branch     " + branch.name.padEnd(6) + " " + branch.commit.sha.slice(0, 8) + ahead);
}

const releases = (await api(`/repos/${repo}/releases?per_page=20`)) ?? [];
const stable = releases.find((release) => release.prerelease === false && release.draft !== true);
if (!stable) {
	console.log("stable     (还没有正式版)");
} else {
	console.log(
		"stable     " +
			stable.tag_name.padEnd(8) +
			" " +
			stable.published_at.slice(0, 19) +
			"  资产 " +
			stable.assets.map((asset) => asset.name).join(", "),
	);
}

const runs = (await api(`/repos/${repo}/actions/runs?per_page=6`)) ?? { workflow_runs: [] };
for (const run of runs.workflow_runs ?? []) {
	console.log(
		"ci         " +
			String(run.head_branch).padEnd(6) +
			" " +
			String(run.conclusion ?? run.status).padEnd(9) +
			" " +
			run.name +
			"  " +
			run.created_at.slice(0, 19) +
			"  " +
			run.html_url,
	);
}

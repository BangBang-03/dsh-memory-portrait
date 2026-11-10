/**
 * `git push` over the GitHub REST API —— 本机连不上 github.com:443，只通 api.github.com。
 *
 *   node tools/push.mjs                 # 推当前分支（推到同名远端分支）
 *   node tools/push.mjs --branch main   # 指名分支（得先 checkout 到它）
 *   node tools/push.mjs --dry           # 只报告要推哪些提交
 *
 * 推法：按本地提交逐个在远端重建 —— 只发这个提交改动过的 blob，在远端父提交的
 * base_tree 上拼出新 tree，**tree sha 与本地一致才建提交**（内容不等价就中止，不动 ref）。
 * 远端父提交必须与本地父提交内容一致（tree 比对），所以分叉时它会直接报错而不是强推。
 *
 * 输出里的 `base` 是远端旧头在本地的对应提交（tree 相同、SHA 可能不同），
 * 仅用于人工核对；main + v* 标签模型不再需要把 main 追到 base。
 *
 * 远端还没有这条分支时会新建。
 * token 取 GH_TOKEN 环境变量，否则读本机 git credential store 里 github.com 的凭据。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = "BangBang-03/dsh-memory-portrait";
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry");
const branchArg = (() => {
	const index = process.argv.indexOf("--branch");
	return index === -1 ? "" : process.argv[index + 1] ?? "";
})();

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
const git = (...args) => execFileSync("git", ["-C", here, ...args], { encoding: "utf8", maxBuffer: 1 << 26 }).trim();
const gitMayFail = (...args) => {
	try {
		return git(...args);
	} catch {
		return "";
	}
};

const escape = (value) =>
	JSON.stringify(value).replace(/[\u0080-\uffff]/gu, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));

async function api(method, apiPath, payload) {
	const response = await fetch("https://api.github.com" + apiPath, {
		method,
		headers: {
			authorization: "Bearer " + token,
			accept: "application/vnd.github+json",
			"content-type": "application/json",
			"user-agent": "dsh-memory-push",
		},
		body: payload === undefined ? undefined : Buffer.from(escape(payload), "utf8"),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(method + " " + apiPath + " -> " + response.status + " " + text.slice(0, 300));
	return text === "" ? null : JSON.parse(text);
}

const commitCache = new Map();
async function remoteCommit(sha) {
	if (commitCache.has(sha)) return commitCache.get(sha);
	const commit = await api("GET", `/repos/${repo}/git/commits/${sha}`);
	commitCache.set(sha, commit);
	return commit;
}

const treeOf = (commit) => (typeof commit.tree === "string" ? commit.tree : commit.tree.sha);

// 用 branch --show-current 而不是 rev-parse --abbrev-ref：后者在同名 tag 存在时
// 返回 "heads/lab" 这种带命名空间前缀的名字（tag lab 与分支 lab 共存是常态）。
const branch = branchArg || git("branch", "--show-current");
if (!branch) throw new Error("当前处于游离 HEAD，先 checkout 到分支再推");
if (/^(refs\/|heads\/|tags\/)/u.test(branch)) throw new Error("分支名看起来带命名空间前缀：" + branch + "（同名 tag 会干扰解析，用 --branch 明确指定）");
const localHead = git("rev-parse", "HEAD");

const remoteHeadRef = await api("GET", `/repos/${repo}/git/ref/heads/${branch}`).catch((error) => {
	if (String(error.message).includes("-> 404")) return null;
	throw error;
});
const remoteHead = remoteHeadRef?.object?.sha ?? "";

console.log("repo     " + repo);
console.log("branch   " + branch + "  (本地 " + localHead.slice(0, 9) + ", 远端 " + (remoteHead ? remoteHead.slice(0, 9) : "(新建)") + ")");

const parentsOf = (sha) => git("rev-list", "--parents", "-n", "1", sha).split(/\s+/u).slice(1);
const localTreeOf = (sha) => git("rev-parse", sha + "^{tree}");

/** 远端有没有这个提交（GET 404 = 没有）。 */
async function remoteHas(sha) {
	try {
		await remoteCommit(sha);
		return true;
	} catch (error) {
		if (String(error.message).includes("-> 404")) return false;
		throw error;
	}
}

/**
 * 从本地 HEAD 往回走，收集远端缺的提交（老到新）。
 *
 * 基点按**内容**认：API 建的提交时区被归一化，sha 与本地不同但 tree 相同，
 * 所以碰到「tree 等于远端头」的本地提交就停下 —— 它之后的才是要推的。
 */
async function collect() {
	const remoteHeadTree = remoteHead === "" ? "" : treeOf(await remoteCommit(remoteHead));
	const chain = [];
	let base = "";
	let cursor = localHead;
	while (true) {
		if (remoteHead !== "") {
			if (cursor === remoteHead) { base = cursor; break; }
			if (localTreeOf(cursor) === remoteHeadTree) { base = cursor; break; } // 内容基点：远端旧头的本地对应提交
		} else if (await remoteHas(cursor)) {
			break; // 新分支：远端已有这个提交
		}
		chain.push(cursor);
		const parents = parentsOf(cursor);
		if (parents.length === 0) {
			if (remoteHead !== "") throw new Error("远端分叉：找不到与远端头内容一致的本地提交，先 node tools/sync.mjs");
			break; // 根提交：从零建历史
		}
		if (parents.length > 1) throw new Error("合并提交暂不支持直推，请先转成线性历史：" + cursor.slice(0, 9));
		cursor = parents[0];
		if (chain.length > 100) throw new Error("提交链过长（>100），先 node tools/sync.mjs 对齐");
	}
	chain.reverse();
	return { chain, base };
}

const { chain, base } = await collect();
if (base) console.log("base     " + base.slice(0, 9) + " " + git("log", "-1", "--format=%s", base));
if (chain.length === 0) {
	/*
	 * 新分支但提交已经在远端（例如从 main 切出来、还没提交就要先建远端的同名分支）：
	 * collect 看到 remoteHas(localHead) 就停下，chain 为空——这不等于「已同步」，
	 * 分支引用还不存在。补建 ref，否则 push 报告 synced 却什么都没做。
	 */
	if (!remoteHead && (await remoteHas(localHead))) {
		console.log("synced   no");
		console.log("待建分支  " + branch + " -> " + localHead.slice(0, 9));
		if (DRY) {
			console.log("dry run —— 没有改动远端");
			process.exit(0);
		}
		await api("POST", `/repos/${repo}/git/refs`, { ref: "refs/heads/" + branch, sha: localHead });
		const created = await api("GET", `/repos/${repo}/git/ref/heads/${branch}`);
		console.log("verify   ref " + (created?.object?.sha === localHead ? "ok" : "MISMATCH") + " / " + String(created?.object?.sha || "").slice(0, 9));
		process.exit(0);
	}
	console.log("synced   yes");
	console.log("已经同步，没有要推的提交");
	process.exit(0);
}
console.log("synced   no");
console.log("待推提交  " + chain.length + " 个：");
for (const sha of chain) console.log("  " + sha.slice(0, 9) + " " + git("log", "-1", "--format=%s", sha));
if (DRY) {
	console.log("dry run —— 没有改动远端");
	process.exit(0);
}

let remoteParentSha = remoteHead;
// 新分支：基点是本地父提交（collect 已确认它在远端），远端第一条提交就接在它后面
if (!remoteParentSha && chain.length > 0) remoteParentSha = parentsOf(chain[0])[0] ?? "";
let moved = false;

for (const sha of chain) {
	const message = git("log", "-1", "--format=%B", sha);
	const localTree = git("rev-parse", sha + "^{tree}");
	const localParents = git("rev-list", "--parents", "-n", "1", sha).split(/\s+/u).slice(1);
	const localParent = localParents[0] ?? "";

	// 基线：远端父提交的 tree 必须与本地父提交一致，否则内容不等价，不推
	let baseTree;
	if (remoteParentSha) {
		const parentCommit = await remoteCommit(remoteParentSha);
		baseTree = treeOf(parentCommit);
		if (localParent) {
			const localParentTree = git("rev-parse", localParent + "^{tree}");
			if (baseTree !== localParentTree) {
				throw new Error(
					"远端与本地父提交内容不一致：remote tree=" + baseTree + " local tree=" + localParentTree + " —— 先 node tools/sync.mjs，不推",
				);
			}
		}
	}

	// 改了哪些文件 → 只发这些 blob
	const changes = localParent
		? git("diff-tree", "-r", "--no-commit-id", "--name-status", localParent, sha)
				.split(/\r?\n/u)
				.filter(Boolean)
				.map((line) => {
					const [status, ...rest] = line.split("\t");
					return { status: status[0], file: rest.join("\t") };
				})
		: git("ls-tree", "-r", sha)
				.split(/\r?\n/u)
				.filter(Boolean)
				.map((line) => ({ status: "A", file: line.split("\t")[1] }));

	const entries = [];
	for (const change of changes) {
		if (change.status === "D") {
			entries.push({ path: change.file, mode: "100644", type: "blob", sha: null });
			continue;
		}
		const line = git("ls-tree", sha, "--", change.file);
		const match = /^(\d{6}) blob ([0-9a-f]{40})\t/u.exec(line);
		if (!match) throw new Error("取不到 " + change.file + " 的 blob（子模块？）");
		const [, mode, blobSha] = match;
		// 只发改动过的 blob；远端按内容寻址，同一个 blob 重复上传是幂等的
		const bytes = execFileSync("git", ["-C", here, "cat-file", "blob", blobSha], { maxBuffer: 1 << 26 });
		const created = await api("POST", `/repos/${repo}/git/blobs`, {
			content: bytes.toString("base64"),
			encoding: "base64",
		});
		if (created.sha !== blobSha) throw new Error("blob 字节不一致，中止：" + change.file);
		entries.push({ path: change.file, mode, type: "blob", sha: blobSha });
	}

	const tree = await api("POST", `/repos/${repo}/git/trees`, { base_tree: baseTree, tree: entries });
	if (tree.sha !== localTree) {
		throw new Error("tree 不一致：remote=" + tree.sha + " local=" + localTree + " —— 中止，不移动 ref");
	}

	// 身份按本地提交原样搬过去（时区被 API 归一化，sha 可能不同，内容等价即可）
	const raw = execFileSync("git", ["-C", here, "cat-file", "commit", sha], { encoding: "utf8", maxBuffer: 1 << 26 });
	const identity = (key) => {
		const match = new RegExp("^" + key + " (.+?) <([^>]*)> (\\d+) ([+-]\\d{4})$", "mu").exec(raw);
		if (!match) throw new Error("解析不到 " + key + " 行：" + sha.slice(0, 9));
		return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
	};
	const author = identity("author");
	const committer = identity("committer");

	const created = await api("POST", `/repos/${repo}/git/commits`, {
		message,
		tree: tree.sha,
		parents: remoteParentSha ? [remoteParentSha] : [],
		author,
		committer,
	});
	if (created.sha !== sha) {
		console.log(
			"note     " + sha.slice(0, 9) + " -> " + created.sha.slice(0, 9) + "（内容等价、sha 不同：GitHub 把提交时区归一化成 UTC）",
		);
	}
	remoteParentSha = created.sha;
	moved = true;
	console.log("commit   " + created.sha.slice(0, 9) + " " + message.split("\n")[0]);
}

if (!moved) {
	console.log("没有可推的提交");
	process.exit(0);
}

if (remoteHead) {
	await api("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: remoteParentSha, force: false });
} else {
	await api("POST", `/repos/${repo}/git/refs`, { ref: "refs/heads/" + branch, sha: remoteParentSha });
}

// 读回校验
const after = await api("GET", `/repos/${repo}/git/ref/heads/${branch}`);
const commitAfter = await remoteCommit(after.object.sha);
const localTree = git("rev-parse", "HEAD^{tree}");
console.log(
	"verify   tree " +
		(treeOf(commitAfter) === localTree ? "ok" : "MISMATCH " + treeOf(commitAfter)) +
		" / message " +
		(String(commitAfter.message).trim() === git("log", "-1", "--format=%B").trim() ? "ok" : "MISMATCH") +
		" / ref " +
		after.object.sha.slice(0, 9),
);
console.log("url      https://github.com/" + repo + "/tree/" + branch);

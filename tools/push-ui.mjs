// 博客管理台:本地起一个只监听 127.0.0.1 的控制页面。
// 功能:笔记管理(新建/删除/发布) + git 变更预览 -> 二次确认 -> add/commit/push
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { readdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = path.join(ROOT, "src/content/posts");
const PORT = 4399;

const VSCODE_CANDIDATES = [
	process.env.VSCODE_BIN,
	process.env.CODE_BIN,
	"F:\\Microsoft VS Code\\Code.exe",
	"D:\\Microsoft VS Code\\Code.exe",
	"C:\\Program Files\\Microsoft VS Code\\Code.exe",
	"C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe",
].filter(Boolean);

async function findVsCode() {
	for (const candidate of VSCODE_CANDIDATES) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// try the next known installation path
		}
	}
	return "";
}

const run = (args) =>
	new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
			(err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ""}${stderr || ""}`.trim() }),
		);
	});

const lines = (r) => (r.out ? r.out.split("\n").filter(Boolean) : []);

/* --------------------------- 笔记管理 API --------------------------- */

const safePostPath = (file) => {
	const resolved = path.resolve(POSTS_DIR, file);
	if (!resolved.startsWith(POSTS_DIR + path.sep)) throw new Error("非法路径");
	return resolved;
};

const fmPick = (text, key) => {
	const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const m = fm?.[1].match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
	return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "";
};

async function listPosts() {
	const files = (await readdir(POSTS_DIR)).filter((f) => f.endsWith(".md"));
	const remoteR = await run(["remote", "get-url", "origin"]);
	const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])).out.trim() || "main";
	const repoBase = remoteR.ok ? remoteR.out.trim().replace(/\.git$/, "") : "";
	return Promise.all(
		files.map(async (f) => {
			const text = await readFile(path.join(POSTS_DIR, f), "utf8");
			const inRemote = repoBase
				? (await run(["cat-file", "-e", `origin/main:src/content/posts/${f}`])).ok
				: false;
			return {
				file: f,
				title: fmPick(text, "title") || f,
				published: fmPick(text, "published"),
				tags: fmPick(text, "tags"),
				draft: fmPick(text, "draft").includes("true"),
				githubUrl: repoBase ? `${repoBase}/blob/${branch}/src/content/posts/${encodeURIComponent(f)}` : null,
				inRemote,
			};
		}),
	);
}

async function createPost(filename, title) {
	let name = String(filename || "").replace(/[^a-zA-Z0-9-_]/g, "");
	if (!name) name = `post-${Date.now()}`;
	const full = safePostPath(`${name}.md`);
	await writeFile(
		full,
		`---\ntitle: ${String(title || name).replace(/["']/g, "")}\npublished: ${new Date().toISOString().slice(0, 10)}\ndescription: ''\nimage: ''\ntags: []\ncategory: ''\ndraft: true\nlang: ''\n---\n\n<!-- 新笔记已设为草稿,写完后点"发布"上线 -->\n\n## \n`,
		{ flag: "wx" },
	);
	return { file: `${name}.md` };
}

async function deletePost(file) {
	const full = safePostPath(file);
	await rm(full);
	return { file };
}

async function setDraft(file, draft) {
	const full = safePostPath(file);
	const text = await readFile(full, "utf8");
	if (!/^draft:[ \t]*.*$/m.test(text)) throw new Error("front-matter 缺少 draft 字段");
	await writeFile(full, text.replace(/^draft:[ \t]*.*$/m, `draft: ${draft}`));
	return { file, draft };
}

/* --------------------------- git 状态 API --------------------------- */

async function getStatus() {
	const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
	const remoteR = await run(["remote", "get-url", "origin"]);
	const hasRemote = remoteR.ok;
	const remote = hasRemote ? remoteR.out.trim() : "";

	let ahead = 0;
	let behind = 0;
	if (hasRemote) {
		const ab = await run(["rev-list", "--left-right", "--count", "origin/main...HEAD"]);
		if (ab.ok) {
			const [b, a] = ab.out.trim().split(/\s+/).map(Number);
			behind = b || 0;
			ahead = a || 0;
		}
	}

	const porcelain = await run(["status", "--porcelain"]);
	const uncommitted = lines(porcelain).map((l) => {
		const m = l.match(/^\s*(\S+)\s+(.*)$/);
		return m ? { status: m[1], file: m[2] } : { status: "?", file: l.trim() };
	});

	const range = hasRemote ? "origin/main..HEAD" : "HEAD";
	const unpushed = lines(await run(["log", range, "--oneline", "-20"]));
	const recent = lines(await run(["log", "--oneline", "-5"]));

	return { branch, hasRemote, remote, ahead, behind, uncommitted, unpushed, recent, root: ROOT };
}

async function doCleanPush(message) {
	const checkRemote = await run(["remote", "get-url", "origin"]);
	if (!checkRemote.ok) {
		return {
			ok: false,
			log: "✗ 未配置远程仓库。先执行一次:\n  gh repo create jackchene.github.io --public --source . --push",
		};
	}

	// 工作区变更全部入 index
	if (Boolean((await run(["status", "--porcelain"])).out.trim())) {
		const add = await run(["add", "-A"]);
		if (!add.ok) return { ok: false, log: `git add 失败:\n${add.out}` };
	}

	// 首次推送时远程还没有 main,以本地 HEAD 作为基准;后续推送使用 origin/main
	const remoteBase = await run(["rev-parse", "--verify", "origin/main"]);
	const hasRemoteBase = remoteBase.ok;
	const base = hasRemoteBase ? "origin/main" : "HEAD";
	const diffArgs = hasRemoteBase
		? ["diff", "--name-status", base]
		: ["diff", "--cached", "--name-status", "HEAD"];
	const diff = await run(diffArgs);
	if (!diff.ok) {
		return { ok: false, log: "无法读取远程基准,请检查 GitHub 连接后重试。" };
	}
	if (!diff.out.trim()) {
		return { ok: true, log: "没有需要推送的内容。" };
	}


	// 从差异里只挑出文章的新增/删除动作,用于生成提交信息
	const added = [];
	const removed = [];
	for (const l of diff.out.split("\n").filter(Boolean)) {
		const parts = l.split("\t");
		const status = parts[0][0];
		const file = parts[parts.length - 1];
		if (file.startsWith("src/content/posts/") && file.endsWith(".md")) {
			if (status === "A") added.push(file);
			if (status === "D") removed.push(file);
		}
	}

	let msg = (message || "").trim();
	if (!msg) {
		const parts = [];
		if (added.length) {
			const titles = await Promise.all(
				added.map(async (f) => {
					try {
						const text = await readFile(path.join(POSTS_DIR, path.basename(f)), "utf8");
						return fmPick(text, "title") || path.basename(f, ".md");
					} catch {
						return path.basename(f, ".md");
					}
				}),
			);
			parts.push(`新增 ${titles.map((t) => `《${t}》`).join("")}`);
		}
		if (removed.length) {
			parts.push(`删除 ${removed.map((f) => `《${path.basename(f, ".md")}》`).join("")}`);
		}
		msg = parts.length ? `post: ${parts.join("; ")}` : "update: 博客更新";
	}

	// 干净推送:把 base 之后的一切合并为一个提交
	if (hasRemoteBase) {
		const reset = await run(["reset", "--soft", base]);
		if (!reset.ok) return { ok: false, log: `git reset 失败:\n${reset.out}` };
	}
	const commit = await run(["commit", "-m", msg]);
	if (!commit.ok) return { ok: false, log: `git commit 失败:\n${commit.out}` };

	const logs = [`已合并为 1 个提交: ${msg}`];
	const pushArgs = hasRemoteBase ? ["push"] : ["push", "-u", "origin", "main"];
	const push = await run(pushArgs);
	logs.push("$ git push", push.out);
	logs.push(push.ok ? "✓ 推送完成" : "✗ 推送失败,请检查上方输出");
	return { ok: push.ok, log: logs.join("\n") };
}

/* ------------------------------ 页面 ------------------------------ */

function esc(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const PAGE = `<!doctype html>
<html lang="zh_CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>博客管理台</title>
<script>
	// 嵌入检测:iframe 内 或 URL 显式 ?embed=1 都视为紧凑模式,首屏同步打 class 避免闪烁
	(function(){
		try {
			var inFrame = window.self !== window.top;
			var forced = /[?&]embed=1\\b/.test(location.search);
			if (inFrame || forced) document.documentElement.classList.add('embed');
		} catch (e) { /* 同源限制下走 fallback */ }
	})();
</script>
<style>
	:root {
		--primary: #7c76e8;
		--primary-soft: #ecebff;
		--primary-hover: #6c66d8;
		--bg: #f6f7f9;
		--card: #ffffff;
		--text: #374151;
		--text-soft: #6b7280;
		--muted: #9ca3af;
		--line: #f0f1f4;
		--line-strong: #e5e7eb;
		--warn: #d97a00;
		--warn-soft: #fff4e0;
		--ok: #2e9c6e;
		--ok-soft: #e5f6ee;
		--danger: #e05555;
		--danger-soft: #fdecec;
		--shadow-card: 0 1px 2px rgba(20,22,40,.04), 0 4px 14px rgba(20,22,40,.04);
		--shadow-pop: 0 12px 36px rgba(20,22,40,.14);
		--radius: 14px;
		--t-fast: .14s ease;
		--t-med: .22s cubic-bezier(.2,.8,.2,1);
	}
	* { box-sizing: border-box; margin: 0; }
	html, body { height: 100%; }
	body {
		font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
		background: var(--bg);
		color: var(--text);
		min-height: 100vh;
		padding: 40px 16px 64px;
		-webkit-font-smoothing: antialiased;
		font-feature-settings: "tnum";
		line-height: 1.5;
	}
	.wrap { max-width: 760px; margin: 0 auto; }

	h1 { font-size: 1.45rem; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 4px; }
	.sub { color: var(--text-soft); font-size: .82rem; margin-bottom: 22px; word-break: break-all; }

	/* --- 卡片 --- */
	.card {
		background: var(--card);
		border-radius: var(--radius);
		padding: 18px 22px;
		box-shadow: var(--shadow-card);
		margin-bottom: 14px;
		border: 1px solid rgba(20,22,40,.03);
	}
	.card h2 {
		font-size: .8rem;
		font-weight: 600;
		letter-spacing: .04em;
		text-transform: uppercase;
		margin-bottom: 14px;
		color: var(--primary);
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}
	.card h2 .btn { text-transform: none; letter-spacing: 0; }

	/* --- 顶部提示条(看博客入口) --- */
	.hint-row {
		display: inline-flex; align-items: center; gap: 6px;
		padding: 5px 11px 5px 12px;
		background: var(--primary-soft);
		color: var(--primary);
		border-radius: 999px;
		font-size: .78rem; font-weight: 500;
		margin: -4px 0 12px;
		line-height: 1.4;
		transition: background var(--t-fast), color var(--t-fast);
	}
	.hint-row a { color: inherit; text-decoration: none; border-bottom: 1px dashed currentColor; padding-bottom: 1px; }
	.hint-row a:hover { color: var(--primary-hover); border-bottom-style: solid; }
	.hint-row .hint-label { opacity: .8; font-weight: 500; }
	html.embed .hint-row { display: none; }

	.kv { display: flex; gap: 6px 14px; font-size: .88rem; line-height: 1.9; flex-wrap: wrap; align-items: center; }
	.kv-row { display: inline-flex; align-items: center; gap: 6px; }
	.kv b { color: var(--text-soft); font-weight: 500; font-size: .78rem; }
	.file-row .file-name { color: var(--text); }

	.pill {
		display: inline-flex; align-items: center; gap: 5px;
		padding: 1px 9px; border-radius: 999px;
		font-size: .74rem; font-weight: 500;
		background: var(--primary-soft); color: var(--primary);
		line-height: 1.7;
	}
	.pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .85; }
	.pill.draft { background: var(--warn-soft); color: var(--warn); }
	.pill.live { background: var(--ok-soft); color: var(--ok); }
	.pill.neutral { background: #eef0f3; color: var(--text-soft); }
	.pill.neutral::before { display: none; }

	.file-row { display: flex; gap: 10px; font-size: .85rem; line-height: 1.95; font-family: "JetBrains Mono", Consolas, "Courier New", monospace; align-items: baseline; }
	.file-row .st { color: var(--primary); min-width: 16px; font-weight: 700; }
	.commit-row { font-size: .84rem; line-height: 1.85; padding: 2px 0; font-family: "JetBrains Mono", Consolas, monospace; color: var(--text); }
	.commit-row + .commit-row { border-top: 1px dashed var(--line); margin-top: 2px; padding-top: 6px; }

	.mono { font-family: "JetBrains Mono", Consolas, monospace; }
	.muted { color: var(--text-soft); }

	/* --- 按钮 --- */
	.btn {
		border: 0; border-radius: 9px;
		padding: 7px 13px; font-size: .84rem; font-weight: 600;
		color: #fff; background: var(--primary);
		cursor: pointer;
		transition: background var(--t-fast), transform var(--t-fast), box-shadow var(--t-fast), opacity var(--t-fast), color var(--t-fast);
		letter-spacing: .01em;
	}
	.btn:hover { background: var(--primary-hover); }
	.btn:active { transform: translateY(1px) scale(.99); }
	.btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
	.btn:disabled { background: #d6d8e0; color: #fff; cursor: not-allowed; box-shadow: none; }
	.btn:disabled:hover { background: #d6d8e0; }

	.btn.ghost { background: #fff; color: var(--text); box-shadow: inset 0 0 0 1px var(--line-strong); }
	.btn.ghost:hover { background: #fafbfc; color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary-soft); }
	.btn.ghost:active { background: var(--primary-soft); }

	.btn.danger { background: #fff; color: var(--text-soft); box-shadow: inset 0 0 0 1px var(--line-strong); }
	.btn.danger:hover { background: var(--danger); color: #fff; box-shadow: 0 4px 10px rgba(224,85,85,.25); }

	.btn.big {
		display: block; width: 100%;
		padding: 14px; font-size: .98rem; border-radius: 12px;
		box-shadow: 0 6px 18px rgba(124,118,232,.32);
		letter-spacing: .02em;
	}
	.btn.big:hover { box-shadow: 0 8px 22px rgba(124,118,232,.42); }

	.btn-icon {
		display: inline-flex; align-items: center; justify-content: center;
		width: 26px; height: 26px; padding: 0; border-radius: 8px;
		font-size: .85rem; line-height: 1;
	}

	/* --- 文章行 --- */
	.post-row {
		display: flex; align-items: center; gap: 10px;
		padding: 10px 10px; margin: 0 -10px;
		border-bottom: 1px solid var(--line);
		font-size: .88rem;
		border-radius: 8px;
		transition: background var(--t-fast);
	}
	.post-row:last-child { border-bottom: 0; }
	.post-row:hover { background: #fafbfd; }
	.post-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-weight: 500; }
	.post-row:hover .post-title { color: #1f2937; }
	.post-date { color: var(--muted); font-size: .76rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
	.post-actions { display: flex; gap: 6px; flex-shrink: 0; }

	/* --- 加载 / 空状态 --- */
	.skeleton-row {
		display: flex; align-items: center; gap: 10px; padding: 10px 0;
	}
	.skeleton-row + .skeleton-row { border-top: 1px solid var(--line); }
	.sk {
		background: linear-gradient(90deg, #eef0f3 0%, #f6f7f9 50%, #eef0f3 100%);
		background-size: 200% 100%;
		animation: sk-shimmer 1.2s linear infinite;
		border-radius: 6px;
		height: 14px;
	}
	.sk.w-title { flex: 1; height: 14px; }
	.sk.w-date { width: 72px; }
	.sk.w-pill { width: 56px; height: 18px; border-radius: 999px; }
	@keyframes sk-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

	.empty {
		display: flex; flex-direction: column; align-items: center; justify-content: center;
		padding: 22px 12px; color: var(--text-soft);
		font-size: .86rem; text-align: center; gap: 4px;
	}
	.empty .empty-ico {
		width: 32px; height: 32px; border-radius: 50%;
		background: var(--primary-soft); color: var(--primary);
		display: flex; align-items: center; justify-content: center;
		font-size: 1rem; margin-bottom: 4px;
	}

	/* --- 弹窗 --- */
	.overlay {
		position: fixed; inset: 0;
		background: rgba(20,22,40,.42);
		backdrop-filter: blur(4px);
		display: flex; align-items: center; justify-content: center;
		padding: 16px; z-index: 50;
		opacity: 0; pointer-events: none;
		transition: opacity var(--t-med);
	}
	.overlay.show { opacity: 1; pointer-events: auto; }
	.modal {
		background: #fff; border-radius: 16px; padding: 26px;
		width: 100%; max-width: 480px;
		box-shadow: var(--shadow-pop);
		transform: scale(.96) translateY(6px);
		opacity: 0;
		transition: transform var(--t-med), opacity var(--t-med);
	}
	.overlay.show .modal { transform: scale(1) translateY(0); opacity: 1; }
	.modal h3 { font-size: 1.05rem; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 14px; }
	.summary { background: #f8f9fb; border-radius: 10px; padding: 13px 15px; font-size: .86rem; line-height: 1.85; margin-bottom: 14px; color: var(--text); border: 1px solid var(--line); }
	.summary .mono { color: var(--primary); }

	input[type=text] {
		width: 100%; border: 1px solid var(--line-strong);
		border-radius: 9px; padding: 10px 13px;
		font-size: .9rem; margin-bottom: 12px;
		outline: none;
		font-family: inherit; color: var(--text);
		background: #fff;
		transition: border-color var(--t-fast), box-shadow var(--t-fast);
	}
	input[type=text]:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
	input[type=text]::placeholder { color: var(--muted); }

	.field-label { font-size: .78rem; color: var(--text-soft); margin-bottom: 5px; display: block; font-weight: 500; }
	.row { display: flex; gap: 10px; }
	.row .btn { flex: 1; }

	pre.term {
		background: #1e1e2a; color: #cdd6f4;
		border-radius: 12px; padding: 16px 18px;
		font-size: .8rem; line-height: 1.7;
		white-space: pre-wrap; word-break: break-all;
		max-height: 320px; overflow: auto;
		display: none;
		font-family: "JetBrains Mono", Consolas, monospace;
		box-shadow: inset 0 0 0 1px rgba(255,255,255,.04);
	}
	.ok-flag { color: #6fd7a3; font-weight: 700; }
	.fail-flag { color: #ff8a8a; font-weight: 700; }

	/* --- Toast --- */
	.toast {
		position: fixed; bottom: 28px; left: 50%;
		background: #1e1e2a; color: #fff;
		padding: 10px 20px; border-radius: 999px;
		font-size: .85rem; font-weight: 500;
		z-index: 60;
		box-shadow: 0 10px 28px rgba(0,0,0,.25);
		opacity: 0; pointer-events: none;
		transform: translate(-50%, 14px);
		transition: opacity var(--t-med), transform var(--t-med);
		max-width: 86vw;
	}
	.toast.show { opacity: 1; transform: translate(-50%, 0); }

	/* --- 头部单行小标识(嵌入态隐藏) --- */
	.page-head { margin-bottom: 22px; }
	.page-head h1 { display: flex; align-items: center; gap: 10px; }
	.page-head h1::before {
		content: ""; width: 8px; height: 8px; border-radius: 50%;
		background: var(--primary);
		box-shadow: 0 0 0 4px var(--primary-soft);
	}

	/* =============================
	   嵌入模式:紧凑布局,融入宿主
	   ============================= */
	html.embed, html.embed body { background: transparent; }
	html.embed body { padding: 6px 4px 10px; }
	html.embed .wrap { max-width: none; }
	html.embed .page-head { display: none; }
	html.embed .card {
		padding: 12px 14px;
		margin-bottom: 8px;
		border-radius: 10px;
		box-shadow: 0 1px 2px rgba(20,22,40,.04);
	}
	html.embed .card h2 { margin-bottom: 8px; font-size: .72rem; }
	html.embed .card h2 .btn { padding: 4px 9px; font-size: .78rem; border-radius: 7px; }
	html.embed .kv { font-size: .82rem; line-height: 1.7; }
	html.embed .file-row { font-size: .8rem; line-height: 1.75; }
	html.embed .commit-row { font-size: .8rem; line-height: 1.7; }
	html.embed .post-row { padding: 6px 8px; margin: 0 -8px; font-size: .84rem; }
	html.embed .post-date { font-size: .72rem; }
	html.embed .post-actions .btn { padding: 4px 8px; font-size: .76rem; }
	html.embed .btn.big { padding: 10px; font-size: .92rem; border-radius: 10px; }
	html.embed pre.term { padding: 12px; font-size: .76rem; max-height: 240px; border-radius: 10px; }
	html.embed .toast { bottom: 12px; font-size: .8rem; padding: 8px 16px; }
	html.embed .modal { padding: 22px; max-width: 420px; }

	@media (prefers-reduced-motion: reduce) {
		*, *::before, *::after {
			animation-duration: 0s !important;
			transition-duration: 0s !important;
		}
	}
</style>
</head>
<body>
<div class="wrap">
	<div class="page-head">
		<h1>博客管理台</h1>
		<div class="sub mono" id="root-path"></div>
	</div>

	<div class="card">
		<div class="hint-row"><span class="hint-label">看博客:</span><a href="http://localhost:4321/" target="_blank" rel="noopener">localhost:4321 ↗</a></div>
		<h2><span>笔记管理</span> <span style="display:flex;gap:8px"><button class="btn" onclick="openCreate()">+ 新建笔记</button></span></h2>
		<div id="posts"><div class="skeleton-row"><div class="sk w-pill"></div><div class="sk w-title"></div><div class="sk w-date"></div></div><div class="skeleton-row"><div class="sk w-pill"></div><div class="sk w-title"></div><div class="sk w-date"></div></div><div class="skeleton-row"><div class="sk w-pill"></div><div class="sk w-title"></div><div class="sk w-date"></div></div></div>
	</div>

	<div class="card"><h2><span>仓库状态</span></h2><div class="kv" id="repo-info">加载中…</div></div>
	<div class="card"><h2><span>未提交变更</span></h2><div id="uncommitted" class="mono">加载中…</div></div>
	<div class="card"><h2><span>待推送的提交</span></h2><div id="unpushed" class="mono">加载中…</div></div>

	<button class="btn big" id="main-btn" disabled onclick="openConfirm()">推送到 GitHub</button>
	<div style="height:14px"></div>
	<pre class="term" id="term"></pre>
</div>

<div class="overlay" id="overlay-create">
	<div class="modal">
		<h3>新建笔记</h3>
		<label class="field-label">标题(会显示在文章页)</label>
		<input type="text" id="new-title" placeholder="例如:RAG 面试第一性原理">
		<label class="field-label">文件名(英文,留空自动生成;决定 URL 路径)</label>
		<input type="text" id="new-file" placeholder="例如:rag-notes">
		<div class="row">
			<button class="btn ghost" onclick="closeCreate()">取消</button>
			<button class="btn" id="create-btn" onclick="createPost()">创建(草稿)</button>
		</div>
	</div>
</div>

<div class="overlay" id="overlay-push">
	<div class="modal">
		<h3>确认推送</h3>
		<div class="summary" id="confirm-summary"></div>
		<input type="text" id="msg" placeholder="提交信息(留空则自动生成,只记录新建/删除文章)">
		<div class="row">
			<button class="btn ghost" onclick="closeConfirm()">取消</button>
			<button class="btn danger" id="confirm-btn" onclick="confirmPush()">⚠ 确认推送</button>
		</div>
	</div>
</div>

<div class="toast" id="toast"></div>

<script>
var ST = null;
function el(id){ return document.getElementById(id); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function toast(t){
	var x = el('toast');
	x.textContent = t;
	x.classList.add('show');
	clearTimeout(x._t);
	x._t = setTimeout(function(){ x.classList.remove('show'); }, 2400);
}
function termLog(ok, text){ var t = el('term'); t.style.display = 'block'; t.innerHTML = (ok ? '<span class="ok-flag">✓</span> ' : '<span class="fail-flag">✗</span> ') + esc(text); }
function api(path, body){ return fetch(path, body ? { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) } : undefined).then(function(r){ return r.json(); }); }

function emptyHtml(ico, msg){
	return '<div class="empty"><div class="empty-ico">' + ico + '</div><div>' + msg + '</div></div>';
}

function fetchStatus(){
	return api('/api/status').then(function(s){
		ST = s;
		el('root-path').textContent = s.root;
		el('repo-info').innerHTML =
			'<span class="kv-row"><b>分支</b><span class="mono">' + esc(s.branch) + '</span></span>' +
			'<span class="kv-row"><b>远程</b>' + (s.hasRemote ? '<span class="mono">' + esc(s.remote) + '</span>' : '<span class="fail-flag">未配置(先 gh repo create)</span>') + '</span>' +
			(s.hasRemote ? '<span class="kv-row"><b>领先</b><span class="pill">' + s.ahead + '</span> <b>落后</b><span class="pill">' + s.behind + '</span></span>' : '');
		var u = s.uncommitted.length
			? s.uncommitted.map(function(f){ return '<div class="file-row"><span class="st">' + esc(f.status) + '</span><span class="file-name">' + esc(f.file) + '</span></div>'; }).join('')
			: emptyHtml('✓', '工作区干净,没有待提交的文件');
		el('uncommitted').innerHTML = u;
		var p = s.unpushed.length
			? s.unpushed.map(function(c){ return '<div class="commit-row">' + esc(c) + '</div>'; }).join('')
			: emptyHtml('↑', '没有待推送的提交');
		el('unpushed').innerHTML = p;
		var nothing = !s.uncommitted.length && !s.unpushed.length;
		var btn = el('main-btn');
		btn.disabled = nothing;
		btn.textContent = nothing ? '当前没有需要推送的内容' : '推送到 GitHub';
	});
}

function fetchPosts(){
	return api('/api/posts').then(function(list){
		if (!list.length) { el('posts').innerHTML = emptyHtml('✎', '还没有文章,点右上角新建一份'); return; }
		el('posts').innerHTML = list.map(function(p){
			var badge = p.draft ? '<span class="pill draft">草稿</span>' : '<span class="pill live">已发布</span>';
			var act = p.draft
				? '<button class="btn" data-act="publish">发布</button>'
				: '<button class="btn ghost" data-act="unpublish">转草稿</button>';
			var gh = p.githubUrl
				? (p.inRemote
					? '<a class="btn ghost" href="' + esc(p.githubUrl) + '" target="_blank" rel="noopener" title="在 GitHub 上查看源文件">↗ GitHub</a>'
					: '<button class="btn ghost" disabled title="推送后此按钮可用">未推送</button>')
				: '';
			return '<div class="post-row" data-file="' + esc(p.file) + '">' + badge + '<button class="btn ghost" data-act="edit">✎ 编辑</button>' + gh + '<span class="post-title" title="' + esc(p.file) + '">' + esc(p.title) + '</span><span class="post-date">' + esc(p.published) + '</span><span class="post-actions">' + act + '<button class="btn danger" data-act="delete">删除</button></span></div>';
		}).join('');
		// 事件委托:一次绑定,所有 post-row 子按钮统一处理
		el('posts').onclick = function(e){
			var btn = e.target.closest('button[data-act]');
			if (!btn) return;
			var row = btn.closest('.post-row');
			if (!row) return;
			var file = row.getAttribute('data-file');
			if (btn.dataset.act === 'edit') openInEditor(file);
			else if (btn.dataset.act === 'publish') publishPost(file);
			else if (btn.dataset.act === 'unpublish') unpublishPost(file);
			else if (btn.dataset.act === 'delete') deletePost(file);
		};
	});
}

function openCreate(){ el('new-title').value = ''; el('new-file').value = ''; el('overlay-create').classList.add('show'); setTimeout(function(){ el('new-title').focus(); }, 60); }
function closeCreate(){ el('overlay-create').classList.remove('show'); }
function createPost(){
	var title = el('new-title').value.trim(), file = el('new-file').value.trim();
	if (!title) { toast('请填写标题'); return; }
	var b = el('create-btn'); b.disabled = true;
	api('/api/posts/create', { filename: file, title: title }).then(function(r){
		b.disabled = false;
		if (r.error) { toast('创建失败: ' + r.error); return; }
		closeCreate();
		toast('已创建草稿: ' + r.file + '(用编辑器写作,保存后自动预览)');
		fetchPosts(); fetchStatus();
	});
}

function openInEditor(file){
		fetch('/api/posts/open', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ file: file })
		}).then(function(r){ return r.json(); }).then(function(result){
			if (result.error) toast('打开编辑器失败: ' + result.error);
			else toast('已在 VS Code 中打开: ' + file);
		}).catch(function(){ toast('打开编辑器失败: 管理台无法连接'); });
	}

function publishPost(file){
	api('/api/posts/publish', { file: file, draft: false }).then(function(r){
		if (r.error) { toast('失败: ' + r.error); return; }
		toast('已标记为发布,接下来推送上线');
		fetchPosts(); fetchStatus();
		setTimeout(function(){ openConfirm(); }, 400);
	});
}
function unpublishPost(file){
	api('/api/posts/publish', { file: file, draft: true }).then(function(r){
		if (r.error) { toast('失败: ' + r.error); return; }
		toast('已转回草稿(线上要等下次推送后消失)');
		fetchPosts(); fetchStatus();
	});
}
function deletePost(file){
	if (!confirm('确定删除笔记 ' + file + ' ?\\n已提交过的内容可从 git 历史找回,未提交的将无法恢复。')) return;
	api('/api/posts/delete', { file: file }).then(function(r){
		if (r.error) { toast('失败: ' + r.error); return; }
		toast('已删除: ' + file);
		fetchPosts(); fetchStatus();
	});
}

function openConfirm(presetMsg){
	if (!ST) return;
	var h = '';
	if (ST.uncommitted.length) h += '• 将提交 <b>' + ST.uncommitted.length + '</b> 个文件的变更<br>';
	h += '• 全部内容合并为 <b>1 个干净提交</b>(历史只留文章动作)<br>';
	if (ST.unpushed.length) h += '• 原 ' + ST.unpushed.length + ' 个本地提交将一并合并';
	h += '<br>• 目标: <span class="mono">' + (ST.hasRemote ? esc(ST.remote) : '未配置远程仓库') + '</span>';
	el('confirm-summary').innerHTML = h;
	el('msg').value = presetMsg || '';
	el('overlay-push').classList.add('show');
	setTimeout(function(){ el('msg').focus(); }, 60);
}
function closeConfirm(){ el('overlay-push').classList.remove('show'); }
function confirmPush(){
	var msg = el('msg').value;
	if (ST && ST.uncommitted.length && !msg.trim()) { /* 留空 OK,后端按文章动作自动生成 */ }
	var btn = el('confirm-btn');
	btn.disabled = true; btn.textContent = '推送中…';
	api('/api/push', { message: msg }).then(function(res){
		termLog(res.ok, res.log);
		closeConfirm();
		btn.disabled = false; btn.textContent = '⚠ 确认推送';
		fetchStatus(); fetchPosts();
	});
}

fetchStatus();
fetchPosts();
setInterval(fetchStatus, 15000);
</script>
</body>
</html>`;

/* ---------------------------- HTTP 服务 ---------------------------- */

const server = http.createServer((req, res) => {
	const json = (code, obj) => {
		res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(obj));
	};

	if (req.method === "GET" && req.url === "/") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(PAGE);
		return;
	}
	if (req.method === "GET" && req.url === "/api/status") {
		getStatus().then((s) => json(200, s)).catch((e) => json(500, { error: String(e) }));
		return;
	}
	if (req.method === "GET" && req.url === "/api/posts") {
		listPosts().then((p) => json(200, p)).catch((e) => json(500, { error: String(e) }));
		return;
	}

	const body = () =>
		new Promise((resolve) => {
			let b = "";
			req.on("data", (c) => {
				b += c;
				if (b.length > 65536) req.destroy();
			});
			req.on("end", () => {
				try {
					resolve(JSON.parse(b || "{}"));
				} catch {
					resolve({});
				}
			});
		});

	if (req.method === "POST" && req.url === "/api/posts/create") {
		body()
			.then((b) => createPost(b.filename, b.title))
			.then((r) => json(200, r))
			.catch((e) => json(400, { error: e.code === "EEXIST" ? "同名文件已存在" : String(e.message || e) }));
		return;
	}
	if (req.method === "POST" && req.url === "/api/posts/delete") {
		body()
			.then((b) => deletePost(b.file))
			.then((r) => json(200, r))
			.catch((e) => json(400, { error: String(e.message || e) }));
		return;
	}
	if (req.method === "POST" && req.url === "/api/posts/publish") {
		body()
			.then((b) => setDraft(b.file, Boolean(b.draft)))
			.then((r) => json(200, r))
			.catch((e) => json(400, { error: String(e.message || e) }));
		return;
	}
		if (req.method === "POST" && req.url === "/api/posts/open") {
			body()
				.then(async (b) => {
					const full = safePostPath(b.file);
					const editor = await findVsCode();
					if (!editor) throw new Error("未找到 VS Code,请确认已安装或设置 VSCODE_BIN 环境变量");
					spawn(editor, ["--reuse-window", full], {
						detached: true,
						stdio: "ignore",
						windowsHide: false,
					}).unref();
					return { file: b.file, opened: true, editor };
				})
				.then((r) => json(200, r))
				.catch((e) => json(400, { error: String(e.message || e) }));
			return;
		}
	if (req.method === "POST" && req.url === "/api/push") {
		body()
			.then((b) => doCleanPush(b.message))
			.then((r) => json(200, r));
		return;
	}

	res.writeHead(404);
	res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`博客管理台已启动: http://127.0.0.1:${PORT}`);
	console.log(`仓库目录: ${ROOT}`);
});

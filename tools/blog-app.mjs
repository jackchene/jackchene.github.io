// 博客客户端启动器:静默拉起本地服务,用 Edge --app 独立窗口打开管理台
// 由 blog-app.vbs 静默调用,无黑窗
import { spawn, exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BLOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const APP_URL = "http://127.0.0.1:4399/";

const SERVICES = [
	{
		name: "博客预览",
		probe: "http://localhost:4321/",
		cwd: BLOG,
		cmd: ["cmd", ["/c", "pnpm dev"]],
	},
	{
		name: "管理台",
		probe: "http://127.0.0.1:4399/api/status",
		cwd: BLOG,
		cmd: ["node", ["tools/push-ui.mjs"]],
	},
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeOk(url) {
	try {
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), 2000);
		const res = await fetch(url, { signal: ctl.signal });
		clearTimeout(t);
		return res.ok;
	} catch {
		return false;
	}
}

async function waitReady(url, timeoutMs = 90000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await probeOk(url)) return true;
		await sleep(1500);
	}
	return false;
}

for (const svc of SERVICES) {
	if (await probeOk(svc.probe)) continue;
	const [cmd, args] = svc.cmd;
	spawn(cmd, args, { cwd: svc.cwd, detached: true, stdio: "ignore", windowsHide: true }).unref();
	await waitReady(svc.probe);
}

// 直接 spawn,避开 cmd 对 --app=URL 的引号解析坑
spawn(EDGE, [`--app=${APP_URL}`, `--window-size=1200,820`, `--window-position=200,120`], {
	detached: true,
	stdio: "ignore",
	windowsHide: true,
}).unref();

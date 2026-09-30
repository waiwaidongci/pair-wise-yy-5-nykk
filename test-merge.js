// 合并逻辑测试：用 DOM 桩加载 index.html 内联脚本并驱动补丁合并流程。
// 运行：node test-merge.js
const fs = require("fs");
const assert = require("assert");

const html = fs.readFileSync(__dirname + "/index.html", "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

// ---- DOM / 浏览器环境桩 ----
const elements = {};
function makeEl(id) {
  return {
    id, innerHTML: "", textContent: "", value: id === "#rows" ? "14" : "18",
    disabled: false, dataset: {}, style: {}, files: [],
    onclick: null, onchange: null, onpointerdown: null, onpointerenter: null,
    click() { if (this.onclick) this.onclick(); },
    querySelectorAll() { return []; },
  };
}
global.document = {
  querySelector: sel => (elements[sel] ||= makeEl(sel)),
  querySelectorAll: () => [],
  createElement: () => ({ click() { global.__lastDownload = { name: this.download, href: this.href }; } }),
};
const store = {};
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
global.window = {};
global.Blob = class { constructor(parts) { this.parts = parts; } };
const blobs = {};
global.URL = {
  createObjectURL: b => { const u = "blob:" + Object.keys(blobs).length; blobs[u] = b; return u; },
  revokeObjectURL: () => {},
};

// 暴露脚本内部状态便于断言
const api = eval(script + `
;({
  get cells() { return cells; }, get version() { return version; }, get pid() { return pid; },
  get undo() { return undo; }, get mergeSession() { return mergeSession; },
  set active(v) { active = v; },
  paint, startMerge, confirmMerge, restoreMerge, exportPatch, importFiles,
  status: () => mergeStatus.textContent,
  saved: () => JSON.parse(store.zfl31Pattern || "null"),
  download: () => { const d = global.__lastDownload; return d ? JSON.parse(blobs[d.href].parts[0]) : null; },
  file: obj => ({ text: async () => JSON.stringify(obj) }),
  el: id => document.querySelector(id),
})`);

const file = api.file;
const status = () => api.status();

async function test(name, fn) {
  try { await fn(); console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name + "\n  " + e.message); process.exitCode = 1; }
}

(async () => {
  await test("初始化为空网格，版本为1", () => {
    assert.equal(api.cells.length, 18 * 14);
    assert.ok(api.cells.every(v => v === 0));
    assert.equal(api.version, 1);
  });

  await test("绘制推进版本并可保存基线", () => {
    api.active = 1; api.paint(0);
    assert.equal(api.cells[0], 1);
    assert.equal(api.version, 2);
    api.el("#saveBtn").onclick();
    assert.equal(api.saved().version, 2);
    assert.ok(api.saved().pid);
  });

  let patch;
  await test("导出补丁：相对基线的改动格", () => {
    api.active = 2; api.paint(5);
    api.exportPatch();
    patch = api.download();
    assert.equal(patch.baseVersion, 2);
    assert.deepEqual(patch.changes, [{ i: 5, from: 0, to: 2 }]);
  });

  await test("版本相同：补丁直接并入", async () => {
    // 回退到保存时的图案内容（模拟未动的站点图案），版本随撤销继续推进
    api.el("#undoBtn").onclick(); // 撤销 paint(5)
    const p = { pid: api.pid, baseVersion: api.version, cols: 18, rows: 14, changes: [{ i: 9, from: 0, to: 6 }] };
    await api.importFiles([api.file(p)]);
    assert.equal(api.cells[9], 6);
    assert.equal(api.mergeSession.conflicts.size, 0);
    api.confirmMerge();
    assert.equal(api.cells[9], 6);
  });

  await test("版本不同且当前格未改：干净并入", async () => {
    const p = { baseVersion: 1, changes: [{ i: 20, from: 0, to: 3 }] };
    await api.importFiles([file(p)]);
    assert.equal(api.cells[20], 3);
    assert.equal(api.mergeSession.conflicts.size, 0);
    api.confirmMerge();
  });

  await test("当前格已改：各留一份待选，默认保留当前", async () => {
    api.active = 4; api.paint(30); // 站点把 30 格改成色4
    const p = { baseVersion: 1, changes: [{ i: 30, from: 0, to: 7 }] };
    await api.importFiles([file(p)]);
    const c = api.mergeSession.conflicts.get(30);
    assert.ok(c, "应记录冲突");
    assert.equal(c.current, 4);
    assert.equal(c.incoming, 7);
    assert.equal(api.cells[30], 4); // 确认前不动
    api.confirmMerge(); // 默认保留当前
    assert.equal(api.cells[30], 4);
  });

  await test("冲突可选补丁色，确认后生效", async () => {
    const p = { baseVersion: 1, changes: [{ i: 30, from: 0, to: 7 }] };
    await api.importFiles([file(p)]);
    const c = api.mergeSession.conflicts.get(30);
    c.pick = "incoming"; c.chosen = true;
    api.confirmMerge();
    assert.equal(api.cells[30], 7);
  });

  await test("多份补丁同格覆盖：后来的进入待选", async () => {
    const p1 = { baseVersion: api.version, pid: api.pid, changes: [{ i: 40, from: 0, to: 1 }] };
    const p2 = { baseVersion: 1, changes: [{ i: 40, from: 0, to: 5 }] };
    await api.importFiles([file(p1), file(p2)]);
    const c = api.mergeSession.conflicts.get(40);
    assert.ok(c, "第二份补丁改同一格应冲突");
    assert.equal(c.current, 1);
    assert.equal(c.incoming, 5);
    api.restoreMerge();
    assert.equal(api.cells[40], 0);
    assert.match(status(), /恢复/);
  });

  await test("合并失败：从原图案恢复并可重试", async () => {
    const before = [...api.cells];
    const bad = { baseVersion: 1, changes: [{ i: 99999, from: 0, to: 2 }] };
    await api.importFiles([file(bad)]);
    assert.equal(api.mergeSession, null);
    assert.deepEqual(api.cells, before);
    assert.match(status(), /合并失败.*恢复/);
    // 修正后重试成功
    const good = { baseVersion: 1, changes: [{ i: 50, from: 0, to: 2 }] };
    await api.importFiles([file(good)]);
    assert.equal(api.cells[50], 2);
    api.confirmMerge();
  });

  await test("尺寸不符的补丁判失败", async () => {
    const before = [...api.cells];
    const p = { baseVersion: 1, cols: 10, rows: 10, changes: [{ i: 1, from: 0, to: 2 }] };
    await api.importFiles([file(p)]);
    assert.equal(api.mergeSession, null);
    assert.deepEqual(api.cells, before);
    assert.match(status(), /尺寸/);
  });

  await test("整批合并只算一次撤销", async () => {
    const undoDepth = api.undo.length;
    const p1 = { baseVersion: api.version, pid: api.pid, changes: [{ i: 60, from: 0, to: 1 }] };
    const p2 = { baseVersion: 1, changes: [{ i: 61, from: 0, to: 2 }, { i: 62, from: 0, to: 3 }] };
    await api.importFiles([file(p1), file(p2)]);
    api.confirmMerge();
    assert.equal(api.undo.length, undoDepth + 1);
    assert.equal(api.cells[60], 1);
    api.el("#undoBtn").onclick();
    assert.equal(api.cells[60], 0);
    assert.equal(api.cells[61], 0);
    assert.equal(api.cells[62], 0);
  });

  await test("确认后统计/预览/风险/保存/导出均按新图案", () => {
    api.el("#saveBtn").onclick();
    const saved = api.saved();
    assert.deepEqual(saved.cells, api.cells);
    api.el("#exportBtn").onclick();
    const data = api.download();
    assert.equal(data.version, api.version);
    const usage0 = data.usage.find(u => u.color === "#f7e7c4").count;
    assert.equal(usage0, api.cells.filter(v => v === 0).length);
    assert.ok(elements["#stats"].innerHTML.includes("色线"));
    assert.ok(elements["#preview"].innerHTML.includes("mini"));
    assert.ok(elements["#risk"].innerHTML.length > 0);
  });

  await test("合并待确认时禁止绘制与撤销", () => {
    const p = { baseVersion: 1, changes: [{ i: 70, from: 0, to: 2 }] };
    return api.importFiles([file(p)]).then(() => {
      const undoDepth = api.undo.length;
      api.paint(71);
      assert.equal(api.cells[71], 0);
      api.el("#undoBtn").onclick();
      assert.equal(api.undo.length, undoDepth);
      api.confirmMerge();
    });
  });

  console.log(process.exitCode ? "存在失败用例" : "全部通过");
})();

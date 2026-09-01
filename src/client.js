// dsh-persistent-memory browser half — settings.section with five switches.
// Loader protocol: window.__ModuleLoader__.load (same envelope as dsh-email).
window.__ModuleLoader__.load({ id: "@dsh-external/dsh-persistent-memory", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

const React = require("react");
const { useState, useEffect, useCallback } = React;
const h = React.createElement;

const ROUTE = "/_dsh/dsh-persistent-memory/settings";

async function api(action, payload) {
  const init = action === undefined
    ? { credentials: "same-origin" }
    : {
        credentials: "same-origin",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ action }, payload)),
      };
  const res = await fetch(ROUTE, init);
  const body = await res.json();
  if (!res.ok || !body.ok) {
    throw new Error((body && body.error && body.error.message) || ("request failed " + res.status));
  }
  return body.value;
}

const FIELDS = [
  ["autoRecall", "自动回忆：首轮自动召回相关记忆"],
  ["autoCapture", "自动捕获：每会话注入自动记忆守则"],
  ["autoRecallRerank", "回忆重排：LLM 从候选里挑「明确有用」的"],
  ["rrfRecall", "RRF 召回：词法零命中时按语义补位"],
  ["approveOnSet", "写入审批：记忆写入前需征得用户同意"],
];

const CSS = [
  ".dspm-settings{display:grid;gap:14px;max-width:900px;padding:8px 2px 32px;color:var(--dsw-alias-fg-primary,#26231f)}",
  ".dspm-header{display:grid;gap:4px;padding:8px 2px}",
  ".dspm-header h2{font-size:22px;letter-spacing:-.02em;margin:0}",
  ".dspm-header p{max-width:640px;margin:4px 0 0;color:var(--dsw-alias-fg-muted,#77736d);font-size:13px;line-height:1.55}",
  ".dspm-panel{display:grid;gap:10px;padding:15px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff)}",
  ".dspm-check{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.45;padding:2px 0}",
  ".dspm-check small{display:block;color:var(--dsw-alias-fg-muted,#77736d)}",
  ".dspm-actions{display:flex;gap:8px;flex-wrap:wrap}",
  ".dspm-btn{display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font-size:13px;font-weight:600;cursor:pointer}",
  ".dspm-btn.primary{background:#0b6c9f;border-color:#0b6c9f;color:#fff}",
  ".dspm-btn:disabled{opacity:.55;cursor:default}",
  ".dspm-alert{padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.5}",
  ".dspm-alert.error{background:rgba(205,72,72,.1);color:#aa3939}",
  ".dspm-alert.success{background:rgba(48,154,100,.1);color:#267d52}",
  ".dspm-alert.info{background:rgba(11,108,159,.08);color:#0b5c86}",
].join("\n");

function MemorySettingsSection() {
  const [draft, setDraft] = useState(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const snap = await api();
      const s = (snap && snap.settings) || {};
      setDraft(Object.assign({}, s.value || {}));
      setRevision(typeof s.revision === "number" ? s.revision : 0);
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const doSave = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      await api("save", { value: draft, expectedRevision: revision });
      setMessage("已保存并生效。");
      await load();
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (draft === null) {
    return h("div", { className: "dspm-settings" }, [
      h("div", { className: "dspm-alert info" }, busy ? "加载中…" : (error || "加载中…")),
    ]);
  }

  return h("div", { className: "dspm-settings" }, [
    h("header", { className: "dspm-header" }, [
      h("h2", null, "记忆"),
      h("p", null, "dsh-persistent-memory 持久记忆插件的运行开关。全部开关即时生效，无需重启。"),
    ]),
    h("section", { className: "dspm-panel" },
      FIELDS.map(([key, label]) => h("label", { className: "dspm-check", key }, [
        h("input", {
          type: "checkbox",
          checked: draft[key] === true,
          onChange: () => setDraft((cur) => Object.assign({}, cur, { [key]: !cur[key] })),
        }),
        h("span", null, [label, h("small", null, key)]),
      ])),
    ),
    h("div", { className: "dspm-actions" }, [
      h("button", { className: "dspm-btn primary", disabled: busy, onClick: doSave }, busy ? "处理中…" : "保存并应用"),
    ]),
    error ? h("div", { className: "dspm-alert error" }, error) : null,
    message ? h("div", { className: "dspm-alert success" }, message) : null,
  ]);
}

const inject = ["slots"];

function apply(ctx) {
  ctx.effect(() => {
    const id = "dsh-persistent-memory/client";
    if (document.querySelector('style[data-plugin-css="' + id + '"]')) return () => {};
    const style = document.createElement("style");
    style.dataset.plugin = "dsh-persistent-memory";
    style.dataset.pluginCss = id;
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, "dsh-persistent-memory: styles");

  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "dsh-persistent-memory",
    order: 46,
    label: () => "记忆 (dsh-persistent-memory)",
    inject: () => ({}),
  }, MemorySettingsSection));
}

exports.apply = apply;
exports.inject = inject;

return module.exports;
}});

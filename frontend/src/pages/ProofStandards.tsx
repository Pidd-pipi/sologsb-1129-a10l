import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { StandardConflictError, useMatrixStore } from '../stores/matrixStore';
import { useUiStore } from '../stores/uiStore';
import {
  STANDARD_FONT_OPTIONS,
  STANDARD_SIZE_OPTIONS,
  diffStandard,
  standardKeyOf,
  validateStandardInput,
  type ProofStandardInput,
} from '../types/proofStandard';
import type { ProofStandard } from '../types/proofStandard';
import { IMPRESSION_RANGE, PRESSURE_RANGE } from '../types/proof';
import { formatStamp } from '../utils/format';

type StandardFormState = {
  font: string;
  sizeName: string;
  pressureMinKg: string;
  pressureMaxKg: string;
  ink: string;
  minImpressions: string;
  note: string;
};

const EMPTY_FORM: StandardFormState = {
  font: STANDARD_FONT_OPTIONS[0],
  sizeName: STANDARD_SIZE_OPTIONS[0],
  pressureMinKg: '10',
  pressureMaxKg: '14',
  ink: '油烟墨 101',
  minImpressions: '30',
  note: '',
};

function formFromStandard(s: ProofStandard): StandardFormState {
  return {
    font: s.font,
    sizeName: s.sizeName,
    pressureMinKg: `${s.pressureMinKg}`,
    pressureMaxKg: `${s.pressureMaxKg}`,
    ink: s.ink,
    minImpressions: `${s.minImpressions}`,
    note: s.note,
  };
}

function toInput(form: StandardFormState): ProofStandardInput {
  return {
    font: form.font,
    sizeName: form.sizeName,
    pressureMinKg: Number(form.pressureMinKg),
    pressureMaxKg: Number(form.pressureMaxKg),
    ink: form.ink,
    minImpressions: Number(form.minImpressions),
    note: form.note,
  };
}

/**
 * 晚保存冲突：标准在本页打开编辑期间已被他人改动。
 * 先看差异，再选择放弃自己的修改、或仍以编辑稿入库（再升一个版本）。
 */
interface ConflictState {
  current: ProofStandard;
  draft: ProofStandardInput;
  id: string;
}

/** `/standards` 试印工艺标准：按字体 / 字号登记推荐压力区间、用墨与最少印次 */
export default function ProofStandards() {
  const standards = useMatrixStore((s) => s.standards);
  const proofs = useMatrixStore((s) => s.proofs);
  const saveStandard = useMatrixStore((s) => s.saveStandard);
  const refreshStandards = useMatrixStore((s) => s.refreshStandards);
  const pushToast = useUiStore((s) => s.pushToast);

  const [form, setForm] = useState<StandardFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string>('');
  const [baseVersion, setBaseVersion] = useState<number | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<ConflictState | null>(null);

  // 他人可能在另一个标签页同时修改；切回本标签时重读一次，保证版本号是最新的
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshStandards();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refreshStandards]);

  const openProofCountByKey = useMemo(() => {
    const out: Record<string, number> = {};
    proofs.forEach((p) => {
      if (p.archived || !p.standardKey) return;
      out[p.standardKey] = (out[p.standardKey] ?? 0) + 1;
    });
    return out;
  }, [proofs]);

  const duplicateKey = useMemo(() => {
    const key = `${form.font}|${form.sizeName}`;
    const hit = standards.find((s) => standardKeyOf(s) === key && s.id !== editingId);
    return hit ? key : '';
  }, [form.font, form.sizeName, standards, editingId]);

  const startEdit = (s: ProofStandard) => {
    setConflict(null);
    setForm(formFromStandard(s));
    setEditingId(s.id);
    setBaseVersion(s.version);
    setErrors({});
  };

  const startCreate = () => {
    setConflict(null);
    setForm(EMPTY_FORM);
    setEditingId('');
    setBaseVersion(undefined);
    setErrors({});
  };

  const patch = (next: Partial<StandardFormState>) => {
    setForm((cur) => ({ ...cur, ...next }));
    if (conflict) setConflict(null);
  };

  const submit = async (force: boolean) => {
    const input = toInput(form);
    const next = validateStandardInput(input);
    setErrors(next);
    if (Object.keys(next).length > 0) {
      pushToast('标准未通过校验，请按提示修正', 'warn');
      return;
    }
    try {
      const saved = await saveStandard(input, editingId || undefined, baseVersion, force);
      pushToast(
        editingId
          ? `「${saved.font} / ${saved.sizeName}」标准已更新至第 ${saved.version} 版，未归档试印已重算`
          : `已新增「${saved.font} / ${saved.sizeName}」试印标准`,
      );
      setConflict(null);
      startEdit(saved);
    } catch (err) {
      if (err instanceof StandardConflictError) {
        setConflict({ current: err.current, draft: input, id: editingId });
        pushToast('标准已被他人修改，请先查看差异再决定入库', 'warn');
        return;
      }
      pushToast(err instanceof Error ? err.message : '标准保存失败', 'error');
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(false);
  };

  const diffRows = conflict ? diffStandard(conflict.current, conflict.draft) : [];

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="standard-list-title">
            试印工艺标准
          </h2>
          <p className="mt-sub">
            按字体与字号登记推荐压力区间、用墨与最少印次；试印照它判达标 / 偏淡 / 糊版。改动标准后，未归档试印自动重算，已留档样张保持当时判定。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="mt-chip" data-testid="standard-total">
            标准 {standards.length} 条
          </span>
          <button
            type="button"
            className="mt-btn"
            data-testid="standard-create-btn"
            onClick={startCreate}
          >
            新增标准
          </button>
        </div>
      </section>

      {conflict ? (
        <section
          className="rounded-lg border border-seal/50 bg-seal-pale px-4 py-3"
          data-testid="standard-conflict-panel"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-song text-sm font-semibold text-seal">
              标准已变过：「{conflict.current.font} / {conflict.current.sizeName}」在你编辑期间已由他人保存（现为第 {conflict.current.version} 版，你打开时是第 {baseVersion} 版）
            </h3>
          </div>
          {diffRows.length === 0 ? (
            <p className="mt-2 text-xs text-ink-soft" data-testid="conflict-no-diff">
              现行标准与你的编辑稿内容一致（对方可能只做了一次等价保存），可直接放弃修改。
            </p>
          ) : (
            <table className="mt-2 min-w-full" data-testid="conflict-diff-table">
              <thead>
                <tr className="border-b border-seal/30 text-left text-[11px] text-ink-mute">
                  <th className="py-1 pr-3">字段</th>
                  <th className="py-1 pr-3">他人已入库（现行）</th>
                  <th className="py-1 pr-3">你的编辑稿（晚保存）</th>
                </tr>
              </thead>
              <tbody className="text-xs text-ink-soft">
                {diffRows.map((row) => (
                  <tr key={row.label} className="border-b border-seal/15" data-testid={`conflict-diff-${row.label}`}>
                    <td className="py-1 pr-3 font-medium">{row.label}</td>
                    <td className="py-1 pr-3 text-jade">{row.before}</td>
                    <td className="py-1 pr-3 text-seal">{row.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="mt-btn mt-btn-primary"
              data-testid="conflict-force-save"
              onClick={() => void submit(true)}
            >
              看过差异，仍按我的版本入库
            </button>
            <button
              type="button"
              className="mt-btn"
              data-testid="conflict-discard"
              onClick={() => {
                startEdit(conflict.current);
                pushToast('已载入他人保存的现行标准');
              }}
            >
              放弃我的修改，载入现行标准
            </button>
          </div>
        </section>
      ) : null}

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink" data-testid="standard-form-title">
            {editingId ? `修改标准（第 ${baseVersion} 版）` : '登记新标准'}
          </h3>
          {editingId ? (
            <span className="mt-sub">保存即升版本，并触发未归档试印重算</span>
          ) : (
            <span className="mt-sub">同一字体 + 字号只能有一条标准</span>
          )}
        </div>
        <form className="space-y-3 px-4 py-4" onSubmit={handleSubmit} data-testid="standard-form">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div>
              <label className="mt-label" htmlFor="std-font">
                字体
              </label>
              <select
                id="std-font"
                data-testid="std-font"
                className="mt-input"
                value={form.font}
                onChange={(e) => patch({ font: e.target.value })}
              >
                {STANDARD_FONT_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              {errors.font ? <p className="mt-error">{errors.font}</p> : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="std-size">
                字号
              </label>
              <select
                id="std-size"
                data-testid="std-size"
                className="mt-input"
                value={form.sizeName}
                onChange={(e) => patch({ sizeName: e.target.value })}
              >
                {STANDARD_SIZE_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {errors.sizeName ? <p className="mt-error">{errors.sizeName}</p> : null}
              {duplicateKey ? (
                <p className="mt-error" data-testid="std-duplicate-hint">
                  该字体 / 字号已有标准，请在列表中选「修改」
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="std-pressure-min">
                推荐压力下限 kg
              </label>
              <input
                id="std-pressure-min"
                data-testid="std-pressure-min"
                className="mt-input"
                type="number"
                min={PRESSURE_RANGE.min}
                max={PRESSURE_RANGE.max}
                step={0.5}
                value={form.pressureMinKg}
                onChange={(e) => patch({ pressureMinKg: e.target.value })}
              />
              {errors.pressureMinKg ? (
                <p className="mt-error" data-testid="error-pressureMinKg">
                  {errors.pressureMinKg}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="std-pressure-max">
                推荐压力上限 kg
              </label>
              <input
                id="std-pressure-max"
                data-testid="std-pressure-max"
                className="mt-input"
                type="number"
                min={PRESSURE_RANGE.min}
                max={PRESSURE_RANGE.max}
                step={0.5}
                value={form.pressureMaxKg}
                onChange={(e) => patch({ pressureMaxKg: e.target.value })}
              />
              {errors.pressureMaxKg ? (
                <p className="mt-error" data-testid="error-pressureMaxKg">
                  {errors.pressureMaxKg}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="std-ink">
                推荐用墨
              </label>
              <input
                id="std-ink"
                data-testid="std-ink"
                className="mt-input"
                placeholder="例：油烟墨 101"
                value={form.ink}
                onChange={(e) => patch({ ink: e.target.value })}
              />
              {errors.ink ? (
                <p className="mt-error" data-testid="error-ink">
                  {errors.ink}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="std-min-impressions">
                最少印次
              </label>
              <input
                id="std-min-impressions"
                data-testid="std-min-impressions"
                className="mt-input"
                type="number"
                min={IMPRESSION_RANGE.min}
                max={IMPRESSION_RANGE.max}
                step={1}
                value={form.minImpressions}
                onChange={(e) => patch({ minImpressions: e.target.value })}
              />
              {errors.minImpressions ? (
                <p className="mt-error" data-testid="error-minImpressions">
                  {errors.minImpressions}
                </p>
              ) : null}
            </div>
            <div className="md:col-span-2">
              <label className="mt-label" htmlFor="std-note">
                备注
              </label>
              <input
                id="std-note"
                data-testid="std-note"
                className="mt-input"
                placeholder="例：大号铜模，压力取中上限"
                value={form.note}
                onChange={(e) => patch({ note: e.target.value })}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="mt-btn mt-btn-primary" data-testid="submit-standard">
              {editingId ? '保存修改并升版本' : '登记标准'}
            </button>
            {editingId ? (
              <button type="button" className="mt-btn" data-testid="cancel-standard-edit" onClick={startCreate}>
                取消，改为新增
              </button>
            ) : null}
            <span className="mt-hint">
              判法：压力高于上限判糊版；低于下限、印次不足或用墨不符判偏淡；其余判达标；该字体 / 字号无标准判未定标。
            </span>
          </div>
        </form>
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">现行标准台账</h3>
          <span className="mt-sub">括号内为尚未归档、改标准后会跟着重算的试印数</span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full" data-testid="standard-table">
            <thead className="border-b border-paper-line bg-paper/60">
              <tr>
                <th className="mt-th">字体 / 字号</th>
                <th className="mt-th">推荐压力 kg</th>
                <th className="mt-th">推荐用墨</th>
                <th className="mt-th">最少印次</th>
                <th className="mt-th">版本 / 更新时间</th>
                <th className="mt-th">待重算试印</th>
                <th className="mt-th">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-line">
              {standards.length === 0 ? (
                <tr>
                  <td className="mt-td text-ink-mute" colSpan={7}>
                    暂无标准，请先登记。
                  </td>
                </tr>
              ) : (
                standards.map((s) => (
                  <tr
                    key={s.id}
                    data-testid={`standard-row-${s.id}`}
                    className={editingId === s.id ? 'bg-seal-pale/50' : undefined}
                  >
                    <td className="mt-td font-song text-ink">
                      {s.font} · {s.sizeName}
                      {s.note ? <span className="mt-1 block text-[11px] font-sans text-ink-mute">{s.note}</span> : null}
                    </td>
                    <td className="mt-td">
                      {s.pressureMinKg} – {s.pressureMaxKg}
                    </td>
                    <td className="mt-td">{s.ink}</td>
                    <td className="mt-td">{s.minImpressions}</td>
                    <td className="mt-td text-xs text-ink-mute">
                      v{s.version} · {formatStamp(s.updatedAt)}
                    </td>
                    <td className="mt-td">
                      <span
                        className={`mt-chip ${openProofCountByKey[standardKeyOf(s)] ? 'border-brass/40 text-brass' : ''}`}
                        data-testid={`open-count-${s.id}`}
                      >
                        {openProofCountByKey[standardKeyOf(s)] ?? 0} 条
                      </span>
                    </td>
                    <td className="mt-td">
                      <button
                        type="button"
                        className="mt-btn mt-btn-ghost"
                        data-testid={`edit-standard-${s.id}`}
                        onClick={() => startEdit(s)}
                      >
                        修改
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { DRAFT_KEYS, useLocalDraft } from '../hooks/useLocalDraft';
import { useMatrixStore } from '../stores/matrixStore';
import { useUiStore } from '../stores/uiStore';
import { MATRIX_FONTS, MATRIX_SIZE_NAMES, type MatrixFont } from '../types/matrix';
import { IMPRESSION_RANGE, PRESSURE_RANGE } from '../types/proof';
import {
  StandardConflictError,
  currentStandards,
  diffStandard,
  latestStandard,
  validateProofStandardInput,
  type ProofStandard,
  type ProofStandardInput,
  type StandardFieldDiff,
} from '../types/standard';
import { dash, formatDate, formatStamp, todayStr } from '../utils/format';

interface StandardFormState {
  font: MatrixFont;
  sizeName: string;
  pressureMinKg: string;
  pressureMaxKg: string;
  ink: string;
  minImpressions: string;
  effectiveDate: string;
  updatedBy: string;
  note: string;
  /** 表单载入时基于的标准版本：保存时据此做乐观锁校验，0 表示该组合尚无标准 */
  baseVersion: number;
}

const DEFAULT_FORM: StandardFormState = {
  font: '宋体',
  sizeName: '五号',
  pressureMinKg: '8',
  pressureMaxKg: '12',
  ink: '油烟墨 101',
  minImpressions: '30',
  effectiveDate: todayStr(),
  updatedBy: '',
  note: '',
  baseVersion: 0,
};

interface ConflictState {
  mine: ProofStandardInput;
  current?: ProofStandard;
  diff: StandardFieldDiff[];
}

/** `/standards` 试印工艺标准：按字体 + 字号登记推荐压力区间、用墨与最少印次，版本化保存 */
export default function ProofStandards() {
  const standards = useMatrixStore((s) => s.standards);
  const saveStandard = useMatrixStore((s) => s.saveStandard);
  const pushToast = useUiStore((s) => s.pushToast);

  const { draft, patch, replace, savedAt, existed } = useLocalDraft<StandardFormState>(
    DRAFT_KEYS.standardNew,
    DEFAULT_FORM,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [saving, setSaving] = useState(false);

  /** 把某字体 + 字号的现行标准载入表单；无标准则回到默认值，基准版本记 0 */
  const loadCurrent = (font: MatrixFont, sizeName: string) => {
    const cur = latestStandard(useMatrixStore.getState().standards, font, sizeName);
    replace({
      font,
      sizeName,
      pressureMinKg: cur ? String(cur.pressureMinKg) : DEFAULT_FORM.pressureMinKg,
      pressureMaxKg: cur ? String(cur.pressureMaxKg) : DEFAULT_FORM.pressureMaxKg,
      ink: cur?.ink ?? DEFAULT_FORM.ink,
      minImpressions: cur ? String(cur.minImpressions) : DEFAULT_FORM.minImpressions,
      effectiveDate: cur?.effectiveDate ?? todayStr(),
      updatedBy: cur?.updatedBy ?? '',
      note: cur?.note ?? '',
      baseVersion: cur?.version ?? 0,
    });
    setErrors({});
    setConflict(null);
  };

  // 首次进入且本地无草稿时，等标准列表就绪后把现行标准带进表单
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || existed) return;
    initialized.current = true;
    loadCurrent(DEFAULT_FORM.font, DEFAULT_FORM.sizeName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standards.length, existed]);

  const current = useMemo(() => currentStandards(standards), [standards]);
  const history = useMemo(
    () =>
      [...standards].sort((a, b) =>
        a.font === b.font && a.sizeName === b.sizeName
          ? b.version - a.version
          : a.createdAt < b.createdAt
            ? 1
            : -1,
      ),
    [standards],
  );
  const editing = useMemo(
    () => latestStandard(standards, draft.font, draft.sizeName),
    [standards, draft.font, draft.sizeName],
  );

  const buildInput = (): ProofStandardInput => ({
    font: draft.font,
    sizeName: draft.sizeName,
    pressureMinKg: Number(draft.pressureMinKg),
    pressureMaxKg: Number(draft.pressureMaxKg),
    ink: draft.ink,
    minImpressions: Number(draft.minImpressions),
    effectiveDate: draft.effectiveDate,
    updatedBy: draft.updatedBy,
    note: draft.note,
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const input = buildInput();
    const next = validateProofStandardInput(input);
    setErrors(next);
    if (Object.keys(next).length > 0) {
      pushToast('工艺标准未通过校验，请按提示修正', 'warn');
      return;
    }
    setSaving(true);
    try {
      const { standard, recalculated } = await saveStandard(input, draft.baseVersion);
      setConflict(null);
      patch({ baseVersion: standard.version, note: '' });
      pushToast(
        recalculated > 0
          ? `已保存 ${standard.font}/${standard.sizeName} 标准 v${standard.version}，并重算 ${recalculated} 条未留档试印`
          : `已保存 ${standard.font}/${standard.sizeName} 标准 v${standard.version}`,
      );
    } catch (err) {
      if (err instanceof StandardConflictError) {
        // 晚保存的一方：先看与库中现行版本的差异，再决定覆盖还是放弃
        setConflict({ mine: input, current: err.current, diff: err.current ? diffStandard(input, err.current) : [] });
        pushToast('该标准刚被他人修改过，请先核对差异再入库', 'warn');
      } else {
        pushToast(err instanceof Error ? err.message : '标准保存失败', 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  /** 冲突后选择「以我的填写覆盖入库」：基于库中最新版本重试一次 */
  const handleOverride = async () => {
    if (!conflict) return;
    setSaving(true);
    try {
      const { standard, recalculated } = await saveStandard(
        conflict.mine,
        conflict.current?.version ?? 0,
      );
      setConflict(null);
      patch({ baseVersion: standard.version, note: '' });
      pushToast(
        recalculated > 0
          ? `已覆盖保存标准 v${standard.version}，并重算 ${recalculated} 条未留档试印`
          : `已覆盖保存标准 v${standard.version}`,
      );
    } catch (err) {
      if (err instanceof StandardConflictError) {
        setConflict({
          mine: conflict.mine,
          current: err.current,
          diff: err.current ? diffStandard(conflict.mine, err.current) : [],
        });
        pushToast('标准又被修改过，请重新核对差异', 'warn');
      } else {
        pushToast(err instanceof Error ? err.message : '标准保存失败', 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="standards-title">
            试印工艺标准
          </h2>
          <p className="mt-sub">
            按字体与字号登记推荐压力区间、用墨和最少印次；试印照标准判定，标准改动后未留档的试印跟着重算，已留档样张保持当时判定。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="mt-chip" data-testid="standard-group-count">
            标准组合 {current.length}
          </span>
          <span className="mt-chip">版本累计 {standards.length}</span>
        </div>
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">
            {draft.baseVersion > 0 ? `修订标准（基于 v${draft.baseVersion}）` : '登记新标准'}
          </h3>
          <span className="mt-sub" data-testid="standard-draft-status">
            {existed ? `草稿已恢复 · ${savedAt || '—'}` : `草稿自动保存 ${savedAt || '—'}`}
          </span>
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
                value={draft.font}
                onChange={(e) => loadCurrent(e.target.value as MatrixFont, draft.sizeName)}
              >
                {MATRIX_FONTS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mt-label" htmlFor="std-size">
                字号
              </label>
              <select
                id="std-size"
                data-testid="std-size"
                className="mt-input"
                value={draft.sizeName}
                onChange={(e) => loadCurrent(draft.font, e.target.value)}
              >
                {MATRIX_SIZE_NAMES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {editing ? (
                <p className="mt-hint" data-testid="std-current-hint">
                  现行 v{editing.version}：{editing.pressureMinKg}–{editing.pressureMaxKg} kg ·{' '}
                  {editing.ink} · ≥{editing.minImpressions} 印次
                </p>
              ) : (
                <p className="mt-hint" data-testid="std-current-hint">
                  该组合尚无标准，保存后为 v1
                </p>
              )}
            </div>
            <div>
              <label className="mt-label" htmlFor="std-pressure-min">
                压力下限 kg
              </label>
              <input
                id="std-pressure-min"
                data-testid="std-pressure-min"
                className="mt-input"
                type="number"
                min={PRESSURE_RANGE.min}
                max={PRESSURE_RANGE.max}
                step={0.5}
                value={draft.pressureMinKg}
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
                压力上限 kg
              </label>
              <input
                id="std-pressure-max"
                data-testid="std-pressure-max"
                className="mt-input"
                type="number"
                min={PRESSURE_RANGE.min}
                max={PRESSURE_RANGE.max}
                step={0.5}
                value={draft.pressureMaxKg}
                onChange={(e) => patch({ pressureMaxKg: e.target.value })}
              />
              {errors.pressureMaxKg ? (
                <p className="mt-error" data-testid="error-pressureMaxKg">
                  {errors.pressureMaxKg}
                </p>
              ) : (
                <p className="mt-hint">
                  区间需在 {PRESSURE_RANGE.min}–{PRESSURE_RANGE.max} kg 内
                </p>
              )}
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
                value={draft.ink}
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
                value={draft.minImpressions}
                onChange={(e) => patch({ minImpressions: e.target.value })}
              />
              {errors.minImpressions ? (
                <p className="mt-error" data-testid="error-minImpressions">
                  {errors.minImpressions}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="std-effective-date">
                生效日期
              </label>
              <input
                id="std-effective-date"
                data-testid="std-effective-date"
                type="date"
                className="mt-input"
                value={draft.effectiveDate}
                onChange={(e) => patch({ effectiveDate: e.target.value })}
              />
              {errors.effectiveDate ? (
                <p className="mt-error" data-testid="error-effectiveDate">
                  {errors.effectiveDate}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="std-updated-by">
                修改人
              </label>
              <input
                id="std-updated-by"
                data-testid="std-updated-by"
                className="mt-input"
                placeholder="例：陈之安"
                value={draft.updatedBy}
                onChange={(e) => patch({ updatedBy: e.target.value })}
              />
              {errors.updatedBy ? (
                <p className="mt-error" data-testid="error-updatedBy">
                  {errors.updatedBy}
                </p>
              ) : null}
            </div>
            <div className="md:col-span-4">
              <label className="mt-label" htmlFor="std-note">
                备注
              </label>
              <input
                id="std-note"
                data-testid="std-note"
                className="mt-input"
                placeholder="例：换季油墨偏稠，压力上限上调 0.5kg"
                value={draft.note}
                onChange={(e) => patch({ note: e.target.value })}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="mt-btn mt-btn-primary"
              data-testid="submit-standard"
              disabled={saving}
            >
              {saving ? '保存中…' : '保存标准'}
            </button>
            <button
              type="button"
              className="mt-btn"
              data-testid="reload-standard"
              onClick={() => loadCurrent(draft.font, draft.sizeName)}
            >
              载入现行标准
            </button>
            <span className="mt-hint">
              保存生成新版本；同日两人修改时，晚保存的会看到差异提示。
            </span>
          </div>
        </form>

        {conflict ? (
          <div
            className="mx-4 mb-4 rounded border border-brass/50 bg-brass-pale/60 px-4 py-3"
            data-testid="standard-conflict"
            role="alert"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-song text-sm font-semibold text-brass">
                标准已被他人修改：库中现行 v{conflict.current?.version ?? '—'}
                {conflict.current
                  ? `（${conflict.current.updatedBy} · ${formatStamp(conflict.current.createdAt)}）`
                  : ''}
                ，你基于 v{draft.baseVersion} 填写。
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="mt-btn mt-btn-primary"
                  data-testid="conflict-override"
                  disabled={saving}
                  onClick={handleOverride}
                >
                  以我的填写覆盖入库
                </button>
                <button
                  type="button"
                  className="mt-btn"
                  data-testid="conflict-discard"
                  onClick={() => loadCurrent(draft.font, draft.sizeName)}
                >
                  放弃修改，载入现行
                </button>
              </div>
            </div>
            <table className="mt-3 min-w-full" data-testid="conflict-diff-table">
              <thead>
                <tr className="border-b border-brass/30 text-left text-[11px] text-ink-mute">
                  <th className="py-1 pr-3 font-medium">字段</th>
                  <th className="py-1 pr-3 font-medium">我的填写</th>
                  <th className="py-1 font-medium">库中现行</th>
                </tr>
              </thead>
              <tbody className="text-xs">
                {conflict.diff.map((row) => (
                  <tr
                    key={row.key}
                    className={row.changed ? 'bg-seal-pale/50 text-seal' : 'text-ink-soft'}
                    data-testid={`conflict-row-${row.key}`}
                    data-changed={row.changed}
                  >
                    <td className="py-1 pr-3">{row.label}</td>
                    <td className="py-1 pr-3 font-medium">{row.mine}</td>
                    <td className="py-1">{row.current}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">现行标准</h3>
          <span className="mt-sub">按字体 + 字号各取最新版本</span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full" data-testid="standard-table">
            <thead className="border-b border-paper-line bg-paper/60">
              <tr>
                <th className="mt-th">字体 / 字号</th>
                <th className="mt-th">推荐压力</th>
                <th className="mt-th">用墨</th>
                <th className="mt-th">最少印次</th>
                <th className="mt-th">生效日期</th>
                <th className="mt-th">版本</th>
                <th className="mt-th">修改人</th>
                <th className="mt-th">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-line">
              {current.length === 0 ? (
                <tr>
                  <td className="mt-td text-ink-mute" colSpan={8}>
                    暂无工艺标准，请先在上方登记。
                  </td>
                </tr>
              ) : (
                current.map((s) => (
                  <tr key={s.id} data-testid={`standard-row-${s.font}-${s.sizeName}`}>
                    <td className="mt-td font-song text-ink">
                      {s.font} · {s.sizeName}
                    </td>
                    <td className="mt-td">
                      {s.pressureMinKg}–{s.pressureMaxKg} kg
                    </td>
                    <td className="mt-td">{s.ink}</td>
                    <td className="mt-td">{s.minImpressions}</td>
                    <td className="mt-td">{formatDate(s.effectiveDate)}</td>
                    <td className="mt-td">
                      <span className="mt-chip">v{s.version}</span>
                    </td>
                    <td className="mt-td">{dash(s.updatedBy)}</td>
                    <td className="mt-td">
                      <button
                        type="button"
                        className="mt-btn mt-btn-ghost"
                        data-testid={`edit-standard-${s.font}-${s.sizeName}`}
                        onClick={() => loadCurrent(s.font, s.sizeName)}
                      >
                        修订
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">版本沿革</h3>
          <span className="mt-sub">试印按试印日期匹配当时生效的版本判定</span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full" data-testid="standard-history-table">
            <thead className="border-b border-paper-line bg-paper/60">
              <tr>
                <th className="mt-th">版本</th>
                <th className="mt-th">字体 / 字号</th>
                <th className="mt-th">推荐压力</th>
                <th className="mt-th">用墨</th>
                <th className="mt-th">最少印次</th>
                <th className="mt-th">生效日期</th>
                <th className="mt-th">修改人</th>
                <th className="mt-th">保存时间</th>
                <th className="mt-th">备注</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-line">
              {history.length === 0 ? (
                <tr>
                  <td className="mt-td text-ink-mute" colSpan={9}>
                    暂无历史版本。
                  </td>
                </tr>
              ) : (
                history.map((s) => (
                  <tr key={s.id} data-testid={`standard-history-${s.id}`}>
                    <td className="mt-td">
                      <span className="mt-chip">v{s.version}</span>
                    </td>
                    <td className="mt-td font-song text-ink">
                      {s.font} · {s.sizeName}
                    </td>
                    <td className="mt-td">
                      {s.pressureMinKg}–{s.pressureMaxKg} kg
                    </td>
                    <td className="mt-td">{s.ink}</td>
                    <td className="mt-td">{s.minImpressions}</td>
                    <td className="mt-td">{formatDate(s.effectiveDate)}</td>
                    <td className="mt-td">{dash(s.updatedBy)}</td>
                    <td className="mt-td">{formatStamp(s.createdAt)}</td>
                    <td className="mt-td max-w-[220px] truncate" title={s.note}>
                      {dash(s.note)}
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

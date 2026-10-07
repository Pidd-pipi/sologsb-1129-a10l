import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import EmptyState from '../components/common/EmptyState';
import VerdictBadge from '../components/common/VerdictBadge';
import { DRAFT_KEYS, useLocalDraft } from '../hooks/useLocalDraft';
import { useMatrixStore } from '../stores/matrixStore';
import { useUiStore } from '../stores/uiStore';
import { MATRIX_FONTS, MATRIX_SIZE_NAMES, type MatrixFont } from '../types/matrix';
import {
  CLARITY_LEVELS,
  IMPRESSION_RANGE,
  PRESSURE_RANGE,
  PROOF_TARGET_KINDS,
  validateProofInput,
  type ClarityLevel,
  type ProofInput,
  type ProofTargetKind,
} from '../types/proof';
import { judgeProofByStandard, standardAtDate } from '../types/standard';
import { dash, formatDate, suggestSampleNo, todayStr } from '../utils/format';

interface ProofFormState {
  targetKind: ProofTargetKind;
  matrixId: string;
  targetRef: string;
  font: MatrixFont | '';
  sizeName: string;
  pressureKg: string;
  ink: string;
  impressions: string;
  sampleNo: string;
  clarity: ClarityLevel;
  proofDate: string;
  note: string;
}

/** `/proofs` 试印记录：登记压力、用墨与清晰度，对照工艺标准判定达标 / 偏淡 / 糊版，可留档冻结判定 */
export default function ProofList() {
  const matrices = useMatrixStore((s) => s.matrices);
  const proofs = useMatrixStore((s) => s.proofs);
  const standards = useMatrixStore((s) => s.standards);
  const proofCount = useMatrixStore((s) => s.proofs.length);
  const addProof = useMatrixStore((s) => s.addProof);
  const toggleProofArchived = useMatrixStore((s) => s.toggleProofArchived);
  const pushToast = useUiStore((s) => s.pushToast);
  const sampleQuery = useUiStore((s) => s.sampleQuery);
  const setSampleQuery = useUiStore((s) => s.setSampleQuery);

  const { draft, patch, reset, savedAt, existed } = useLocalDraft<ProofFormState>(
    DRAFT_KEYS.proofNew,
    {
      targetKind: '字符',
      matrixId: '',
      targetRef: '',
      font: '宋体',
      sizeName: '五号',
      pressureKg: '12.5',
      ink: '油烟墨 101',
      impressions: '40',
      sampleNo: suggestSampleNo(todayStr(), 1),
      clarity: '清晰',
      proofDate: todayStr(),
      note: '',
    },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!draft.matrixId && matrices.length > 0) patch({ matrixId: matrices[0].id });
  }, [draft.matrixId, matrices, patch]);

  const selectedMatrix = matrices.find((m) => m.id === draft.matrixId);

  useEffect(() => {
    if (draft.targetKind === '字符' && selectedMatrix) {
      patch({
        targetRef: selectedMatrix.character,
        font: selectedMatrix.font,
        sizeName: selectedMatrix.sizeName,
      });
    }
  }, [draft.targetKind, selectedMatrix, patch]);

  /** 按试印日期匹配当时生效的标准；登记前实时给出预判 */
  const matchedStandard = useMemo(
    () => standardAtDate(standards, draft.font, draft.sizeName, draft.proofDate),
    [standards, draft.font, draft.sizeName, draft.proofDate],
  );
  const previewVerdict = useMemo(() => {
    if (!matchedStandard) return '未定标' as const;
    const p = Number(draft.pressureKg);
    const n = Number(draft.impressions);
    if (!Number.isFinite(p) || !Number.isInteger(n)) return '未定标' as const;
    return judgeProofByStandard({ pressureKg: p, ink: draft.ink, impressions: n }, matchedStandard);
  }, [matchedStandard, draft.pressureKg, draft.ink, draft.impressions]);

  const traced = useMemo(() => {
    const q = sampleQuery.trim().toLowerCase();
    if (!q) return [];
    return proofs.filter(
      (p) => p.sampleNo.toLowerCase().includes(q) || p.targetRef.toLowerCase().includes(q),
    );
  }, [proofs, sampleQuery]);

  const clarityStats = useMemo(() => {
    const out: Record<string, number> = {};
    proofs.forEach((p) => {
      out[p.clarity] = (out[p.clarity] ?? 0) + 1;
    });
    return out;
  }, [proofs]);

  const verdictStats = useMemo(() => {
    const out: Record<string, number> = {};
    proofs.forEach((p) => {
      out[p.verdict] = (out[p.verdict] ?? 0) + 1;
    });
    return out;
  }, [proofs]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const input: ProofInput = {
      targetKind: draft.targetKind,
      targetRef: draft.targetRef,
      matrixId: draft.targetKind === '字符' ? draft.matrixId : '',
      font: draft.font,
      sizeName: draft.sizeName,
      pressureKg: Number(draft.pressureKg),
      ink: draft.ink,
      impressions: Number(draft.impressions),
      sampleNo: draft.sampleNo,
      clarity: draft.clarity,
      proofDate: draft.proofDate,
      note: draft.note,
    };
    const next = validateProofInput(input);
    setErrors(next);
    if (Object.keys(next).length > 0) {
      pushToast('试印登记未通过校验，请按提示修正', 'warn');
      return;
    }
    const row = await addProof(input);
    pushToast(`已登记试印样张 ${input.sampleNo}，判定：${row.verdict}`);
    patch({
      note: '',
      sampleNo: suggestSampleNo(todayStr(), proofs.length + 2),
    });
    setErrors({});
  };

  const sortedProofs = useMemo(
    () => [...proofs].sort((a, b) => (a.proofDate < b.proofDate ? 1 : -1)),
    [proofs],
  );

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="proof-list-title">
            试印记录
          </h2>
          <p className="mt-sub">
            登记压力（0.5–60 kg）、用墨与清晰度，对照工艺标准判定达标 / 偏淡 / 糊版；标准改动后未留档的试印跟着重算。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="mt-chip" data-testid="proof-total">
            试印 {proofCount} 条
          </span>
          {CLARITY_LEVELS.map((c) => (
            <span key={c} className="mt-chip">
              {c} {clarityStats[c] ?? 0}
            </span>
          ))}
          {(['达标', '偏淡', '糊版', '未定标'] as const).map((v) => (
            <span key={v} className="mt-chip" data-testid={`verdict-stat-${v}`}>
              {v} {verdictStats[v] ?? 0}
            </span>
          ))}
        </div>
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">登记试印结果</h3>
          <span className="mt-sub" data-testid="proof-draft-status">
            {existed ? `草稿已恢复 · ${savedAt || '—'}` : `草稿自动保存 ${savedAt || '—'}`}
          </span>
        </div>
        <form className="space-y-3 px-4 py-4" onSubmit={handleSubmit} data-testid="proof-form">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div>
              <label className="mt-label" htmlFor="proof-target-kind">
                试印对象
              </label>
              <select
                id="proof-target-kind"
                data-testid="proof-target-kind"
                className="mt-input"
                value={draft.targetKind}
                onChange={(e) => patch({ targetKind: e.target.value as ProofTargetKind })}
              >
                {PROOF_TARGET_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="mt-label" htmlFor="proof-matrix-select">
                关联字模
              </label>
              <select
                id="proof-matrix-select"
                data-testid="proof-matrix-select"
                className="mt-input"
                value={draft.matrixId}
                disabled={draft.targetKind === '字盘'}
                onChange={(e) => patch({ matrixId: e.target.value })}
              >
                <option value="">不关联具体字模</option>
                {matrices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.character} · {m.code} · {m.font}/{m.sizeName}
                  </option>
                ))}
              </select>
              {errors.matrixId ? <p className="mt-error">{errors.matrixId}</p> : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="proof-target-ref">
                字符 / 字盘编号
              </label>
              <input
                id="proof-target-ref"
                data-testid="proof-target-ref"
                className="mt-input"
                placeholder={draft.targetKind === '字盘' ? '例：ZP-A-01' : '例：活'}
                value={draft.targetRef}
                onChange={(e) => patch({ targetRef: e.target.value })}
              />
              {errors.targetRef ? (
                <p className="mt-error" data-testid="error-targetRef">
                  {errors.targetRef}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="proof-font">
                判定字体
              </label>
              <select
                id="proof-font"
                data-testid="proof-font"
                className="mt-input"
                value={draft.font}
                onChange={(e) => patch({ font: e.target.value as MatrixFont })}
              >
                {MATRIX_FONTS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              {errors.font ? (
                <p className="mt-error" data-testid="error-font">
                  {errors.font}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="proof-size">
                判定字号
              </label>
              <select
                id="proof-size"
                data-testid="proof-size"
                className="mt-input"
                value={draft.sizeName}
                onChange={(e) => patch({ sizeName: e.target.value })}
              >
                {MATRIX_SIZE_NAMES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {errors.sizeName ? (
                <p className="mt-error" data-testid="error-sizeName">
                  {errors.sizeName}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="proof-pressure-input">
                压力 kg
              </label>
              <input
                id="proof-pressure-input"
                data-testid="proof-pressure-input"
                className="mt-input"
                type="number"
                min={PRESSURE_RANGE.min}
                max={PRESSURE_RANGE.max}
                step={0.5}
                value={draft.pressureKg}
                onChange={(e) => patch({ pressureKg: e.target.value })}
              />
              {errors.pressureKg ? (
                <p className="mt-error" data-testid="error-pressureKg">
                  {errors.pressureKg}
                </p>
              ) : (
                <p className="mt-hint">
                  {PRESSURE_RANGE.min}–{PRESSURE_RANGE.max} kg
                </p>
              )}
            </div>
            <div>
              <label className="mt-label" htmlFor="proof-ink-input">
                用墨
              </label>
              <input
                id="proof-ink-input"
                data-testid="proof-ink-input"
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
              <label className="mt-label" htmlFor="proof-impressions-input">
                印次
              </label>
              <input
                id="proof-impressions-input"
                data-testid="proof-impressions-input"
                className="mt-input"
                type="number"
                min={IMPRESSION_RANGE.min}
                max={IMPRESSION_RANGE.max}
                step={1}
                value={draft.impressions}
                onChange={(e) => patch({ impressions: e.target.value })}
              />
              {errors.impressions ? (
                <p className="mt-error" data-testid="error-impressions">
                  {errors.impressions}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="proof-clarity-select">
                清晰度评价
              </label>
              <select
                id="proof-clarity-select"
                data-testid="proof-clarity-select"
                className="mt-input"
                value={draft.clarity}
                onChange={(e) => patch({ clarity: e.target.value as ClarityLevel })}
              >
                {CLARITY_LEVELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="mt-label" htmlFor="proof-sampleno-input">
                样张编号
              </label>
              <div className="flex gap-2">
                <input
                  id="proof-sampleno-input"
                  data-testid="proof-sampleno-input"
                  className="mt-input"
                  value={draft.sampleNo}
                  onChange={(e) => patch({ sampleNo: e.target.value })}
                />
                <button
                  type="button"
                  className="mt-btn whitespace-nowrap"
                  data-testid="suggest-sample-btn"
                  onClick={() => patch({ sampleNo: suggestSampleNo(draft.proofDate, proofs.length + 1) })}
                >
                  按日期生成
                </button>
              </div>
              {errors.sampleNo ? (
                <p className="mt-error" data-testid="error-sampleNo">
                  {errors.sampleNo}
                </p>
              ) : null}
            </div>
            <div>
              <label className="mt-label" htmlFor="proof-date-input">
                试印日期
              </label>
              <input
                id="proof-date-input"
                data-testid="proof-date-input"
                type="date"
                className="mt-input"
                value={draft.proofDate}
                onChange={(e) => patch({ proofDate: e.target.value })}
              />
              {errors.proofDate ? (
                <p className="mt-error" data-testid="error-proofDate">
                  {errors.proofDate}
                </p>
              ) : null}
            </div>
            <div className="md:col-span-4">
              <label className="mt-label" htmlFor="proof-note-input">
                备注
              </label>
              <input
                id="proof-note-input"
                data-testid="proof-note-input"
                className="mt-input"
                placeholder="例：压力偏低，建议加压至 12kg"
                value={draft.note}
                onChange={(e) => patch({ note: e.target.value })}
              />
            </div>
            <div className="md:col-span-4">
              {matchedStandard ? (
                <p
                  className="rounded border border-paper-line bg-paper/50 px-3 py-2 text-xs text-ink-soft"
                  data-testid="proof-standard-hint"
                >
                  对照标准 v{matchedStandard.version}（{formatDate(matchedStandard.effectiveDate)}{' '}
                  起生效）：压力 {matchedStandard.pressureMinKg}–{matchedStandard.pressureMaxKg} kg ·
                  用墨 {matchedStandard.ink} · 印次 ≥{matchedStandard.minImpressions}；当前填写预判：
                  <span className="font-medium text-ink">{previewVerdict}</span>
                </p>
              ) : (
                <p
                  className="rounded border border-dashed border-paper-line bg-paper/30 px-3 py-2 text-xs text-ink-mute"
                  data-testid="proof-standard-hint"
                >
                  {draft.font} / {draft.sizeName} 在 {formatDate(draft.proofDate)}{' '}
                  前没有生效的工艺标准，登记后判定记为「未定标」，可先到「工艺标准」页登记。
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="mt-btn mt-btn-primary" data-testid="submit-proof">
              登记试印
            </button>
            <button
              type="button"
              className="mt-btn"
              data-testid="reset-proof-draft"
              onClick={() => {
                reset();
                setErrors({});
                pushToast('已清空试印登记草稿', 'warn');
              }}
            >
              清空草稿
            </button>
            <span className="mt-hint">
              当前对象：{draft.targetKind} · {dash(draft.targetRef)}
            </span>
          </div>
        </form>
      </section>

      <section className="mt-panel" data-testid="trace-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">按样张编号回溯</h3>
          <input
            className="mt-input max-w-[240px]"
            placeholder="输入样张编号片段，例：YZ-2025"
            data-testid="sample-search-input"
            value={sampleQuery}
            onChange={(e) => setSampleQuery(e.target.value)}
          />
        </div>
        <div className="px-4 py-3">
          {sampleQuery.trim() === '' ? (
            <p className="text-xs text-ink-mute">输入样张编号或字符即可回溯试印批次与对应字模。</p>
          ) : traced.length === 0 ? (
            <EmptyState
              title="没有匹配的试印记录"
              description="请检查样张编号片段，或先登记一条试印记录。"
              testId="trace-empty"
            />
          ) : (
            <ul className="space-y-2" data-testid="sample-search-result">
              {traced.map((p) => (
                <li key={p.id} className="rounded border border-paper-line bg-paper/40 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-song text-sm text-ink">{p.sampleNo}</span>
                    <span className="mt-chip">{p.clarity}</span>
                    <VerdictBadge
                      verdict={p.verdict}
                      standardVersion={p.standardVersion}
                      archived={p.archived}
                      testId={`trace-verdict-${p.id}`}
                    />
                    <span className="text-ink-mute">{formatDate(p.proofDate)}</span>
                    <span className="text-ink-soft">
                      {p.pressureKg} kg · {p.ink} · 印次 {p.impressions}
                    </span>
                    {p.matrixId ? (
                      <Link className="mt-btn mt-btn-ghost" to={`/matrices/${p.matrixId}`} data-testid={`trace-matrix-${p.id}`}>
                        回溯字模
                      </Link>
                    ) : (
                      <span className="text-ink-mute">整盘试印，未关联单枚字模</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">试印台账</h3>
          <span className="mt-sub">共 {proofs.length} 条</span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full" data-testid="proof-table">
            <thead className="border-b border-paper-line bg-paper/60">
              <tr>
                <th className="mt-th">样张编号</th>
                <th className="mt-th">对象</th>
                <th className="mt-th">压力 / 用墨</th>
                <th className="mt-th">印次</th>
                <th className="mt-th">清晰度</th>
                <th className="mt-th">判定</th>
                <th className="mt-th">试印日期</th>
                <th className="mt-th">字模</th>
                <th className="mt-th">留档</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-paper-line">
              {sortedProofs.length === 0 ? (
                <tr>
                  <td className="mt-td text-ink-mute" colSpan={9}>
                    暂无试印记录。
                  </td>
                </tr>
              ) : (
                sortedProofs.map((p) => (
                  <tr key={p.id} data-testid={`proof-row-${p.id}`}>
                    <td className="mt-td font-song text-ink">{p.sampleNo}</td>
                    <td className="mt-td">
                      {p.targetKind} · {p.targetRef}
                    </td>
                    <td className="mt-td">
                      {p.pressureKg} kg · {p.ink}
                    </td>
                    <td className="mt-td">{p.impressions}</td>
                    <td className="mt-td">
                      <span
                        className={`mt-chip ${
                          p.clarity === '清晰'
                            ? 'border-jade/40 text-jade'
                            : p.clarity === '偏淡'
                              ? 'border-brass/40 text-brass'
                              : 'border-seal/40 text-seal'
                        }`}
                      >
                        {p.clarity}
                      </span>
                    </td>
                    <td className="mt-td">
                      <VerdictBadge
                        verdict={p.verdict}
                        standardVersion={p.standardVersion}
                        archived={p.archived}
                        testId={`proof-verdict-${p.id}`}
                      />
                    </td>
                    <td className="mt-td">{formatDate(p.proofDate)}</td>
                    <td className="mt-td">
                      {p.matrixId ? (
                        <Link
                          className="text-seal hover:underline"
                          to={`/matrices/${p.matrixId}`}
                          data-testid={`proof-matrix-link-${p.id}`}
                        >
                          查看字模
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="mt-td">
                      <button
                        type="button"
                        className={`mt-btn ${p.archived ? 'border-jade/40 text-jade' : ''}`}
                        data-testid={`proof-archive-${p.id}`}
                        onClick={() => {
                          void toggleProofArchived(p.id, !p.archived);
                          pushToast(
                            p.archived
                              ? `样张 ${p.sampleNo} 已取消留档，将随标准改动重算`
                              : `样张 ${p.sampleNo} 已留档，判定冻结不再倒推`,
                          );
                        }}
                      >
                        {p.archived ? '取消留档' : '留档'}
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

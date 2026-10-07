/** 试印工艺标准（ProofStandard）：按字体 + 字号登记的推荐压力区间、用墨与最少印次 */
import type { MatrixFont, MatrixSizeName } from './matrix';
import { IMPRESSION_RANGE, PRESSURE_RANGE } from './proof';

/** 试印判定结果：达标 / 偏淡 / 糊版；未定标表示找不到适用标准 */
export const PROOF_VERDICTS = ['达标', '偏淡', '糊版', '未定标'] as const;
export type ProofVerdict = (typeof PROOF_VERDICTS)[number];

/**
 * 工艺标准按版本保存：每次修改新增一行（同字体 + 字号下 version 递增），
 * 旧版本保留用于按试印日期回溯当时生效的标准。
 */
export interface ProofStandard {
  id: string;
  font: MatrixFont;
  sizeName: MatrixSizeName;
  /** 推荐压力区间 kg */
  pressureMinKg: number;
  pressureMaxKg: number;
  /** 推荐用墨 */
  ink: string;
  /** 最少印次 */
  minImpressions: number;
  /** 生效日期 YYYY-MM-DD，按试印日期匹配时以此为界 */
  effectiveDate: string;
  /** 同字体 + 字号下从 1 递增；保存时做乐观锁校验 */
  version: number;
  /** 修改人 */
  updatedBy: string;
  note: string;
  createdAt: string;
}

export interface ProofStandardInput {
  font: MatrixFont;
  sizeName: MatrixSizeName;
  pressureMinKg: number;
  pressureMaxKg: number;
  ink: string;
  minImpressions: number;
  effectiveDate: string;
  updatedBy: string;
  note?: string;
}

/**
 * 对照标准判定试印结果（纯函数，迁移 / 登记 / 重算共用）：
 * 压力低于下限或印次不足 → 偏淡；压力高于上限 → 糊版；用墨不符 → 糊版；其余达标。
 */
export function judgeProofByStandard(
  proof: { pressureKg: number; ink: string; impressions: number },
  standard: Pick<ProofStandard, 'pressureMinKg' | 'pressureMaxKg' | 'ink' | 'minImpressions'>,
): Exclude<ProofVerdict, '未定标'> {
  if (proof.pressureKg < standard.pressureMinKg || proof.impressions < standard.minImpressions) {
    return '偏淡';
  }
  if (proof.pressureKg > standard.pressureMaxKg) return '糊版';
  if (proof.ink.trim() !== standard.ink.trim()) return '糊版';
  return '达标';
}

/** 取某字体 + 字号在指定日期生效的标准版本；找不到返回 undefined（判定记未定标） */
export function standardAtDate(
  standards: ProofStandard[],
  font: string,
  sizeName: string,
  date: string,
): ProofStandard | undefined {
  if (!font || !sizeName || !date) return undefined;
  return standards
    .filter((s) => s.font === font && s.sizeName === sizeName && s.effectiveDate <= date)
    .sort((a, b) =>
      a.effectiveDate === b.effectiveDate
        ? b.version - a.version
        : a.effectiveDate < b.effectiveDate
          ? 1
          : -1,
    )[0];
}

/** 取某字体 + 字号的最新版本（编辑基准与乐观锁校验用）；无则 undefined */
export function latestStandard(
  standards: ProofStandard[],
  font: string,
  sizeName: string,
): ProofStandard | undefined {
  let latest: ProofStandard | undefined;
  for (const s of standards) {
    if (s.font !== font || s.sizeName !== sizeName) continue;
    if (!latest || s.version > latest.version) latest = s;
  }
  return latest;
}

/** 全部字体 + 字号组合的现行标准（每组取最新版本），按字体 / 字号排序 */
export function currentStandards(standards: ProofStandard[]): ProofStandard[] {
  const byGroup = new Map<string, ProofStandard>();
  for (const s of standards) {
    const key = `${s.font}/${s.sizeName}`;
    const cur = byGroup.get(key);
    if (!cur || s.version > cur.version) byGroup.set(key, s);
  }
  return [...byGroup.values()].sort((a, b) =>
    a.font === b.font ? (a.sizeName < b.sizeName ? -1 : 1) : a.font < b.font ? -1 : 1,
  );
}

/** 标准表单校验：返回逐字段错误信息，空对象表示通过 */
export function validateProofStandardInput(
  input: Partial<ProofStandardInput>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.font) errors.font = '请选择字体';
  if (!input.sizeName) errors.sizeName = '请选择字号';
  const min = Number(input.pressureMinKg);
  const max = Number(input.pressureMaxKg);
  if (!Number.isFinite(min) || min < PRESSURE_RANGE.min || min > PRESSURE_RANGE.max) {
    errors.pressureMinKg = `压力下限需在 ${PRESSURE_RANGE.min}–${PRESSURE_RANGE.max} kg 之间`;
  }
  if (!Number.isFinite(max) || max < PRESSURE_RANGE.min || max > PRESSURE_RANGE.max) {
    errors.pressureMaxKg = `压力上限需在 ${PRESSURE_RANGE.min}–${PRESSURE_RANGE.max} kg 之间`;
  }
  if (!errors.pressureMinKg && !errors.pressureMaxKg && min >= max) {
    errors.pressureMaxKg = '压力上限需大于下限';
  }
  if (!(input.ink || '').trim()) errors.ink = '请填写推荐用墨';
  const n = Number(input.minImpressions);
  if (!Number.isInteger(n) || n < IMPRESSION_RANGE.min || n > IMPRESSION_RANGE.max) {
    errors.minImpressions = `最少印次需在 ${IMPRESSION_RANGE.min}–${IMPRESSION_RANGE.max} 之间`;
  }
  const d = (input.effectiveDate || '').trim();
  if (!d) errors.effectiveDate = '请填写生效日期';
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.effectiveDate = '日期格式需为 YYYY-MM-DD';
  if (!(input.updatedBy || '').trim()) errors.updatedBy = '请填写修改人';
  return errors;
}

/** 字段级差异：两人同时修改标准时，向晚保存者展示「我的填写」与「库中现行」的对照 */
export interface StandardFieldDiff {
  key: string;
  label: string;
  mine: string;
  current: string;
  changed: boolean;
}

export function diffStandard(mine: ProofStandardInput, current: ProofStandard): StandardFieldDiff[] {
  const rows: Array<[string, string, string | number, string | number]> = [
    ['pressureMinKg', '压力下限 kg', mine.pressureMinKg, current.pressureMinKg],
    ['pressureMaxKg', '压力上限 kg', mine.pressureMaxKg, current.pressureMaxKg],
    ['ink', '推荐用墨', mine.ink, current.ink],
    ['minImpressions', '最少印次', mine.minImpressions, current.minImpressions],
    ['effectiveDate', '生效日期', mine.effectiveDate, current.effectiveDate],
    ['note', '备注', (mine.note ?? '').trim(), current.note],
  ];
  return rows.map(([key, label, a, b]) => ({
    key,
    label,
    mine: String(a ?? '') || '—',
    current: String(b ?? '') || '—',
    changed: String(a ?? '') !== String(b ?? ''),
  }));
}

/** 保存标准时版本已被他人推进：携带库中现行版本，交由页面展示差异 */
export class StandardConflictError extends Error {
  /** 库中现行版本（理论上必存在，防御性允许为空） */
  current?: ProofStandard;

  constructor(current?: ProofStandard) {
    super('该标准已被他人修改，请核对差异后再入库');
    this.name = 'StandardConflictError';
    this.current = current;
  }
}

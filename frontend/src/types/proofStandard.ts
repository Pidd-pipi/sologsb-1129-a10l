/** 试印工艺标准（ProofStandard）：按字体 + 字号登记推荐压力区间、用墨与最少印次 */
import { IMPRESSION_RANGE, PRESSURE_RANGE } from './proof';
import type { StandardVerdict } from './proof';
import { MATRIX_FONTS, MATRIX_SIZE_NAMES } from './matrix';

/** 标准按「字体 + 字号」唯一分组；每组标准保留一条记录，保存即升版本 */
export interface ProofStandard {
  id: string;
  font: string;
  sizeName: string;
  /** 推荐压力下限 kg（含） */
  pressureMinKg: number;
  /** 推荐压力上限 kg（含） */
  pressureMaxKg: number;
  /** 推荐用墨（如 油烟墨 101），登记试印时默认带入并参与判墨 */
  ink: string;
  /** 最少印次 */
  minImpressions: number;
  /** 每次保存自增；乐观并发以它为依据 */
  version: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProofStandardInput {
  font: string;
  sizeName: string;
  pressureMinKg: number;
  pressureMaxKg: number;
  ink: string;
  minImpressions: number;
  note?: string;
}

/** 标准分组键：字体|字号 */
export function standardKey(font: string, sizeName: string): string {
  return `${font}|${sizeName}`;
}

export function standardKeyOf(s: Pick<ProofStandard, 'font' | 'sizeName'>): string {
  return standardKey(s.font, s.sizeName);
}

/** 试印匹配标准时用的分组键；字模缺失（整盘试印）时为空串 */
export function proofStandardKey(matrix?: { font: string; sizeName: string }): string {
  return matrix ? standardKey(matrix.font, matrix.sizeName) : '';
}

/** 晚保存者比对差异时的单行变化 */
export interface StandardFieldDiff {
  label: string;
  before: string;
  after: string;
}

/** 两份标准逐字段比对（以库里的现行值为基准、编辑稿为新值） */
export function diffStandard(current: ProofStandard, draft: ProofStandardInput): StandardFieldDiff[] {
  const rows: Array<[string, string, string]> = [
    ['推荐压力下限 kg', `${current.pressureMinKg}`, `${draft.pressureMinKg}`],
    ['推荐压力上限 kg', `${current.pressureMaxKg}`, `${draft.pressureMaxKg}`],
    ['推荐用墨', current.ink, draft.ink.trim()],
    ['最少印次', `${current.minImpressions}`, `${draft.minImpressions}`],
    ['备注', current.note || '—', (draft.note ?? '').trim() || '—'],
  ];
  return rows
    .filter(([, before, after]) => before !== after)
    .map(([label, before, after]) => ({ label, before, after }));
}

export function validateStandardInput(input: Partial<ProofStandardInput>): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.font) errors.font = '请选择字体';
  if (!input.sizeName) errors.sizeName = '请选择字号';
  const lo = Number(input.pressureMinKg);
  const hi = Number(input.pressureMaxKg);
  if (!Number.isFinite(lo) || lo < PRESSURE_RANGE.min || lo > PRESSURE_RANGE.max) {
    errors.pressureMinKg = `压力下限需在 ${PRESSURE_RANGE.min}–${PRESSURE_RANGE.max} kg 之间`;
  }
  if (!Number.isFinite(hi) || hi < PRESSURE_RANGE.min || hi > PRESSURE_RANGE.max) {
    errors.pressureMaxKg = `压力上限需在 ${PRESSURE_RANGE.min}–${PRESSURE_RANGE.max} kg 之间`;
  }
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi) {
    errors.pressureMinKg = '压力下限不能高于上限';
  }
  if (!(input.ink || '').trim()) errors.ink = '请填写推荐用墨';
  const n = Number(input.minImpressions);
  if (!Number.isInteger(n) || n < IMPRESSION_RANGE.min || n > IMPRESSION_RANGE.max) {
    errors.minImpressions = `最少印次需在 ${IMPRESSION_RANGE.min}–${IMPRESSION_RANGE.max} 之间`;
  }
  return errors;
}

/** 判定结论加原因明细 */
export interface JudgeResult {
  verdict: StandardVerdict;
  reasons: string[];
}

/**
 * 按某条标准判定一次试印：
 * - 压力高于上限 → 糊版
 * - 压力低于下限 / 印次不足 / 用墨不符 → 偏淡
 * - 全部落在推荐范围内 → 达标
 * 找不到适用标准时调用方判「未定标」，本函数不处理该情况。
 */
export function judgeByStandard(
  s: Pick<ProofStandard, 'pressureMinKg' | 'pressureMaxKg' | 'ink' | 'minImpressions'>,
  proof: { pressureKg: number; ink: string; impressions: number },
): JudgeResult {
  if (proof.pressureKg > s.pressureMaxKg) {
    return {
      verdict: '糊版',
      reasons: [`压力 ${proof.pressureKg}kg 高于推荐上限 ${s.pressureMaxKg}kg`],
    };
  }
  const reasons: string[] = [];
  if (proof.pressureKg < s.pressureMinKg) {
    reasons.push(`压力 ${proof.pressureKg}kg 低于推荐下限 ${s.pressureMinKg}kg`);
  }
  if (proof.impressions < s.minImpressions) {
    reasons.push(`印次 ${proof.impressions} 少于最少印次 ${s.minImpressions}`);
  }
  if (proof.ink.trim() !== s.ink.trim()) {
    reasons.push(`用墨「${proof.ink.trim()}」与推荐用墨「${s.ink.trim()}」不符`);
  }
  return reasons.length > 0
    ? { verdict: '偏淡', reasons }
    : { verdict: '达标', reasons: ['压力、用墨与印次均落在推荐范围内'] };
}

/** 标准编辑表单的可选字体 / 字号 */
export const STANDARD_FONT_OPTIONS = MATRIX_FONTS;
export const STANDARD_SIZE_OPTIONS = MATRIX_SIZE_NAMES;

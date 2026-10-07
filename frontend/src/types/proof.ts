/** 试印记录（ProofRecord）：单字或整盘试印的压力、用墨、样张与按工艺标准的判定 */

/** 试印对象类型：单字试印 / 整盘试印 */
export const PROOF_TARGET_KINDS = ['字符', '字盘'] as const;
export type ProofTargetKind = (typeof PROOF_TARGET_KINDS)[number];

/** 人工观察到的清晰度评价（标准实施前的旧字段，保留为观察值，正式判定走 verdict） */
export const CLARITY_LEVELS = ['清晰', '偏淡', '糊版'] as const;
export type ClarityLevel = (typeof CLARITY_LEVELS)[number];

/** 按试印工艺标准判定的结论；找不到适用标准时为「未定标」 */
export const STANDARD_VERDICTS = ['达标', '偏淡', '糊版', '未定标'] as const;
export type StandardVerdict = (typeof STANDARD_VERDICTS)[number];

/** 压力 / 印次合法区间 */
export const PRESSURE_RANGE = { min: 0.5, max: 60 } as const;
export const IMPRESSION_RANGE = { min: 1, max: 999 } as const;

/**
 * 判定所依据的标准快照：登记 / 重算时从当时匹配的标准拷贝过来。
 * 展示一律读快照，不回头关联现行标准；已留档的样张连快照一起冻结。
 */
export interface ProofStandardSnapshot {
  /** 命中的标准 id；空串表示未定标 */
  standardId: string;
  standardVersion: number;
  /** 标准分组键（字体|字号），未定标时为空串 */
  standardKey: string;
  standardPressureMinKg: number;
  standardPressureMaxKg: number;
  standardInk: string;
  standardMinImpressions: number;
}

export function emptyStandardSnapshot(): ProofStandardSnapshot {
  return {
    standardId: '',
    standardVersion: 0,
    standardKey: '',
    standardPressureMinKg: 0,
    standardPressureMaxKg: 0,
    standardInk: '',
    standardMinImpressions: 0,
  };
}

export interface ProofRecord extends ProofStandardSnapshot {
  id: string;
  /** 字符或字盘 */
  targetKind: ProofTargetKind;
  /** 字符内容或字盘编号 */
  targetRef: string;
  /** 关联字模 id（整盘试印时可为空） */
  matrixId: string;
  /** 压力 kg */
  pressureKg: number;
  /** 用墨 */
  ink: string;
  /** 印次 */
  impressions: number;
  /** 样张编号，用于回溯试印批次 */
  sampleNo: string;
  /** 人工观察清晰度（观察值，不作为是否达标的正式判据） */
  clarity: ClarityLevel;
  /** 按试印工艺标准计算出的判定 */
  verdict: StandardVerdict;
  /** 判定原因明细（如「压力低于推荐下限」「印次少于最少印次」），未定标时给出原因 */
  judgeReasons: string[];
  /** 试印日期 YYYY-MM-DD */
  proofDate: string;
  note: string;
  /** 判定最近一次计算 / 重算的时间 ISO */
  judgedAt: string;
  /** 是否已留档：留档后判定冻结，标准改动不再倒推 */
  archived: boolean;
  /** 留档时间 ISO，未留档为空串 */
  archivedAt: string;
  createdAt: string;
}

export interface ProofInput {
  targetKind: ProofTargetKind;
  targetRef: string;
  matrixId: string;
  pressureKg: number;
  ink: string;
  impressions: number;
  sampleNo: string;
  clarity: ClarityLevel;
  proofDate: string;
  note?: string;
}

export function validateProofInput(input: Partial<ProofInput>): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.targetKind) errors.targetKind = '请选择试印对象';
  if (!(input.targetRef || '').trim()) errors.targetRef = '请填写字符或字盘编号';
  const p = Number(input.pressureKg);
  if (!Number.isFinite(p) || p < PRESSURE_RANGE.min || p > PRESSURE_RANGE.max) {
    errors.pressureKg = `压力需在 ${PRESSURE_RANGE.min}–${PRESSURE_RANGE.max} kg 之间`;
  }
  const n = Number(input.impressions);
  if (!Number.isInteger(n) || n < IMPRESSION_RANGE.min || n > IMPRESSION_RANGE.max) {
    errors.impressions = `印次需在 ${IMPRESSION_RANGE.min}–${IMPRESSION_RANGE.max} 之间`;
  }
  if (!(input.ink || '').trim()) errors.ink = '请填写用墨';
  if (!(input.sampleNo || '').trim()) errors.sampleNo = '样张编号不能为空';
  if (!input.clarity) errors.clarity = '请选择清晰度观察值';
  const d = (input.proofDate || '').trim();
  if (!d) errors.proofDate = '请填写试印日期';
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.proofDate = '日期格式需为 YYYY-MM-DD';
  return errors;
}

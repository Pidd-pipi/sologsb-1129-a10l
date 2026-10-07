/** 试印判定：按「字体 + 字号」匹配工艺标准，输出判定结论、原因与标准快照 */
import type { TypeMatrix } from '../types/matrix';
import type { ProofStandardSnapshot, ProofTargetKind, StandardVerdict } from '../types/proof';
import { emptyStandardSnapshot } from '../types/proof';
import type { ProofStandard } from '../types/proofStandard';
import {
  judgeByStandard,
  proofStandardKey,
  standardKeyOf,
} from '../types/proofStandard';

/** 被判定对象需要具备的试印字段（ProofRecord / 登记表单均可） */
export interface ProofJudgeSubject {
  targetKind: ProofTargetKind;
  matrixId: string;
  pressureKg: number;
  ink: string;
  impressions: number;
  proofDate: string;
}

/** 判定结果同时携带标准快照，直接铺到 ProofRecord 上落库 */
export interface ProofEvaluation extends ProofStandardSnapshot {
  verdict: StandardVerdict;
  judgeReasons: string[];
}

/** 从标准拷贝一份快照（判定后随试印记录走，不再回头关联现行标准） */
export function snapshotOf(std: ProofStandard): ProofStandardSnapshot {
  return {
    standardId: std.id,
    standardVersion: std.version,
    standardKey: standardKeyOf(std),
    standardPressureMinKg: std.pressureMinKg,
    standardPressureMaxKg: std.pressureMaxKg,
    standardInk: std.ink,
    standardMinImpressions: std.minImpressions,
  };
}

/** 标准数组按分组键建索引 */
export function standardsMap(standards: ProofStandard[]): Map<string, ProofStandard> {
  return new Map(standards.map((s) => [standardKeyOf(s), s]));
}

/**
 * 取某分组在指定日期「当时」生效的标准。
 * 当前标准不带生效日期字段，唯一一行即长期有效；保留日期参数是为了落实
 * 「旧数据按试印日期匹配当时标准」的语义，也便于将来给标准加生效日期。
 */
export function standardAt(
  byKey: Map<string, ProofStandard>,
  key: string,
  _proofDate: string,
): ProofStandard | undefined {
  return byKey.get(key);
}

/**
 * 按字模的字体 / 字号匹配标准并判定。
 * - 无关联字模（整盘试印或未选字模）→ 未定标
 * - 该字体 / 字号在试印日期当时没有生效标准 → 未定标
 * - 命中标准 → 达标 / 偏淡 / 糊版（细则见 judgeByStandard）
 * context=migration 时未定标原因会标明是旧数据升级补判。
 */
export function evaluateProof(
  proof: ProofJudgeSubject,
  matrix: TypeMatrix | undefined,
  byKey: Map<string, ProofStandard>,
  context: 'live' | 'migration' = 'live',
): ProofEvaluation {
  if (!matrix) {
    return {
      ...emptyStandardSnapshot(),
      verdict: '未定标',
      judgeReasons: [
        proof.targetKind === '字盘'
          ? '整盘试印不按单一字体/字号判定，暂未纳入标准判定'
          : '未关联字模，无法按字体/字号匹配工艺标准',
      ],
    };
  }
  const std = standardAt(byKey, proofStandardKey(matrix), proof.proofDate);
  if (!std) {
    const prefix = context === 'migration' ? '旧数据升级补判：' : '';
    return {
      ...emptyStandardSnapshot(),
      verdict: '未定标',
      judgeReasons: [
        `${prefix}试印日期 ${proof.proofDate} 当时没有「${matrix.font} / ${matrix.sizeName}」生效的工艺标准`,
      ],
    };
  }
  const result = judgeByStandard(std, proof);
  return { ...snapshotOf(std), verdict: result.verdict, judgeReasons: result.reasons };
}

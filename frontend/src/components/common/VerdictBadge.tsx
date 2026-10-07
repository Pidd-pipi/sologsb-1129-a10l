import type { ProofVerdict } from '../../types/standard';

export interface VerdictBadgeProps {
  verdict: ProofVerdict | string;
  /** 判定依据的标准版本号，0 表示未定标 */
  standardVersion?: number;
  /** 已留档样张：判定冻结，不随标准改动重算 */
  archived?: boolean;
  testId?: string;
}

const VERDICT_STYLE: Record<string, string> = {
  达标: 'border-jade/40 bg-jade-pale text-jade',
  偏淡: 'border-brass/40 bg-brass-pale text-brass',
  糊版: 'border-seal/40 bg-seal-pale text-seal',
  未定标: 'border-paper-line bg-white text-ink-mute',
};

/** 试印判定标签：被试印记录页与字模详情页复用 */
export default function VerdictBadge({
  verdict,
  standardVersion = 0,
  archived = false,
  testId = 'verdict-badge',
}: VerdictBadgeProps) {
  const style = VERDICT_STYLE[verdict] ?? VERDICT_STYLE['未定标'];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${style}`}
      data-testid={testId}
      data-verdict={verdict}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      <span>{verdict}</span>
      {standardVersion > 0 ? <span className="text-[10px] opacity-75">v{standardVersion}</span> : null}
      {archived ? (
        <span className="rounded-full border border-current/40 px-1 text-[10px]" data-testid={`${testId}-archived`}>
          留档
        </span>
      ) : null}
    </span>
  );
}

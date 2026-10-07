import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { DefectInput, DefectLog } from '../types/defect';
import { shouldDisableMatrix } from '../types/defect';
import type { MatrixInput, TypeMatrix } from '../types/matrix';
import { ptOfSize } from '../types/matrix';
import type { ProofInput, ProofRecord } from '../types/proof';
import type { ProofStandard, ProofStandardInput } from '../types/proofStandard';
import { standardKeyOf } from '../types/proofStandard';
import { evaluateProof, standardsMap } from '../utils/proofJudge';
import { makeId, toPlain, todayStr } from '../utils/format';

/** 晚保存者提交时标准已被他人改动：携带库里现行值与逐字段差异，先看差异再决定入库 */
export class StandardConflictError extends Error {
  current: ProofStandard;
  constructor(current: ProofStandard) {
    super('试印工艺标准已被他人修改');
    this.name = 'StandardConflictError';
    this.current = current;
  }
}

interface MatrixState {
  matrices: TypeMatrix[];
  defects: DefectLog[];
  proofs: ProofRecord[];
  standards: ProofStandard[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  createMatrix: (input: MatrixInput) => Promise<TypeMatrix>;
  updateMatrix: (id: string, patch: Partial<TypeMatrix>) => Promise<void>;
  removeMatrix: (id: string) => Promise<void>;
  addDefect: (input: DefectInput) => Promise<DefectLog>;
  repairMatrix: (matrixId: string, operator: string) => Promise<void>;
  addProof: (input: ProofInput) => Promise<ProofRecord>;
  archiveProof: (id: string) => Promise<void>;
  refreshStandards: () => Promise<void>;
  saveStandard: (
    input: ProofStandardInput,
    id?: string,
    baseVersion?: number,
    force?: boolean,
  ) => Promise<ProofStandard>;
}

const byUpdatedDesc = (a: TypeMatrix, b: TypeMatrix) => (a.updatedAt < b.updatedAt ? 1 : -1);
const byStdKey = (a: ProofStandard, b: ProofStandard) =>
  standardKeyOf(a) < standardKeyOf(b) ? -1 : standardKeyOf(a) > standardKeyOf(b) ? 1 : 0;

export const useMatrixStore = create<MatrixState>((set, get) => ({
  matrices: [],
  defects: [],
  proofs: [],
  standards: [],
  loaded: false,
  loading: false,
  error: '',

  /** 首次进入时写入示例档案并读回全部数据 */
  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const [matrices, defects, proofs, standards] = await Promise.all([
        db.matrices.toArray(),
        db.defects.toArray(),
        db.proofs.toArray(),
        db.standards.toArray(),
      ]);
      set({
        matrices: matrices.sort(byUpdatedDesc),
        defects,
        proofs,
        standards: standards.sort(byStdKey),
        loaded: true,
        loading: false,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '本地档案读取失败' });
    }
  },

  createMatrix: async (input) => {
    const now = new Date().toISOString();
    const row: TypeMatrix = toPlain({
      id: makeId('mtx'),
      code: input.code.trim(),
      character: input.character.trim(),
      font: input.font,
      sizeName: input.sizeName,
      sizePt: ptOfSize(input.sizeName),
      material: input.material,
      faceWidthMm: Number(input.faceWidthMm),
      bodyHeightMm: Number(input.bodyHeightMm),
      madeYear: Number(input.madeYear),
      engraver: input.engraver.trim(),
      availability: '可用' as const,
      note: (input.note ?? '').trim(),
      createdAt: now,
      updatedAt: now,
    });
    await db.matrices.add(row);
    set((s) => ({ matrices: [row, ...s.matrices] }));
    return row;
  },

  updateMatrix: async (id, patch) => {
    const plain = toPlain(patch);
    const next: Partial<TypeMatrix> = { ...plain, updatedAt: new Date().toISOString() };
    if (plain.sizeName) next.sizePt = ptOfSize(plain.sizeName);
    await db.matrices.update(id, next);
    set((s) => ({
      matrices: s.matrices
        .map((m) => (m.id === id ? { ...m, ...next } : m))
        .sort(byUpdatedDesc),
    }));
  },

  removeMatrix: async (id) => {
    await db.transaction('rw', db.matrices, db.defects, db.proofs, async () => {
      await db.matrices.delete(id);
      const defectIds = (await db.defects.where('matrixId').equals(id).toArray()).map((d) => d.id);
      const proofIds = (await db.proofs.where('matrixId').equals(id).toArray()).map((p) => p.id);
      await db.defects.bulkDelete(defectIds);
      await db.proofs.bulkDelete(proofIds);
    });
    set((s) => ({
      matrices: s.matrices.filter((m) => m.id !== id),
      defects: s.defects.filter((d) => d.matrixId !== id),
      proofs: s.proofs.filter((p) => p.matrixId !== id),
    }));
  },

  /** 登记缺损：写入缺损记录，并按结论自动停用字模 */
  addDefect: async (input) => {
    const matrix = get().matrices.find((m) => m.id === input.matrixId);
    if (!matrix) throw new Error('未找到对应字模，无法登记缺损');
    const row: DefectLog = toPlain({
      id: makeId('dft'),
      matrixId: input.matrixId,
      character: matrix.character,
      matrixCode: matrix.code,
      defectType: input.defectType,
      severity: input.severity,
      foundDate: input.foundDate || todayStr(),
      handling: input.handling.trim(),
      availability: input.availability,
      operator: input.operator.trim(),
      note: (input.note ?? '').trim(),
      createdAt: new Date().toISOString(),
    });
    await db.defects.add(row);
    set((s) => ({ defects: [row, ...s.defects] }));
    if (shouldDisableMatrix(input.availability)) {
      await get().updateMatrix(input.matrixId, { availability: input.availability });
    }
    return row;
  },

  /** 补刻完成：恢复可用，并留下一条收尾记录 */
  repairMatrix: async (matrixId, operator) => {
    const matrix = get().matrices.find((m) => m.id === matrixId);
    if (!matrix) throw new Error('未找到对应字模，无法补刻');
    const history = get()
      .defects.filter((d) => d.matrixId === matrixId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const last = history[0];
    const row: DefectLog = toPlain({
      id: makeId('dft'),
      matrixId,
      character: matrix.character,
      matrixCode: matrix.code,
      defectType: last?.defectType ?? '磨损',
      severity: last?.severity ?? '轻',
      foundDate: todayStr(),
      handling: `补刻完成，字面复测合格（原处理：${last?.handling ?? '未记录'}）`,
      availability: '可用' as const,
      operator: operator.trim() || '补刻工',
      note: '补刻收尾记录',
      createdAt: new Date().toISOString(),
    });
    await db.defects.add(row);
    set((s) => ({ defects: [row, ...s.defects] }));
    await get().updateMatrix(matrixId, { availability: '可用' });
  },

  addProof: async (input) => {
    const matrix = input.matrixId ? get().matrices.find((m) => m.id === input.matrixId) : undefined;
    const base = {
      targetKind: input.targetKind,
      targetRef: input.targetRef.trim(),
      matrixId: input.matrixId,
      pressureKg: Number(input.pressureKg),
      ink: input.ink.trim(),
      impressions: Number(input.impressions),
      sampleNo: input.sampleNo.trim(),
      clarity: input.clarity,
      proofDate: input.proofDate || todayStr(),
      note: (input.note ?? '').trim(),
    };
    if (matrix && input.targetKind === '字符' && !base.targetRef) base.targetRef = matrix.character;
    // 登记即按现行（=试印当时）标准判定，快照随记录一起落库
    const evaluation = evaluateProof(base, matrix, standardsMap(get().standards), 'live');
    const row: ProofRecord = toPlain({
      id: makeId('pfr'),
      ...base,
      ...evaluation,
      judgedAt: new Date().toISOString(),
      archived: false,
      archivedAt: '',
      createdAt: new Date().toISOString(),
    });
    await db.proofs.add(row);
    set((s) => ({ proofs: [row, ...s.proofs] }));
    return row;
  },

  /** 留档样张：判定冻结在此刻，之后标准改动不再倒推它 */
  archiveProof: async (id) => {
    const archivedAt = new Date().toISOString();
    await db.proofs.update(id, { archived: true, archivedAt });
    set((s) => ({
      proofs: s.proofs.map((p) => (p.id === id ? { ...p, archived: true, archivedAt } : p)),
    }));
  },

  /** 多标签页 / 他人改过后，重新读取标准（晚保存者据此发现版本已变） */
  refreshStandards: async () => {
    const standards = (await db.standards.toArray()).sort(byStdKey);
    set({ standards });
  },

  /**
   * 保存标准（新增或修改）。
   * 乐观并发：修改时带上打开表单时的 version；库里版本已更新则抛 StandardConflictError，
   * 由页面提示「标准已变过」并展示差异，不入库。force=true 表示已看过差异仍以编辑稿入库。
   * 入库后同一事务内重算所有「未留档」试印；已留档样张保持当时判定，不倒推。
   */
  saveStandard: async (input, id, baseVersion, force = false) => {
    const now = new Date().toISOString();
    let saved: ProofStandard | null = null;
    const changedProofs: ProofRecord[] = [];
    await db.transaction(
      'rw',
      db.standards,
      db.proofs,
      db.matrices,
      async () => {
        const keyOfInput = `${input.font}|${input.sizeName}`;
        const existing = id ? await db.standards.get(id) : undefined;
        if (id && !existing) throw new Error('要修改的标准已不存在，请刷新后重试');

        // 同分组唯一：新增时（或修改时改了字体/字号）不能与别的标准撞键
        const sameKey = (await db.standards.toArray()).find(
          (s) => standardKeyOf(s) === keyOfInput && s.id !== id,
        );
        if (sameKey) throw new Error(`「${input.font} / ${input.sizeName}」已有标准，请直接修改原标准`);

        if (existing && baseVersion !== undefined && existing.version !== baseVersion && !force) {
          throw new StandardConflictError(existing);
        }

        const version = existing ? existing.version + 1 : 1;
        const row: ProofStandard = toPlain({
          id: existing ? existing.id : makeId('std'),
          font: input.font,
          sizeName: input.sizeName,
          pressureMinKg: Number(input.pressureMinKg),
          pressureMaxKg: Number(input.pressureMaxKg),
          ink: input.ink.trim(),
          minImpressions: Number(input.minImpressions),
          note: (input.note ?? '').trim(),
          version,
          createdAt: existing ? existing.createdAt : now,
          updatedAt: now,
        });
        await db.standards.put(row);
        saved = row;

        // 标准一改，没归档的试印跟着重算（按试印当时视角：仍按这组字体/字号匹配）
        const allStandards = await db.standards.toArray();
        const byKey = standardsMap(allStandards);
        const matrices: TypeMatrix[] = await db.matrices.toArray();
        const matrixById = new Map(matrices.map((m) => [m.id, m]));
        const openProofs = await db.proofs.filter((p) => !p.archived).toArray();
        for (const p of openProofs) {
          const evaluation = evaluateProof(
            p,
            p.matrixId ? matrixById.get(p.matrixId) : undefined,
            byKey,
            'live',
          );
          const changed =
            p.verdict !== evaluation.verdict ||
            p.standardId !== evaluation.standardId ||
            p.standardVersion !== evaluation.standardVersion;
          if (!changed) continue;
          const updated: ProofRecord = {
            ...p,
            ...toPlain(evaluation),
            judgedAt: now,
          };
          await db.proofs.put(updated);
          changedProofs.push(updated);
        }
      },
    );

    const row = saved!;
    set((s) => {
      const changedById = new Map(changedProofs.map((p) => [p.id, p]));
      return {
        standards: s.standards
          .filter((x) => x.id !== row.id)
          .concat(row)
          .sort(byStdKey),
        proofs: s.proofs.map((p) => changedById.get(p.id) ?? p),
      };
    });
    return row;
  },
}));

/** 单条字模（组件内使用，避免整表订阅） */
export function selectMatrix(id: string) {
  return (s: MatrixState) => s.matrices.find((m) => m.id === id);
}

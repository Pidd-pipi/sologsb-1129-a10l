import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { DefectInput, DefectLog } from '../types/defect';
import { shouldDisableMatrix } from '../types/defect';
import type { MatrixInput, TypeMatrix } from '../types/matrix';
import { ptOfSize } from '../types/matrix';
import type { ProofInput, ProofRecord } from '../types/proof';
import type { ProofStandard, ProofStandardInput } from '../types/standard';
import { judgeProofByStandard, standardAtDate, StandardConflictError } from '../types/standard';
import { makeId, toPlain, todayStr } from '../utils/format';

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
  /** 留档 / 取消留档：留档后判定冻结，标准改动不再倒推 */
  toggleProofArchived: (id: string, archived: boolean) => Promise<void>;
  /**
   * 保存工艺标准（新增一个版本）。baseVersion 为表单载入时基于的版本，
   * 库中最新版本不一致时抛 StandardConflictError（两人同时修改的晚保存方）。
   * 保存成功后未归档的同字体字号试印按新标准重算。
   */
  saveStandard: (
    input: ProofStandardInput,
    baseVersion: number,
  ) => Promise<{ standard: ProofStandard; recalculated: number }>;
}

const byUpdatedDesc = (a: TypeMatrix, b: TypeMatrix) => (a.updatedAt < b.updatedAt ? 1 : -1);

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
        db.proofStandards.toArray(),
      ]);
      set({
        matrices: matrices.sort(byUpdatedDesc),
        defects,
        proofs,
        standards,
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
    const now = new Date().toISOString();
    const proofDate = input.proofDate || todayStr();
    // 按试印日期匹配当时生效的标准判定；找不到适用标准记未定标
    const std = standardAtDate(get().standards, input.font, input.sizeName, proofDate);
    const row: ProofRecord = toPlain({
      id: makeId('pfr'),
      targetKind: input.targetKind,
      targetRef: input.targetRef.trim(),
      matrixId: input.matrixId,
      font: input.font,
      sizeName: input.sizeName,
      pressureKg: Number(input.pressureKg),
      ink: input.ink.trim(),
      impressions: Number(input.impressions),
      sampleNo: input.sampleNo.trim(),
      clarity: input.clarity,
      verdict: std ? judgeProofByStandard({ pressureKg: Number(input.pressureKg), ink: input.ink, impressions: Number(input.impressions) }, std) : ('未定标' as const),
      standardId: std?.id ?? '',
      standardVersion: std?.version ?? 0,
      judgedAt: now,
      archived: false,
      proofDate,
      note: (input.note ?? '').trim(),
      createdAt: now,
    });
    if (matrix && input.targetKind === '字符' && !row.targetRef) row.targetRef = matrix.character;
    await db.proofs.add(row);
    set((s) => ({ proofs: [row, ...s.proofs] }));
    return row;
  },

  toggleProofArchived: async (id, archived) => {
    await db.proofs.update(id, { archived });
    set((s) => ({
      proofs: s.proofs.map((p) => (p.id === id ? { ...p, archived } : p)),
    }));
  },

  saveStandard: async (input, baseVersion) => {
    const now = new Date().toISOString();
    const result = await db.transaction('rw', db.proofStandards, db.proofs, async () => {
      const versions = await db.proofStandards
        .where('[font+sizeName]')
        .equals([input.font, input.sizeName])
        .toArray();
      const latest = versions.sort((a, b) => b.version - a.version)[0];
      const latestVersion = latest?.version ?? 0;
      // 乐观锁：表单基于的版本已被他人推进时拒绝入库，交由页面展示差异
      if (latestVersion !== baseVersion) throw new StandardConflictError(latest);
      const row: ProofStandard = toPlain({
        id: makeId('std'),
        font: input.font,
        sizeName: input.sizeName,
        pressureMinKg: Number(input.pressureMinKg),
        pressureMaxKg: Number(input.pressureMaxKg),
        ink: input.ink.trim(),
        minImpressions: Number(input.minImpressions),
        effectiveDate: input.effectiveDate,
        version: latestVersion + 1,
        updatedBy: input.updatedBy.trim(),
        note: (input.note ?? '').trim(),
        createdAt: now,
      });
      await db.proofStandards.add(row);
      // 标准一改动，未归档的同字体字号试印跟着按新标准重算；已留档样张保持当时判定
      const unarchived = (await db.proofs.toArray()).filter(
        (p) => !p.archived && p.font === row.font && p.sizeName === row.sizeName,
      );
      let recalculated = 0;
      const patched: ProofRecord[] = [];
      for (const p of unarchived) {
        const verdict = judgeProofByStandard(p, row);
        if (verdict === p.verdict && p.standardId === row.id) continue;
        const next: ProofRecord = {
          ...p,
          verdict,
          standardId: row.id,
          standardVersion: row.version,
          judgedAt: now,
        };
        await db.proofs.update(p.id, {
          verdict,
          standardId: row.id,
          standardVersion: row.version,
          judgedAt: now,
        });
        patched.push(next);
        recalculated += 1;
      }
      return { row, patched, recalculated };
    });
    set((s) => ({
      standards: [...s.standards, result.row],
      proofs: s.proofs.map((p) => result.patched.find((q) => q.id === p.id) ?? p),
    }));
    return { standard: result.row, recalculated: result.recalculated };
  },
}));

/** 单条字模（组件内使用，避免整表订阅） */
export function selectMatrix(id: string) {
  return (s: MatrixState) => s.matrices.find((m) => m.id === id);
}

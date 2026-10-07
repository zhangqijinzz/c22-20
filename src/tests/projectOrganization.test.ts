import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { RuleAnalysis, RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
}

class FakeChecker {
  run(project: RuleProject): CheckOperation {
    return { promise: Promise.resolve(analyzeRules(project)), cancel: () => undefined };
  }
}

class ManualChecker {
  pending: { project: RuleProject; resolve: (analysis: RuleAnalysis) => void }[] = [];
  cancelled = 0;

  run(project: RuleProject): CheckOperation {
    let settle!: (analysis: RuleAnalysis) => void;
    const promise = new Promise<RuleAnalysis>((resolve) => { settle = resolve; });
    this.pending.push({ project, resolve: settle });
    return { promise, cancel: () => { this.cancelled += 1; } };
  }
}

async function settleSave(workspace: RuleWorkspaceViewModel) {
  await vi.advanceTimersByTimeAsync(250);
  await workspace.flushSave();
}

describe('project organization', () => {
  beforeEach(() => vi.useFakeTimers());

  it('duplicates a project with fields, rules, samples and version records as an independent editable copy', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.saveVersion();
    workspace.freezeCurrent();
    const source = workspace.getSnapshot().project as RuleProject;
    expect(source.frozenVersionId).toBeDefined();

    workspace.duplicateProject(source.id);
    const state = workspace.getSnapshot();
    expect(state.workspace?.projects).toHaveLength(2);
    const copy = state.project as RuleProject;
    expect(state.workspace?.activeProjectId).toBe(copy.id);
    expect(copy.id).not.toBe(source.id);
    expect(copy.title).toBe(`${source.title} 副本`);
    expect(copy.fields).toEqual(source.fields);
    expect(copy.rules).toEqual(source.rules);
    expect(copy.sampleInputs).toEqual(source.sampleInputs);
    expect(copy.versions).toHaveLength(source.versions.length);
    expect(copy.versions.map((version) => version.id)).not.toContain(source.versions[0].id);
    expect(copy.versions[0].rules).toEqual(source.versions[0].rules);
    expect(copy.frozenVersionId).toBeUndefined();

    workspace.duplicateProject(source.id);
    expect(workspace.getSnapshot().project?.title).toBe(`${source.title} 副本 2`);

    const editedCopy = workspace.getSnapshot().project as RuleProject;
    expect(workspace.commitProject({ ...editedCopy, title: '副本可编辑' }, '测试', { recheck: false })).toBe(true);
    const original = workspace.getSnapshot().workspace?.projects.find((project) => project.id === source.id);
    expect(original?.title).toBe(source.title);
    expect(original?.frozenVersionId).toBe(source.frozenVersionId);
    workspace.dispose();
  });

  it('deletes projects, switches away from the deleted active project, and keeps the last one', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    await settleSave(workspace);
    const first = workspace.getSnapshot().project as RuleProject;
    workspace.createProject();
    const second = workspace.getSnapshot().project as RuleProject;
    await settleSave(workspace);

    expect(workspace.deleteProject(first.id)).toBe(true);
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(1);
    expect(workspace.getSnapshot().project?.id).toBe(second.id);

    workspace.duplicateProject(second.id);
    const third = workspace.getSnapshot().project as RuleProject;
    workspace.switchProject(second.id);
    await settleSave(workspace);
    expect(workspace.deleteProject(second.id)).toBe(true);
    expect(workspace.getSnapshot().project?.id).toBe(third.id);
    expect(workspace.getSnapshot().workspace?.activeProjectId).toBe(third.id);

    expect(workspace.deleteProject(third.id)).toBe(false);
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(1);
    expect(workspace.getSnapshot().notice).toContain('至少保留一个');
    workspace.dispose();
  });

  it('requires confirmation before deleting a project with unsaved changes', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    await settleSave(workspace);
    const project = workspace.getSnapshot().project as RuleProject;
    expect(workspace.hasUnsavedChanges(project.id)).toBe(false);

    workspace.commitProject({ ...project, title: '未保存的修改' }, '编辑', { recheck: false });
    expect(workspace.hasUnsavedChanges(project.id)).toBe(true);
    workspace.createProject();
    const fresh = workspace.getSnapshot().project as RuleProject;
    expect(workspace.hasUnsavedChanges(fresh.id)).toBe(true);

    expect(workspace.deleteProject(fresh.id)).toBe(false);
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);
    expect(workspace.getSnapshot().notice).toContain('未保存');
    expect(workspace.deleteProject(fresh.id, { force: true })).toBe(true);
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(1);

    await settleSave(workspace);
    const renamed = workspace.getSnapshot().project as RuleProject;
    expect(renamed.title).toBe('未保存的修改');
    expect(workspace.hasUnsavedChanges(renamed.id)).toBe(false);
    expect(workspace.deleteProject(renamed.id)).toBe(false);
    workspace.dispose();
  });

  it('renames any project without switching and rejects empty titles', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    const first = workspace.getSnapshot().project as RuleProject;
    workspace.createProject();
    const second = workspace.getSnapshot().project as RuleProject;

    expect(workspace.renameProjectById(first.id, '  会员策略 V2  ')).toBe(true);
    expect(workspace.getSnapshot().workspace?.projects.find((project) => project.id === first.id)?.title).toBe('会员策略 V2');
    expect(workspace.getSnapshot().project?.id).toBe(second.id);

    expect(workspace.renameProjectById(first.id, '   ')).toBe(false);
    expect(workspace.getSnapshot().workspace?.projects.find((project) => project.id === first.id)?.title).toBe('会员策略 V2');

    expect(workspace.renameProjectById(second.id, '当前项目新名')).toBe(true);
    expect(workspace.getSnapshot().project?.title).toBe('当前项目新名');
    workspace.dispose();
  });

  it('keeps in-flight checks and unsaved edits from leaking into another project on switch', async () => {
    const repository = new MemoryRepository();
    const checker = new ManualChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    const projectA = workspace.getSnapshot().project as RuleProject;

    void workspace.runCheck();
    expect(checker.pending).toHaveLength(1);
    workspace.duplicateProject(projectA.id);
    const projectB = workspace.getSnapshot().project as RuleProject;
    expect(projectB.id).not.toBe(projectA.id);
    expect(checker.cancelled).toBe(1);

    checker.pending[0].resolve(analyzeRules(projectA));
    await vi.advanceTimersByTimeAsync(0);
    expect(workspace.getSnapshot().project?.id).toBe(projectB.id);
    expect(workspace.getSnapshot().analysis).toBeNull();
    expect(workspace.getSnapshot().checkStatus).not.toBe('success');

    workspace.switchProject(projectA.id);
    workspace.commitProject({ ...projectA, title: 'A 的未保存修改' }, '编辑', { recheck: false });
    workspace.switchProject(projectB.id);
    expect(workspace.getSnapshot().project?.title).toBe(projectB.title);
    workspace.switchProject(projectA.id);
    expect(workspace.getSnapshot().project?.title).toBe('A 的未保存修改');

    await settleSave(workspace);
    expect(repository.document?.projects.find((project) => project.id === projectA.id)?.title).toBe('A 的未保存修改');
    expect(repository.document?.projects.find((project) => project.id === projectB.id)?.title).toBe(projectB.title);
    workspace.dispose();
  });
});

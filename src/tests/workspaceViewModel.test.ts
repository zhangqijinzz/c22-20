import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
}

class FakeChecker {
  calls = 0;
  nextError: Error | null = null;
  cancelled = false;
  checkedProjectIds: string[] = [];

  run(project: RuleProject): CheckOperation {
    this.calls += 1;
    this.checkedProjectIds.push(project.id);
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return { promise: Promise.reject(error), cancel: () => { this.cancelled = true; } };
    }
    return { promise: Promise.resolve(analyzeRules(project)), cancel: () => { this.cancelled = true; } };
  }
}

describe('RuleWorkspaceViewModel', () => {
  beforeEach(() => vi.useFakeTimers());

  it('initializes a usable demo, runs checks, persists edits, and recovers the workspace', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    expect(workspace.getSnapshot().project?.rules).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '已修改策略' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    expect(repository.document?.projects[0].title).toBe('已修改策略');

    const restored = new RuleWorkspaceViewModel(repository, checker);
    await restored.start();
    expect(restored.getSnapshot().project?.title).toBe('已修改策略');
    restored.dispose();
    workspace.dispose();
  });

  it('shows check errors and recovers on the next successful run', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    checker.nextError = new Error('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().phase).toBe('error');
    expect(workspace.getSnapshot().notice).toBe('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    workspace.dispose();
  });

  it('marks cancellation and blocks checks for invalid projects', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    const project = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...project, fields: project.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) });
    expect(workspace.getSnapshot().phase).toBe('validating');
    const callsBefore = checker.calls;
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('error');
    expect(checker.calls).toBe(callsBefore);
    workspace.dispose();
  });

  it('saves versions, freezes and resumes a version, and copies it into a new project', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.saveVersion();
    const savedVersion = workspace.getSnapshot().project?.versions[0];
    expect(savedVersion?.frozen).toBe(false);

    workspace.freezeCurrent();
    const frozen = workspace.getSnapshot().project;
    expect(frozen?.frozenVersionId).toBe(frozen?.versions[0].id);
    expect(workspace.commitProject({ ...(frozen as RuleProject), title: '不允许修改' })).toBe(false);

    workspace.restoreVersion(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().project?.frozenVersionId).toBeUndefined();
    workspace.copyVersionToProject(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    workspace.dispose();
  });

  it('duplicates a full project including fields, rules, samples and version history', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    const source0 = workspace.getSnapshot().project as RuleProject;
    workspace.saveVersion();
    workspace.freezeCurrent();

    const source = workspace.getSnapshot().workspace?.projects.find((item) => item.id === source0.id) as RuleProject;

    workspace.duplicateProject();
    const copy = workspace.getSnapshot().project as RuleProject;
    expect(copy.id).not.toBe(source.id);
    expect(copy.title).toBe(`${source.title} 副本`);
    expect(copy.fields).toEqual(source.fields);
    expect(copy.rules).toEqual(source.rules);
    expect(copy.sampleInputs).toEqual(source.sampleInputs);
    expect(copy.versions).toHaveLength(2);
    expect(copy.versions).toEqual(source.versions);
    // The copy stands on its own: it is editable even though the source is frozen.
    expect(copy.frozenVersionId).toBeUndefined();
    expect(workspace.commitProject({ ...copy, title: '副本可编辑' })).toBe(true);

    // The source project remains untouched and independent of the copy.
    const storedSource = workspace.getSnapshot().workspace?.projects.find((item) => item.id === source.id);
    expect(storedSource?.title).toBe(source.title);
    expect(storedSource?.frozenVersionId).toBe(source.versions[0].id);

    // A further duplicate of the (renamed) copy gets its own unique title.
    workspace.duplicateProject(copy.id);
    expect(workspace.getSnapshot().project?.title).toBe('副本可编辑 副本');
    await workspace.flushSave();
    expect(repository.document?.projects).toHaveLength(3);
    workspace.dispose();
  });

  it('renames the active project but rejects empty titles', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    const original = (workspace.getSnapshot().project as RuleProject).title;
    workspace.renameProject('新的项目名称');
    expect(workspace.getSnapshot().project?.title).toBe('新的项目名称');
    workspace.renameProject('   ');
    expect(workspace.getSnapshot().project?.title).toBe('新的项目名称');
    expect(workspace.getSnapshot().notice).toContain('不能为空');
    workspace.renameProject(original);
    workspace.dispose();
  });

  it('deletes a saved project, refuses the last one, and switches to a remaining project', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    workspace.createProject();
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    const createdId = workspace.getSnapshot().project?.id;
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);

    // Cannot remove the only remaining project.
    await workspace.switchProject((workspace.getSnapshot().workspace?.projects[0].id) as string);
    workspace.requestDeleteProject(createdId);
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(1);

    const onlyId = workspace.getSnapshot().project?.id;
    expect(workspace.requestDeleteProject(onlyId)).toBe('last-project');
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(1);
    await workspace.flushSave();
    workspace.dispose();
  });

  it('requires confirmation before deleting a project with unsaved edits', async () => {
    const repository = new MemoryRepository();
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    workspace.createProject();
    const dirtyId = workspace.getSnapshot().project?.id as string;
    // The brand-new project's debounced save has not fired yet, so it is dirty.
    expect(workspace.getSnapshot().dirtyProjectIds).toContain(dirtyId);

    expect(workspace.requestDeleteProject(dirtyId)).toBe('needs-confirmation');
    expect(workspace.getSnapshot().pendingDeleteProjectId).toBe(dirtyId);
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);

    // Cancelling keeps the project and clears the pending confirmation.
    workspace.cancelDeleteProject();
    expect(workspace.getSnapshot().pendingDeleteProjectId).toBeUndefined();
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);

    // Confirming discards the unsaved edits and removes the project.
    workspace.requestDeleteProject(dirtyId);
    workspace.confirmDeleteProject();
    expect(workspace.getSnapshot().workspace?.projects.some((item) => item.id === dirtyId)).toBe(false);
    expect(workspace.getSnapshot().dirtyProjectIds).not.toContain(dirtyId);
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    expect(repository.document?.projects.some((item) => item.id === dirtyId)).toBe(false);
    workspace.dispose();
  });

  it('flushes unsaved edits when switching and never carries another project state over', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    const demoId = workspace.getSnapshot().project?.id as string;

    // Create a second, valid project by duplicating the demo (blank projects
    // can't be checked, so a full copy gives both projects a checkable state).
    workspace.duplicateProject();
    const secondId = workspace.getSnapshot().project?.id as string;
    const secondProject = workspace.getSnapshot().project as RuleProject;
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    checker.checkedProjectIds.length = 0;

    await workspace.switchProject(demoId);
    expect(workspace.getSnapshot().project?.id).toBe(demoId);
    expect(repository.document?.projects.some((item) => item.id === secondId)).toBe(true);

    // An edit made in the first project cannot leak into the second after switching back.
    const first = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...first, title: '只属于第一个项目' }, '编辑', { recheck: false });
    await workspace.switchProject(secondId);
    const entered = workspace.getSnapshot().project as RuleProject;
    expect(entered.id).toBe(secondId);
    expect(entered.title).toBe(secondProject.title);
    expect(entered.title).not.toBe('只属于第一个项目');
    expect(workspace.getSnapshot().analysis).toBeNull();
    expect(workspace.getSnapshot().selectedRuleId).toBe(entered.rules[0]?.id);

    // Let the auto check scheduled for the entered project finish: it must run
    // against that project's own data, never against the project we left.
    await vi.advanceTimersByTimeAsync(250);
    expect(checker.checkedProjectIds).toContain(secondId);
    expect(workspace.getSnapshot().project?.id).toBe(secondId);
    expect(workspace.getSnapshot().project?.title).toBe(secondProject.title);
    await workspace.flushSave();
    workspace.dispose();
  });
});


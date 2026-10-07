import { evaluateSample } from '../domain/conditionEvaluator';
import { ruleDomain } from '../domain/ruleDomain';
import type {
  ModuleId,
  RuleAnalysis,
  RuleProject,
  SampleEvaluation,
  WorkspaceDocument,
} from '../models/ruleModel';
import { cloneData, createBlankProject, createDemoWorkspace, createVersionSnapshot, makeId, uniqueTitle } from '../models/projectFactory';
import { RuleRepository } from '../repositories/ruleRepository';
import { ProjectStorageService } from '../services/projectStorageService';
import { RuleCheckService, type CheckOperation } from '../services/ruleCheckService';
import type { WorkspacePort } from './workspacePort';

export type WorkspacePhase = 'loading' | 'editing' | 'validating' | 'checking' | 'ready' | 'error';
export type CheckStatus = 'idle' | 'scheduled' | 'checking' | 'success' | 'error' | 'cancelled';

export interface WorkspaceState {
  phase: WorkspacePhase;
  persistence: 'idle' | 'saving' | 'saved' | 'error';
  workspace: WorkspaceDocument | null;
  project: RuleProject | null;
  activeModule: ModuleId;
  checkStatus: CheckStatus;
  analysis: RuleAnalysis | null;
  validationIssues: ReturnType<typeof ruleDomain.validateProject>;
  sampleEvaluation: SampleEvaluation | null;
  selectedRuleId?: string;
  notice: string;
  saveError?: string;
  /** Projects whose in-memory edits have not finished persisting. */
  dirtyProjectIds: string[];
  /** Set when deleting a project that still carries unsaved edits, awaiting confirmation. */
  pendingDeleteProjectId?: string;
}

export type DeleteProjectOutcome = 'deleted' | 'last-project' | 'needs-confirmation' | 'not-found';

type Listener = () => void;
type WorkspaceRepository = Pick<RuleRepository, 'load' | 'save'>;
type Checker = Pick<RuleCheckService, 'run'>;

export class RuleWorkspaceViewModel implements WorkspacePort {
  private state: WorkspaceState = {
    phase: 'loading', persistence: 'idle', workspace: null, project: null,
    activeModule: 'inspection', checkStatus: 'idle', analysis: null,
    validationIssues: [], sampleEvaluation: null, notice: '正在恢复本地规则项目…',
    dirtyProjectIds: [],
  };
  private readonly listeners = new Set<Listener>();
  private startPromise?: Promise<void>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private checkTimer?: ReturnType<typeof setTimeout>;
  private checkOperation?: CheckOperation;
  private checkRevision = 0;
  private saveRevision = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: WorkspaceRepository = new RuleRepository(new ProjectStorageService()),
    private readonly checker: Checker = new RuleCheckService(),
  ) {}

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): WorkspaceState => this.state;

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.initialize();
    return this.startPromise;
  }

  async flushSave(): Promise<void> {
    if (this.saveTimer && this.state.workspace) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      const pendingDirtyIds = this.state.dirtyProjectIds;
      this.enqueueSave(this.state.workspace, this.saveRevision, pendingDirtyIds);
    }
    await this.writeQueue;
  }
  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkOperation?.cancel();
    this.checkOperation = undefined;
  }

  commitProject(project: RuleProject, notice = '项目已更新', options: { recheck?: boolean } = {}): boolean {
    const current = this.state.project;
    if (!current || current.frozenVersionId) {
      this.updateView({ notice: '当前版本已冻结。请先从版本记录中复制一份继续编辑。' });
      return false;
    }
    this.replaceProject({ ...project, updatedAt: Date.now() }, notice, options.recheck !== false);
    return true;
  }

  updateView(patch: Partial<WorkspaceState>): void {
    this.publish({ ...this.state, ...patch });
  }

  navigate(module: ModuleId): void {
    this.updateView({ activeModule: module, notice: '' });
  }

  selectRule(ruleId?: string): void {
    this.updateView({ selectedRuleId: ruleId });
  }

  renameProject(title: string): void {
    const project = this.state.project;
    if (!project || title === project.title) return;
    if (!title.trim()) {
      this.updateView({ notice: '项目名称不能为空。' });
      return;
    }
    this.commitProject({ ...project, title }, '项目名称已更新', { recheck: false });
  }

  /**
   * Produce a complete, independent copy of a project: fields, rules, sample
   * inputs and the full version history all come along. The copy is always
   * editable, so a frozen source is not copied as frozen.
   */
  duplicateProject(projectId?: string): void {
    const workspace = this.state.workspace;
    const source = workspace?.projects.find((candidate) => candidate.id === (projectId ?? this.state.project?.id));
    if (!workspace || !source) return;
    const copy: RuleProject = {
      ...cloneData(source),
      id: makeId('project'),
      title: uniqueTitle(`${source.title} 副本`, workspace.projects.map((item) => item.title)),
      frozenVersionId: undefined,
      updatedAt: Date.now(),
    };
    const next = { ...workspace, projects: [...workspace.projects, copy], activeProjectId: copy.id };
    const issues = ruleDomain.validateProject(copy);
    this.publish({ ...this.activateProject(next, copy), notice: `已复制出完整副本“${copy.title}”，包含字段、规则、样例与 ${copy.versions.length} 条版本记录` });
    this.scheduleSave(next, { dirtyProjectId: copy.id });
    if (!issues.length) this.scheduleCheck(80);
  }

  /**
   * Remove a project. A project carrying unsaved edits must be confirmed first
   * (the pending edits are discarded); deleting the last remaining project is
   * refused so the workspace always has somewhere to land.
   */
  requestDeleteProject(projectId?: string): DeleteProjectOutcome {
    const workspace = this.state.workspace;
    const targetId = projectId ?? this.state.project?.id;
    const target = workspace?.projects.find((candidate) => candidate.id === targetId);
    if (!workspace || !target) return 'not-found';
    if (workspace.projects.length <= 1) {
      this.updateView({ notice: '至少需要保留一个项目，无法删除最后一个项目。' });
      return 'last-project';
    }
    if (this.isDirty(target.id)) {
      this.updateView({ pendingDeleteProjectId: target.id, notice: `“${target.title}”还有未保存的改动，删除前需要确认。` });
      return 'needs-confirmation';
    }
    this.deleteProject(target.id);
    return 'deleted';
  }

  confirmDeleteProject(): void {
    const targetId = this.state.pendingDeleteProjectId;
    if (!targetId) return;
    this.updateView({ pendingDeleteProjectId: undefined });
    this.deleteProject(targetId);
  }

  cancelDeleteProject(): void {
    const target = this.state.workspace?.projects.find((item) => item.id === this.state.pendingDeleteProjectId);
    this.updateView({ pendingDeleteProjectId: undefined, notice: target ? `已保留项目“${target.title}”` : '' });
  }

  isProjectDirty(projectId: string): boolean {
    return this.isDirty(projectId);
  }

  async runCheck(): Promise<void> {
    const project = this.state.project;
    if (!project) return;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    const issues = ruleDomain.validateProject(project);
    if (issues.length) {
      this.publish({ ...this.state, phase: 'validating', checkStatus: 'error', validationIssues: issues, notice: issues[0].message });
      return;
    }
    this.checkOperation?.cancel();
    const revision = ++this.checkRevision;
    this.publish({ ...this.state, phase: 'checking', checkStatus: 'checking', notice: '正在工作线程中枚举输入空间…' });
    try {
      const operation = this.checker.run(project);
      this.checkOperation = operation;
      const analysis = await operation.promise;
      if (revision !== this.checkRevision) return;
      this.checkOperation = undefined;
      this.publish({ ...this.state, phase: 'ready', checkStatus: 'success', analysis, notice: `检查完成：已分析 ${analysis.checkedCases.toLocaleString('zh-CN')} 个逻辑分区` });
    } catch (error) {
      if (revision !== this.checkRevision) return;
      this.checkOperation = undefined;
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.publish({ ...this.state, phase: 'editing', checkStatus: 'cancelled', notice: '检查已取消' });
      } else {
        const message = error instanceof Error ? error.message : '规则检查失败';
        this.publish({ ...this.state, phase: 'error', checkStatus: 'error', notice: message });
      }
    }
  }

  cancelCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    this.checkRevision += 1;
    this.checkOperation?.cancel();
    this.checkOperation = undefined;
    if (this.state.checkStatus === 'checking' || this.state.checkStatus === 'scheduled') {
      this.publish({ ...this.state, phase: 'editing', checkStatus: 'cancelled', notice: '检查已取消' });
    }
  }

  createProject(): void {
    const workspace = this.state.workspace;
    if (!workspace) return;
    const project = createBlankProject(workspace.projects.length + 1);
    const next: WorkspaceDocument = { ...workspace, projects: [...workspace.projects, project], activeProjectId: project.id };
    this.publish({
      ...this.activateProject(next, project, { activeModule: 'fields' }),
      phase: 'validating',
      notice: '空项目已创建。先定义字段，再添加规则。',
    });
    this.scheduleSave(next, { dirtyProjectId: project.id });
  }

  async switchProject(projectId: string): Promise<void> {
    const workspace = this.state.workspace;
    const project = workspace?.projects.find((candidate) => candidate.id === projectId);
    if (!workspace || !project || workspace.activeProjectId === projectId) return;
    // Persist edits to the project being left before anything else can touch it.
    await this.flushSave();
    // Any computation still running belongs to the previous project; drop it so
    // neither its progress nor its result can leak into the project we enter.
    this.cancelCheck();
    const next = { ...workspace, activeProjectId: projectId };
    const issues = ruleDomain.validateProject(project);
    this.publish({
      ...this.activateProject(next, project),
      phase: issues.length ? 'validating' : 'editing',
      checkStatus: issues.length ? 'idle' : 'scheduled',
      notice: `已切换到“${project.title}”`,
    });
    // Only the active selection changed; no project content was edited here.
    this.scheduleSave(next);
    if (!issues.length) this.scheduleCheck(80);
  }

  saveVersion(): void {
    const project = this.state.project;
    if (!project) return;
    const version = createVersionSnapshot(project, `版本 ${project.versions.length + 1}`, false);
    this.replaceProject({ ...project, versions: [version, ...project.versions] }, `已保存${version.name}`, false);
  }

  freezeCurrent(): void {
    const project = this.state.project;
    if (!project || project.frozenVersionId) return;
    const version = createVersionSnapshot(project, `冻结版本 ${project.versions.length + 1}`, true);
    this.replaceProject({ ...project, versions: [version, ...project.versions], frozenVersionId: version.id }, `已冻结${version.name}`, false, true);
  }

  restoreVersion(versionId: string): void {
    const project = this.state.project;
    const version = project?.versions.find((candidate) => candidate.id === versionId);
    if (!project || !version) return;
    this.replaceProject({ ...project, fields: cloneData(version.fields), rules: cloneData(version.rules), sampleInputs: cloneData(version.sampleInputs), frozenVersionId: undefined }, `已从“${version.name}”建立可编辑版本`, true, true);
    this.navigate('rules');
  }

  copyVersionToProject(versionId: string): void {
    const workspace = this.state.workspace;
    const source = this.state.project;
    const version = source?.versions.find((candidate) => candidate.id === versionId);
    if (!workspace || !source || !version) return;
    const project: RuleProject = {
      id: makeId('project'), title: uniqueTitle(`${source.title} · ${version.name}副本`, workspace.projects.map((item) => item.title)),
      fields: cloneData(version.fields), rules: cloneData(version.rules), sampleInputs: cloneData(version.sampleInputs),
      versions: [], updatedAt: Date.now(),
    };
    const next = { ...workspace, projects: [...workspace.projects, project], activeProjectId: project.id };
    const issues = ruleDomain.validateProject(project);
    this.publish({ ...this.activateProject(next, project, { activeModule: 'rules' }), phase: issues.length ? 'validating' : 'editing', checkStatus: issues.length ? 'idle' : 'scheduled', notice: `已复制版本到项目“${project.title}”` });
    this.scheduleSave(next, { dirtyProjectId: project.id });
    if (!issues.length) this.scheduleCheck(80);
  }

  private async initialize(): Promise<void> {
    this.publish({ ...this.state, phase: 'loading', notice: '正在恢复本地规则项目…' });
    try {
      const saved = await this.repository.load();
      const workspace = saved ?? createDemoWorkspace();
      const project = workspace.projects.find((candidate) => candidate.id === workspace.activeProjectId) ?? workspace.projects[0];
      const issues = ruleDomain.validateProject(project);
      this.publish({
        ...this.activateProject(workspace, project),
        phase: issues.length ? 'validating' : 'editing',
        persistence: saved ? 'saved' : 'saving',
        checkStatus: issues.length ? 'idle' : 'scheduled',
        notice: saved ? '已从本地恢复最近项目' : '已载入演示项目，可直接修改并检查规则',
      });
      if (saved) this.scheduleCheck(40);
      else {
        this.scheduleSave(workspace);
        if (!issues.length) this.scheduleCheck(40);
      }
    } catch (error) {
      this.publish({ ...this.state, phase: 'error', notice: error instanceof Error ? error.message : '项目初始化失败' });
    }
  }

  private replaceProject(project: RuleProject, notice: string, recheck: boolean, allowFrozen = false): void {
    const workspace = this.state.workspace;
    if (!workspace) return;
    if (this.state.project?.frozenVersionId && !allowFrozen) {
      this.updateView({ notice: '当前版本已冻结。请先从版本记录中复制一份继续编辑。' });
      return;
    }
    const updated = { ...project, updatedAt: Date.now() };
    const next = { ...workspace, projects: workspace.projects.map((candidate) => candidate.id === updated.id ? updated : candidate) };
    const issues = ruleDomain.validateProject(updated);
    this.publish({
      ...this.state, workspace: next, project: updated,
      phase: issues.length ? 'validating' : 'editing', validationIssues: issues,
      checkStatus: issues.length ? 'idle' : recheck ? 'scheduled' : this.state.checkStatus,
      analysis: recheck ? null : this.state.analysis,
      sampleEvaluation: evaluateSample(updated, updated.sampleInputs),
      selectedRuleId: updated.rules.some((rule) => rule.id === this.state.selectedRuleId) ? this.state.selectedRuleId : updated.rules[0]?.id,
      notice,
    });
    this.scheduleSave(next, { dirtyProjectId: updated.id });
    if (recheck && !issues.length) this.scheduleCheck(180);
    else if (issues.length) this.cancelPendingCheck();
  }

  private scheduleCheck(delay: number): void {
    this.cancelPendingCheck();
    this.updateView({ checkStatus: 'scheduled' });
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      void this.runCheck();
    }, delay);
  }

  private cancelPendingCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    if (this.checkOperation) {
      this.checkRevision += 1;
      this.checkOperation.cancel();
      this.checkOperation = undefined;
    }
  }

  private scheduleSave(workspace: WorkspaceDocument, options: { dirtyProjectId?: string } = {}): void {
    const revision = ++this.saveRevision;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    let dirtyProjectIds = this.state.dirtyProjectIds;
    if (options.dirtyProjectId) dirtyProjectIds = this.withDirty(dirtyProjectIds, options.dirtyProjectId, true);
    // A document write always reflects the latest set; ids for removed projects must not linger.
    dirtyProjectIds = dirtyProjectIds.filter((id) => workspace.projects.some((project) => project.id === id));
    this.publish({ ...this.state, persistence: 'saving', saveError: undefined, dirtyProjectIds });
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.enqueueSave(workspace, revision, dirtyProjectIds);
    }, 220);
  }

  private enqueueSave(workspace: WorkspaceDocument, revision: number, pendingDirtyIds: string[]): void {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => this.repository.save(workspace)).then(() => {
      if (revision !== this.saveRevision) return;
      this.publish({ ...this.state, persistence: 'saved', saveError: undefined, dirtyProjectIds: [] });
    }).catch((error: unknown) => {
      if (revision !== this.saveRevision) return;
      // Keep showing the projects whose edits failed to land so they can be confirmed/deleted safely.
      this.publish({ ...this.state, persistence: 'error', saveError: error instanceof Error ? error.message : '保存失败', dirtyProjectIds: pendingDirtyIds });
    });
  }

  /**
   * Build the transient view state for entering a project. Everything derived
   * from project content is rebuilt here so stale analysis, selected rule or
   * sample evaluation from another project can never carry over.
   */
  private activateProject(
    workspace: WorkspaceDocument,
    project: RuleProject,
    overrides: Partial<WorkspaceState> = {},
  ): WorkspaceState {
    const issues = ruleDomain.validateProject(project);
    return {
      ...this.state,
      workspace,
      project,
      activeModule: overrides.activeModule ?? 'inspection',
      phase: overrides.phase ?? (issues.length ? 'validating' : 'editing'),
      checkStatus: overrides.checkStatus ?? (issues.length ? 'idle' : 'scheduled'),
      analysis: null,
      validationIssues: issues,
      sampleEvaluation: evaluateSample(project, project.sampleInputs),
      selectedRuleId: project.rules[0]?.id,
      notice: overrides.notice ?? '',
      saveError: undefined,
      ...overrides,
    };
  }

  private deleteProject(targetId: string): void {
    const workspace = this.state.workspace;
    if (!workspace || !workspace.projects.some((candidate) => candidate.id === targetId)) return;
    const target = workspace.projects.find((candidate) => candidate.id === targetId);
    const wasActive = workspace.activeProjectId === targetId;
    // Discard pending saves and computations that belonged to the removed project.
    // cancelPendingCheck() does not publish, so it can't leak a notice/result here.
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (wasActive) this.cancelPendingCheck();
    const remaining = workspace.projects.filter((candidate) => candidate.id !== targetId);
    const fallback = remaining[0];
    const next: WorkspaceDocument = { ...workspace, projects: remaining, activeProjectId: wasActive ? fallback.id : workspace.activeProjectId };
    const landing = remaining.find((candidate) => candidate.id === next.activeProjectId) ?? fallback;
    const dirtyProjectIds = this.withDirty(this.state.dirtyProjectIds, targetId, false);
    if (wasActive && landing) {
      const issues = ruleDomain.validateProject(landing);
      this.publish({
        ...this.activateProject(next, landing),
        phase: issues.length ? 'validating' : 'editing',
        checkStatus: issues.length ? 'idle' : 'scheduled',
        dirtyProjectIds,
        notice: `已删除“${target?.title ?? '项目'}”，已切换到“${landing.title}”`,
      });
      this.scheduleSave(next);
      if (!issues.length) this.scheduleCheck(80);
    } else {
      this.publish({ ...this.state, workspace: next, dirtyProjectIds, notice: `已删除项目“${target?.title ?? ''}”` });
      this.scheduleSave(next);
    }
  }

  private isDirty(projectId: string): boolean {
    return this.state.dirtyProjectIds.includes(projectId);
  }

  private withDirty(ids: string[], projectId: string, dirty: boolean): string[] {
    const present = ids.includes(projectId);
    if (dirty) return present ? ids : [...ids, projectId];
    return present ? ids.filter((id) => id !== projectId) : ids;
  }

  private publish(state: WorkspaceState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

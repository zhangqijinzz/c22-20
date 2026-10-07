import { evaluateSample } from '../domain/conditionEvaluator';
import { ruleDomain } from '../domain/ruleDomain';
import type {
  ModuleId,
  RuleAnalysis,
  RuleProject,
  SampleEvaluation,
  WorkspaceDocument,
} from '../models/ruleModel';
import { cloneData, createBlankProject, createDemoWorkspace, createVersionSnapshot, makeId } from '../models/projectFactory';
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
}

type Listener = () => void;
type WorkspaceRepository = Pick<RuleRepository, 'load' | 'save'>;
type Checker = Pick<RuleCheckService, 'run'>;

export class RuleWorkspaceViewModel implements WorkspacePort {
  private state: WorkspaceState = {
    phase: 'loading', persistence: 'idle', workspace: null, project: null,
    activeModule: 'inspection', checkStatus: 'idle', analysis: null,
    validationIssues: [], sampleEvaluation: null, notice: '正在恢复本地规则项目…',
  };
  private readonly listeners = new Set<Listener>();
  private startPromise?: Promise<void>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private checkTimer?: ReturnType<typeof setTimeout>;
  private checkOperation?: CheckOperation;
  private checkRevision = 0;
  private saveRevision = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly dirtyProjectIds = new Set<string>();

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
      this.enqueueSave(this.state.workspace, this.saveRevision);
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
    if (project) this.commitProject({ ...project, title }, '项目名称已更新', { recheck: false });
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
    this.cancelCheck();
    const project = createBlankProject(workspace.projects.length + 1);
    const next: WorkspaceDocument = { ...workspace, projects: [...workspace.projects, project], activeProjectId: project.id };
    this.dirtyProjectIds.add(project.id);
    this.publish({ ...this.state, workspace: next, project, phase: 'validating', activeModule: 'fields', analysis: null, checkStatus: 'idle', validationIssues: ruleDomain.validateProject(project), sampleEvaluation: evaluateSample(project, project.sampleInputs), selectedRuleId: undefined, notice: '空项目已创建。先定义字段，再添加规则。' });
    this.scheduleSave(next);
  }

  switchProject(projectId: string): void {
    const workspace = this.state.workspace;
    const project = workspace?.projects.find((candidate) => candidate.id === projectId);
    if (!workspace || !project || workspace.activeProjectId === projectId) return;
    const next = { ...workspace, activeProjectId: projectId };
    this.activateProject(next, project, 'inspection', `已切换到“${project.title}”`);
  }

  hasUnsavedChanges(projectId: string): boolean {
    return this.dirtyProjectIds.has(projectId);
  }

  duplicateProject(projectId: string): void {
    const workspace = this.state.workspace;
    const source = workspace?.projects.find((candidate) => candidate.id === projectId);
    if (!workspace || !source) return;
    const project: RuleProject = {
      id: makeId('project'), title: this.nextCopyTitle(source.title),
      fields: cloneData(source.fields), rules: cloneData(source.rules), sampleInputs: cloneData(source.sampleInputs),
      versions: source.versions.map((version) => ({ ...cloneData(version), id: makeId('version') })),
      updatedAt: Date.now(),
    };
    const next: WorkspaceDocument = { ...workspace, projects: [...workspace.projects, project], activeProjectId: project.id };
    this.dirtyProjectIds.add(project.id);
    this.activateProject(next, project, 'rules', `已复制“${source.title}”为“${project.title}”：字段、规则、样例输入与 ${source.versions.length} 条版本记录均已带入副本`);
  }

  deleteProject(projectId: string, options: { force?: boolean } = {}): boolean {
    const workspace = this.state.workspace;
    const targetIndex = workspace?.projects.findIndex((candidate) => candidate.id === projectId) ?? -1;
    const target = targetIndex >= 0 ? workspace?.projects[targetIndex] : undefined;
    if (!workspace || !target) return false;
    if (workspace.projects.length <= 1) {
      this.updateView({ notice: '至少保留一个规则项目，无法删除。' });
      return false;
    }
    if (this.hasUnsavedChanges(projectId) && !options.force) {
      this.updateView({ notice: `项目“${target.title}”还有未保存的更改，请确认后再删除。` });
      return false;
    }
    const projects = workspace.projects.filter((candidate) => candidate.id !== projectId);
    this.dirtyProjectIds.delete(projectId);
    if (workspace.activeProjectId !== projectId) {
      const next: WorkspaceDocument = { ...workspace, projects };
      this.publish({ ...this.state, workspace: next, notice: `已删除项目“${target.title}”` });
      this.scheduleSave(next);
      return true;
    }
    const project = projects[Math.min(targetIndex, projects.length - 1)];
    const next: WorkspaceDocument = { ...workspace, projects, activeProjectId: project.id };
    this.activateProject(next, project, 'inspection', `已删除项目“${target.title}”，已切换到“${project.title}”`);
    return true;
  }

  renameProjectById(projectId: string, title: string): boolean {
    const workspace = this.state.workspace;
    const target = workspace?.projects.find((candidate) => candidate.id === projectId);
    const nextTitle = title.trim();
    if (!workspace || !target) return false;
    if (!nextTitle) {
      this.updateView({ notice: '项目名称不能为空。' });
      return false;
    }
    if (target.title === nextTitle) return true;
    const renamed: RuleProject = { ...target, title: nextTitle, updatedAt: Date.now() };
    const next: WorkspaceDocument = { ...workspace, projects: workspace.projects.map((candidate) => candidate.id === projectId ? renamed : candidate) };
    this.dirtyProjectIds.add(projectId);
    this.publish({ ...this.state, workspace: next, project: this.state.project?.id === projectId ? renamed : this.state.project, notice: `项目已重命名为“${nextTitle}”` });
    this.scheduleSave(next);
    return true;
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
      id: makeId('project'), title: `${source.title} · ${version.name}副本`,
      fields: cloneData(version.fields), rules: cloneData(version.rules), sampleInputs: cloneData(version.sampleInputs),
      versions: [], updatedAt: Date.now(),
    };
    const next = { ...workspace, projects: [...workspace.projects, project], activeProjectId: project.id };
    this.dirtyProjectIds.add(project.id);
    this.activateProject(next, project, 'rules', `已复制版本到项目“${project.title}”`);
  }

  private async initialize(): Promise<void> {
    this.publish({ ...this.state, phase: 'loading', notice: '正在恢复本地规则项目…' });
    try {
      const saved = await this.repository.load();
      const workspace = saved ?? createDemoWorkspace();
      const project = workspace.projects.find((candidate) => candidate.id === workspace.activeProjectId) ?? workspace.projects[0];
      if (!saved) this.dirtyProjectIds.add(project.id);
      const issues = ruleDomain.validateProject(project);
      this.publish({ ...this.state, workspace, project, phase: issues.length ? 'validating' : 'editing', persistence: saved ? 'saved' : 'saving', activeModule: 'inspection', checkStatus: issues.length ? 'idle' : 'scheduled', validationIssues: issues, analysis: null, sampleEvaluation: evaluateSample(project, project.sampleInputs), selectedRuleId: project.rules[0]?.id, notice: saved ? '已从本地恢复最近项目' : '已载入演示项目，可直接修改并检查规则' });
      if (saved) this.scheduleCheck(40);
      else {
        this.scheduleSave(workspace);
        if (!issues.length) this.scheduleCheck(40);
      }
    } catch (error) {
      this.publish({ ...this.state, phase: 'error', notice: error instanceof Error ? error.message : '项目初始化失败' });
    }
  }

  private activateProject(next: WorkspaceDocument, project: RuleProject, module: ModuleId, notice: string): void {
    this.cancelCheck();
    const issues = ruleDomain.validateProject(project);
    this.publish({ ...this.state, workspace: next, project, phase: issues.length ? 'validating' : 'editing', activeModule: module, checkStatus: issues.length ? 'idle' : 'scheduled', analysis: null, validationIssues: issues, sampleEvaluation: evaluateSample(project, project.sampleInputs), selectedRuleId: project.rules[0]?.id, notice });
    this.scheduleSave(next);
    if (!issues.length) this.scheduleCheck(80);
  }

  private nextCopyTitle(sourceTitle: string): string {
    const titles = new Set((this.state.workspace?.projects ?? []).map((project) => project.title));
    const base = `${sourceTitle} 副本`;
    if (!titles.has(base)) return base;
    let index = 2;
    while (titles.has(`${base} ${index}`)) index += 1;
    return `${base} ${index}`;
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
    this.dirtyProjectIds.add(updated.id);
    this.publish({
      ...this.state, workspace: next, project: updated,
      phase: issues.length ? 'validating' : 'editing', validationIssues: issues,
      checkStatus: issues.length ? 'idle' : recheck ? 'scheduled' : this.state.checkStatus,
      analysis: recheck ? null : this.state.analysis,
      sampleEvaluation: evaluateSample(updated, updated.sampleInputs),
      selectedRuleId: updated.rules.some((rule) => rule.id === this.state.selectedRuleId) ? this.state.selectedRuleId : updated.rules[0]?.id,
      notice,
    });
    this.scheduleSave(next);
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

  private scheduleSave(workspace: WorkspaceDocument): void {
    const revision = ++this.saveRevision;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.publish({ ...this.state, persistence: 'saving', saveError: undefined });
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.enqueueSave(workspace, revision);
    }, 220);
  }

  private enqueueSave(workspace: WorkspaceDocument, revision: number): void {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => this.repository.save(workspace)).then(() => {
      if (revision === this.saveRevision) {
        this.dirtyProjectIds.clear();
        this.publish({ ...this.state, persistence: 'saved', saveError: undefined });
      }
    }).catch((error: unknown) => {
      if (revision === this.saveRevision) this.publish({ ...this.state, persistence: 'error', saveError: error instanceof Error ? error.message : '保存失败' });
    });
  }

  private publish(state: WorkspaceState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

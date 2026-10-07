import { useState } from 'react';
import type { RuleProject } from '../../models/ruleModel';
import type { RuleWorkspaceViewModel, WorkspaceState } from '../../viewmodels/workspaceViewModel';

interface ProjectSwitcherProps {
  state: WorkspaceState;
  workspace: RuleWorkspaceViewModel;
}

export function ProjectSwitcher({ state, workspace }: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const projects = state.workspace?.projects ?? [];
  const activeId = state.workspace?.activeProjectId ?? '';
  const current = projects.find((project) => project.id === activeId);

  const close = () => {
    setOpen(false);
    setRenamingId(null);
    setConfirmDeleteId(null);
  };

  const switchTo = (projectId: string) => {
    if (projectId !== activeId) workspace.switchProject(projectId);
    close();
  };

  const duplicate = (projectId: string) => {
    workspace.duplicateProject(projectId);
    close();
  };

  const requestDelete = (project: RuleProject) => {
    setRenamingId(null);
    if (workspace.hasUnsavedChanges(project.id)) setConfirmDeleteId(project.id);
    else workspace.deleteProject(project.id);
  };

  const confirmDelete = (projectId: string) => {
    workspace.deleteProject(projectId, { force: true });
    setConfirmDeleteId(null);
  };

  const startRename = (project: RuleProject) => {
    setConfirmDeleteId(null);
    setDraftTitle(project.title);
    setRenamingId(project.id);
  };

  const commitRename = () => {
    if (renamingId && workspace.renameProjectById(renamingId, draftTitle)) setRenamingId(null);
  };

  return (
    <div className="project-switcher" onKeyDown={(event) => { if (event.key === 'Escape') close(); }}>
      <span className="eyebrow">当前项目</span>
      <button className="project-toggle" aria-expanded={open} aria-controls="project-menu" disabled={!state.workspace} onClick={() => (open ? close() : setOpen(true))}>
        <span className="project-toggle-title">{current?.title ?? '未选择项目'}</span>
        <span className="project-toggle-caret">⌄</span>
      </button>
      <span className="project-status"><i />本地工作区</span>
      {open && state.workspace && <>
        <div className="project-menu-backdrop" onClick={close} />
        <div className="project-menu" id="project-menu" role="dialog" aria-label="项目整理">
          <div className="project-menu-heading"><span>项目列表</span><small>{projects.length} 个项目</small></div>
          <ul className="project-menu-list">
            {projects.map((project) => {
              const dirty = workspace.hasUnsavedChanges(project.id);
              return <li key={project.id} className={`project-row${project.id === activeId ? ' project-row-active' : ''}`}>
                {renamingId === project.id ? (
                  <div className="project-rename-row">
                    <input
                      aria-label="重命名项目"
                      value={draftTitle}
                      autoFocus
                      onChange={(event) => setDraftTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename();
                        if (event.key === 'Escape') { event.stopPropagation(); setRenamingId(null); }
                      }}
                    />
                    <button aria-label="确认重命名" title="确认" onClick={commitRename}>✓</button>
                    <button aria-label="取消重命名" title="取消" onClick={() => setRenamingId(null)}>✕</button>
                  </div>
                ) : confirmDeleteId === project.id ? (
                  <div className="project-confirm-row">
                    <span>“{project.title}”还有未保存的更改，删除后不可恢复。</span>
                    <div>
                      <button className="project-confirm-delete" onClick={() => confirmDelete(project.id)}>确认删除</button>
                      <button className="project-confirm-cancel" onClick={() => setConfirmDeleteId(null)}>取消</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button className="project-row-main" onClick={() => switchTo(project.id)}>
                      <strong>{project.title}{project.id === activeId && <em>当前</em>}</strong>
                      <small>{dirty && <i className="unsaved-dot" />}{project.rules.length} 条规则 · {project.versions.length} 个版本{dirty ? ' · 未保存' : ''}</small>
                    </button>
                    <div className="project-row-actions">
                      <button aria-label={`重命名 ${project.title}`} title="重命名" onClick={() => startRename(project)}>✎</button>
                      <button aria-label={`复制 ${project.title}`} title="复制副本" onClick={() => duplicate(project.id)}>⧉</button>
                      <button aria-label={`删除 ${project.title}`} title={projects.length <= 1 ? '至少保留一个项目' : '删除项目'} className="project-action-danger" disabled={projects.length <= 1} onClick={() => requestDelete(project)}>✕</button>
                    </div>
                  </>
                )}
              </li>;
            })}
          </ul>
          <button className="project-menu-new" onClick={() => { workspace.createProject(); close(); }}><span>＋</span> 新建规则项目</button>
        </div>
      </>}
    </div>
  );
}

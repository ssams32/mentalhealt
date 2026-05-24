import React from 'react';
import { Project, Task } from '../types';

interface TaskDashboardProps {
    project: Project;
}

const TaskDashboard: React.FC<TaskDashboardProps> = ({ project }) => {
    // In a real app, this would query the independent Task DB.
    // Here we use the project's embedded tasks.
    const tasks = project.tasks || [];

    return (
        <div className="h-full overflow-y-auto p-6 space-y-6">
            <div className="flex items-center justify-between">
                <h3 className="text-lg font-black text-slate-800">Project Tasks</h3>
                <span className="px-3 py-1 bg-slate-100 rounded-full text-xs font-bold text-slate-500">
                    {tasks.filter(t => t.status === 'done').length} / {tasks.length} Done
                </span>
            </div>

            <div className="space-y-3">
                {tasks.length === 0 ? (
                    <div className="text-center py-10 text-slate-400">
                        <i className="fas fa-check-circle text-4xl mb-3 opacity-20"></i>
                        <p className="text-sm font-bold">No tasks yet.</p>
                        <p className="text-xs">Type <code>[]</code> in the editor to create one.</p>
                    </div>
                ) : (
                    tasks.map(task => (
                        <div key={task.id} className="flex items-start gap-3 p-4 bg-white border border-slate-100 rounded-xl shadow-sm hover:shadow-md transition group">
                            <div className="mt-0.5">
                                <input
                                    type="checkbox"
                                    checked={task.status === 'done'}
                                    readOnly
                                    className="w-5 h-5 rounded-md border-slate-300 text-blue-600 focus:ring-blue-500/20"
                                />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className={`text-sm font-medium ${task.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                                    {task.content}
                                </p>
                                <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
                                    <span className="flex items-center gap-1">
                                        <i className="far fa-clock"></i> {task.dueDate || 'No due date'}
                                    </span>
                                    {task.assigneeId && (
                                        <span className="flex items-center gap-1">
                                            <i className="far fa-user"></i> {task.assigneeId}
                                        </span>
                                    )}
                                </div>
                            </div>
                            <button className="opacity-0 group-hover:opacity-100 p-2 text-slate-400 hover:text-blue-500 transition">
                                <i className="fas fa-chevron-right"></i>
                            </button>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};

export default TaskDashboard;

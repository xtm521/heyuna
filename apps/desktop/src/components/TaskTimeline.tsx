import { Circle, Check, X, ChevronRight, Terminal } from 'lucide-react';
import { taskLabel, type Task } from '../api';
export type LogStep = { title: string; detail: string; outcome: 'issued' | 'passed' | 'failed' | 'plain' };
export function describeEvent(event: Task['events'][number]): LogStep {
  if (event.kind === 'tool') {
    const [tool, ...rest] = event.message.split(' ');
    const names: Record<string, string> = { list_files: '已发起目录读取', read_file: '已发起文件读取', write_file: '已发起副本修改', run_test: '已发起隔离测试', run_tests: '已发起隔离测试', finish: '已发起任务收尾' };
    return { title: names[tool] ?? '已发起工具请求', detail: rest.join(' ') || event.message, outcome: 'issued' };
  }
  if (event.kind === 'test') {
    try {
      const value: unknown = JSON.parse(event.message);
      if (value && typeof value === 'object' && 'exit_code' in value && 'output' in value && typeof value.exit_code === 'number' && typeof value.output === 'string') {
        return { title: value.exit_code === 0 ? '测试进程正常结束' : `测试进程退出 · ${value.exit_code}`, detail: value.output, outcome: value.exit_code === 0 ? 'passed' : 'failed' };
      }
    } catch { /* Preserve unknown data as plain text. */ }
    return { title: '测试输出', detail: event.message, outcome: 'plain' };
  }
  if (event.kind === 'state') return { title: taskLabel(event.message), detail: event.message, outcome: 'plain' };
  return { title: '任务记录', detail: event.message, outcome: 'plain' };
}
export default function TaskTimeline({ events }: { events: Task['events'] }) {
  return <div className="task-timeline">{events.map((event, index) => { const step = describeEvent(event); const Icon = step.outcome === 'passed' ? Check : step.outcome === 'failed' ? X : step.outcome === 'issued' ? Circle : Terminal; return <details className={`log-step ${step.outcome}`} key={`${index}-${event.time}`}><summary><Icon size={14}/><span>{step.title}</span><ChevronRight size={13}/></summary><pre>{step.detail || '无输出'}</pre>{step.outcome === 'issued' && <small>此记录表示请求已发起，执行结果以后续记录为准。</small>}</details>; })}</div>;
}

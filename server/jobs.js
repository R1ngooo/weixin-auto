import { uid } from './util.js';

/** 通用后台任务（进度可通过 REST 轮询） */
export function createJobRunner() {
  const jobs = new Map();
  const MAX = 60;

  function cleanup() {
    const finished = [...jobs.values()].filter((job) => job.status !== 'running');
    if (finished.length <= MAX) return;
    finished
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, finished.length - MAX)
      .forEach((job) => jobs.delete(job.id));
  }

  function start(name, worker, meta = {}) {
    const id = uid('job_');
    const job = {
      id,
      name,
      status: 'running',
      progress: 0,
      total: 0,
      message: '准备中…',
      result: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      cancelRequested: false,
    };
    jobs.set(id, job);
    const controller = new AbortController();

    const update = (patch) => Object.assign(job, typeof patch === 'function' ? patch(job) : patch);

    Promise.resolve()
      .then(() => worker({
        signal: controller.signal,
        progress: (progress, message = '') => {
          job.progress = progress;
          if (message) job.message = message;
        },
        setTotal: (total) => { job.total = total; },
        setMessage: (message) => { job.message = message; },
        setResult: (result) => { job.result = result; },
      }))
      .then((result) => {
        if (result !== undefined) job.result = result;
        job.status = job.cancelRequested ? 'cancelled' : 'success';
        job.progress = job.cancelRequested ? job.progress : 1;
        job.message = job.cancelRequested ? '已取消' : '完成';
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          job.status = 'cancelled';
          job.message = '已取消';
        } else {
          job.status = 'failed';
          job.error = String(error?.message || error);
          job.message = job.error;
        }
      })
      .finally(() => {
        job.finishedAt = Date.now();
        cleanup();
        try {
          meta.onDone?.({ ...job });
        } catch { /* 回调失败不影响任务状态 */ }
      });

    return { id, ...meta };
  }

  function get(id) {
    const job = jobs.get(id);
    if (!job) return null;
    return { ...job };
  }

  function list() {
    return [...jobs.values()].map((job) => ({ ...job })).sort((a, b) => b.startedAt - a.startedAt);
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return false;
    job.cancelRequested = true;
    job.message = '正在取消…';
    return true;
  }

  return { start, get, list, cancel };
}

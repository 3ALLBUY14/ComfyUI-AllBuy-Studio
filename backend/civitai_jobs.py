"""Serial, cancellable metadata import with bounded in-memory job history."""
import copy
import threading
import time
import uuid
from contextvars import copy_context
from . import lora_catalog_store, lora_recommendations


class Importer:
    def __init__(self):
        self.lock = threading.Lock()
        self.thread = None
        self.jobs = {}

    def start(self, data):
        if not isinstance(data, dict): raise ValueError('批量获取参数错误')
        names = data.get('models')
        fields = data.get('fields', ['info', 'trigger', 'rating'])
        if not isinstance(names, list) or not names or len(names) > 5000 or any(not isinstance(n, str) or not n.strip() or len(n) > 1000 for n in names):
            raise ValueError('请选择 1～5000 个有效的 LoRA 模型')
        if not isinstance(fields, list) or not fields or any(f not in ('info', 'tags', 'trigger', 'rating', 'recommendation') for f in fields):
            raise ValueError('请至少选择一个导入字段')
        fields = [field for field in fields if field != 'tags']
        if not fields: raise ValueError('不再导入 C 站标签，请选择其他字段')
        fill, skip = data.get('fill_empty', True), data.get('skip_existing', True)
        if type(fill) is not bool or type(skip) is not bool: raise ValueError('批量导入选项无效')
        names = list(dict.fromkeys(n.strip().replace('\\', '/') for n in names))
        with self.lock:
            if any(j['state']['status'] in ('running', 'stopping') for j in self.jobs.values()):
                raise ValueError('已有获取任务正在运行，请先查看进度或停止任务')
            while len(self.jobs) >= 8: del self.jobs[next(iter(self.jobs))]
            identifier = uuid.uuid4().hex
            job = {'stop': threading.Event(), 'state': {'id': identifier, 'status': 'running', 'total': len(names), 'processed': 0, 'success': 0, 'failed': 0, 'skipped': 0, 'current': '', 'phase': '准备获取', 'retry_at': 0, 'bytes_done': 0, 'bytes_total': 0, 'error': '', 'results': []}}
            self.jobs[identifier] = job
        self.thread = threading.Thread(target=copy_context().run, args=(self._run, job, names, fields, fill, skip), name='allbuy-civitai', daemon=True)
        self.thread.start()
        return self.snapshot(identifier)

    def snapshot(self, identifier=''):
        if not isinstance(identifier, str): raise ValueError('任务编号格式错误')
        with self.lock:
            if not identifier:
                return copy.deepcopy(next(reversed(self.jobs.values()))['state']) if self.jobs else None
            if identifier not in self.jobs: raise ValueError('任务记录已失效，可重新获取')
            return copy.deepcopy(self.jobs[identifier]['state'])

    def cancel(self, identifier):
        if not isinstance(identifier, str): raise ValueError('任务编号格式错误')
        with self.lock:
            if identifier not in self.jobs: raise ValueError('任务记录已失效')
            job = self.jobs[identifier]
            if job['state']['status'] == 'running':
                job['stop'].set(); job['state'].update(status='stopping', phase='正在停止，等待当前读取结束')
        return self.snapshot(identifier)

    def _set(self, job, **values):
        with self.lock:
            if job['state']['status'] == 'stopping' and 'status' not in values: return
            job['state'].update(values)

    def _result(self, job, name, status, reason):
        with self.lock:
            state = job['state']; state['results'].append({'name': name, 'status': status, 'reason': reason})
            state[status] += 1; state['processed'] += 1

    def _run(self, job, names, fields, fill, skip):
        stop = job['stop']
        try:
            cached = lora_catalog_store.load_catalog().get('source_info', {})
            if not skip or any(name not in cached for name in names):
                self._set(job, phase='检测 ComfyUI 后端到 C 站的连接')
                try:
                    lora_recommendations.civitai_network.test_connection()
                except ValueError as error:
                    self._set(job, status='cancelled' if stop.is_set() else 'error', phase='已停止' if stop.is_set() else '连接检测失败，未开始读取模型', error='' if stop.is_set() else str(error))
                    return
            for index, name in enumerate(names):
                if stop.is_set(): break
                self._set(job, current=name, phase='匹配文件并读取信息', retry_at=0, bytes_done=0, bytes_total=0)
                if skip and name in lora_catalog_store.load_catalog().get('source_info', {}):
                    self._result(job, name, 'skipped', '已有来源信息'); continue
                try:
                    for attempt in range(3):
                        try:
                            self._set(job, phase='匹配文件并读取信息', retry_at=0)
                            def progress(phase, done, total):
                                self._set(job, phase=phase, bytes_done=done, bytes_total=total)
                            info = lora_recommendations.fetch_model_info(name, stop=stop, progress=progress)
                            break
                        except lora_recommendations.CivitaiError as error:
                            if error.code not in (429, 502, 503, 504, 0) or attempt == 2: raise
                            delay = min(60, max(2, error.retry_after or 3 * (attempt + 1)))
                            self._set(job, phase=f'请求受限或网络繁忙，准备第 {attempt + 1} 次重试', retry_at=time.time() + delay)
                            if stop.wait(delay): break
                    if stop.is_set(): break
                    lora_catalog_store.update_catalog({'action': 'import_source', 'model': name, 'info': info, 'fields': fields, 'fill_empty': fill})
                    reason = '已获取并保存'
                    if 'recommendation' in fields and 'min' not in info.get('recommendation', {}): reason += '；来源未提供明确推荐权重'
                    self._result(job, name, 'success', reason)
                except ValueError as error:
                    if stop.is_set(): break
                    self._result(job, name, 'failed', str(error))
                except Exception:
                    if stop.is_set(): break
                    self._result(job, name, 'failed', '读取或保存失败，请检查文件与网络后重试')
                if index < len(names) - 1 and stop.wait(.6): break
            self._set(job, status='cancelled' if stop.is_set() else 'complete', current='', retry_at=0, bytes_done=0, bytes_total=0, phase='已停止，已保存的结果保留' if stop.is_set() else '获取完成')
        except Exception:
            self._set(job, status='error', phase='任务中断，已保存的结果保留', current='', retry_at=0)


importer = Importer()

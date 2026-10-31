"""Read-only duplicate scanning, restricted to ComfyUI's installed model registry."""
import copy
import hashlib
import threading
import uuid
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from . import lora_preview_store


class DuplicateScanner:
    def __init__(self):
        self.lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="allbuy-lora-hash")
        self.jobs = {}

    def start(self, names):
        if not isinstance(names, list) or len(names) > 50000 or any(not isinstance(name, str) or not name or len(name) > 1000 for name in names):
            raise ValueError("请选择有效的 LoRA 模型列表")
        names = list(dict.fromkeys(name.strip().replace("\\", "/") for name in names))
        with self.lock:
            if any(job["state"]["status"] == "running" for job in self.jobs.values()):
                raise ValueError("已有查重任务正在运行，请先查看或取消原任务")
            while len(self.jobs) >= 8:
                del self.jobs[next(iter(self.jobs))]
            identifier = uuid.uuid4().hex
            job = {"stop": threading.Event(), "state": {"id": identifier, "status": "running", "phase": "检查文件大小", "scope": len(names), "total": 0, "processed": 0, "groups": [], "skipped": []}}
            self.jobs[identifier] = job
        self.executor.submit(self._run, job, names)
        return self.snapshot(identifier)

    def snapshot(self, identifier):
        with self.lock:
            if identifier not in self.jobs:
                raise ValueError("查重记录已失效，可重新开始检测")
            return copy.deepcopy(self.jobs[identifier]["state"])

    def cancel(self, identifier):
        with self.lock:
            if identifier not in self.jobs:
                raise ValueError("查重记录已失效")
            self.jobs[identifier]["stop"].set()
        return self.snapshot(identifier)

    def _update(self, job, **changes):
        with self.lock:
            job["state"].update(changes)

    def _hash(self, path, stop):
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                if stop.is_set():
                    return None
                digest.update(block)
        return digest.hexdigest()

    def _run(self, job, names):
        skipped = []; stop = job["stop"]
        try:
            installed = lora_preview_store.installed_models(); sizes = defaultdict(list)
            for name in names:
                if stop.is_set():
                    self._update(job, status="cancelled"); return
                path = installed.get(name)
                try:
                    if path is None:
                        raise FileNotFoundError()
                    stat = path.stat()
                    sizes[stat.st_size].append((name, path, stat))
                except OSError:
                    skipped.append({"name": name, "reason": "文件不存在或无法读取"})
            candidates = [entry for size, entries in sizes.items() if size > 0 and len(entries) > 1 for entry in entries]
            self._update(job, total=len(candidates), phase="计算 SHA256", skipped=skipped)
            hashes = defaultdict(list)
            for index, (name, path, before) in enumerate(candidates):
                if stop.is_set():
                    self._update(job, status="cancelled"); return
                try:
                    digest = self._hash(path, stop)
                    after = path.stat()
                    if stop.is_set():
                        self._update(job, status="cancelled"); return
                    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
                        skipped.append({"name": name, "reason": "扫描期间文件发生变化"})
                    elif digest:
                        hashes[(before.st_size, digest)].append(name)
                except OSError:
                    skipped.append({"name": name, "reason": "文件无法读取"})
                self._update(job, processed=index + 1, skipped=list(skipped))
            groups = [{"sha256": digest, "size": size, "models": models} for (size, digest), models in hashes.items() if len(models) > 1]
            self._update(job, status="cancelled" if stop.is_set() else "complete", phase="检测完成", groups=groups, skipped=skipped)
        except Exception:
            self._update(job, status="error", error="查重失败，请检查模型目录后重试")


scanner = DuplicateScanner()

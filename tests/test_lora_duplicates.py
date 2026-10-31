import importlib
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

pkg = types.ModuleType("vpl"); pkg.__path__ = [str(Path(__file__).resolve().parents[1])]; sys.modules.setdefault("vpl", pkg)
module = importlib.import_module("vpl.lora_duplicates")


class DuplicateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.files = {}
        for name, data in {"a": b"same", "b": b"same", "c": b"diff", "d": b"only-size-is-different"}.items():
            path = self.root / (name + ".safetensors"); path.write_bytes(data); self.files[name] = path
        self.scanner = module.DuplicateScanner()
        self.installed = patch.object(module.lora_preview_store, "installed_models", return_value=self.files); self.installed.start()

    def tearDown(self):
        self.scanner.executor.shutdown(wait=True); self.installed.stop(); self.tmp.cleanup()

    def finish(self, identifier):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            job = self.scanner.snapshot(identifier)
            if job["status"] != "running": return job
            time.sleep(.005)
        self.fail("scan did not finish")

    def test_size_prefilter_full_hash_and_registry_boundary(self):
        job = self.scanner.start(["a", "b", "c", "d", "../../outside"])
        result = self.finish(job["id"])
        self.assertEqual(result["status"], "complete"); self.assertEqual(result["total"], 3)
        self.assertEqual(result["groups"][0]["models"], ["a", "b"])
        self.assertEqual(len(result["groups"][0]["sha256"]), 64)
        self.assertEqual(result["skipped"][0]["name"], "../../outside")
        self.assertEqual(self.files["a"].read_bytes(), b"same", "Scans must never modify models")
        result["groups"].clear(); self.assertEqual(len(self.scanner.snapshot(job["id"])["groups"]), 1, "Snapshots cannot mutate shared jobs")

    def test_running_job_can_be_cancelled_and_reopened(self):
        entered, release = threading.Event(), threading.Event()
        original = self.scanner._hash
        def block(path, stop):
            entered.set(); release.wait(2); return original(path, stop)
        with patch.object(self.scanner, "_hash", side_effect=block):
            job = self.scanner.start(["a", "b"])
            try:
                self.assertTrue(entered.wait(2))
                with self.assertRaises(ValueError): self.scanner.start(["c"])
                self.scanner.cancel(job["id"])
            finally: release.set()
            self.assertEqual(self.finish(job["id"])["status"], "cancelled")
        self.assertEqual(self.finish(self.scanner.start([])["id"])["groups"], [])

    def test_changes_during_hash_are_excluded(self):
        original = self.scanner._hash
        def changed(path, stop):
            result = original(path, stop)
            if path == self.files["a"]: path.write_bytes(b"changed-size")
            return result
        with patch.object(self.scanner, "_hash", side_effect=changed):
            result = self.finish(self.scanner.start(["a", "b"])["id"])
        self.assertEqual(result["groups"], []); self.assertEqual(result["skipped"][0]["name"], "a")

    def test_invalid_requests_and_expired_records(self):
        for names in (None, "a", [None], ["a"] * 50001):
            with self.assertRaises(ValueError): self.scanner.start(names)
        with self.assertRaises(ValueError): self.scanner.snapshot("missing")

    def test_windows_registry_names_are_normalized(self):
        self.files["folder/a"] = self.files.pop("a")
        result = self.finish(self.scanner.start([r"folder\a", "b"])["id"])
        self.assertEqual(result["groups"][0]["models"], ["folder/a", "b"])

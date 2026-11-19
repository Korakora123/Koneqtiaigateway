"""Load a model on first use, unload it after a quiet period (RAM back to the other backends on VPS2)."""
from __future__ import annotations

import ctypes
import gc
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Iterator, Optional


def release_memory() -> None:
    """Drop Python references and ask glibc to hand freed pages back to the OS."""
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except OSError:  # not glibc (dev machine)
        pass


class LazyModel:
    """One model, used by one request at a time (the lock is also the CPU-budget lock).

    idle_s > 0  → unloaded after that many seconds without use
    idle_s == 0 → kept loaded once loaded
    """

    def __init__(self, loader: Callable[[], Any], idle_s: float, now: Callable[[], float] = time.monotonic):
        self._loader = loader
        self.idle_s = idle_s
        self._now = now
        self._lock = threading.Lock()
        self._model: Optional[Any] = None
        self._last_used = 0.0
        self.last_error: Optional[str] = None
        self.loads = 0

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @contextmanager
    def use(self) -> Iterator[Any]:
        with self._lock:
            if self._model is None:
                try:
                    self._model = self._loader()
                except Exception as exc:
                    self.last_error = type(exc).__name__
                    raise
                self.last_error = None
                self.loads += 1
            try:
                yield self._model
            finally:
                self._last_used = self._now()

    def unload_if_idle(self) -> bool:
        """Called by the reaper. Never waits for (or interrupts) a running request."""
        if self.idle_s <= 0 or not self._lock.acquire(blocking=False):
            return False
        try:
            if self._model is None or self._now() - self._last_used < self.idle_s:
                return False
            self._model = None
        finally:
            self._lock.release()
        release_memory()
        return True


class Reaper:
    """Background thread that calls `fn` every `interval_s` seconds until stopped."""

    def __init__(self, fn: Callable[[], Any], interval_s: float):
        self._fn = fn
        self._interval = interval_s
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="idle-reaper", daemon=True)

    def start(self) -> "Reaper":
        self._thread.start()
        return self

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self._fn()
            except Exception:  # never kill the service because of the reaper
                pass

    def stop(self) -> None:
        self._stop.set()
